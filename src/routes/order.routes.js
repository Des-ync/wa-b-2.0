const express = require('express');
const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const notification = require('../services/notification.service');
const { query } = require('../config/database');
const { normalizeGhanaPhone, detectNetwork, isWithinBusinessHours } = require('../utils/helpers');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { csvCell } = require('../utils/csv');
const respond = require('../utils/response');

const router = express.Router();

// Every order route requires authentication. Admin keys see anything; tenant
// keys are restricted to their own business_id (enforced inline below since
// business_id arrives in the query string or body, not as a route param).
router.use(requireAuth('any'));

/**
 * GET /api/orders?business_id=&status=&limit=
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, status, limit } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const orders = await orderService.listOrdersForBusiness(business_id, { status, limit });
    return respond.ok(req, res, { orders });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /orders', err);
  }
});

/**
 * GET /api/orders/stats/today?business_id= — merchant "how did I do today"
 * counters, computed in Africa/Accra local time.
 */
router.get('/stats/today', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const r = await query(
      `WITH today AS (
         SELECT * FROM orders
          WHERE business_id = $1
            AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Accra') AT TIME ZONE 'Africa/Accra'
       )
       SELECT
         (SELECT COUNT(*)::int FROM today)                                          AS orders_count,
         (SELECT COUNT(*)::int FROM today WHERE payment_status = 'paid')            AS paid_count,
         (SELECT COALESCE(SUM(total_ghs),0) FROM today WHERE payment_status='paid') AS gmv_ghs,
         (SELECT COUNT(*)::int FROM today WHERE payment_status = 'pending')         AS awaiting_payment,
         (SELECT COUNT(*)::int FROM today WHERE status = 'cancelled')               AS cancelled_count,
         (SELECT COUNT(*)::int FROM today WHERE payment_ref IS NOT NULL)            AS payment_attempts,
         (SELECT COUNT(*)::int FROM orders
           WHERE business_id = $1 AND status IN ('confirmed','paid','preparing'))   AS open_orders,
         (SELECT COUNT(*)::int FROM customers
           WHERE business_id = $1
             AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Accra') AT TIME ZONE 'Africa/Accra')
                                                                                     AS new_customers_count,
         -- "Needs a reply": the merchant (or a human handoff) has taken this
         -- chat off the bot, and the customer's most recent message is still
         -- sitting unanswered. Not a total unread count — most inbound
         -- messages ARE answered, by the bot, automatically.
         (SELECT COUNT(*)::int
            FROM customers c
            LEFT JOIN LATERAL (
              SELECT direction FROM message_log
               WHERE customer_id = c.id
               ORDER BY created_at DESC, id DESC LIMIT 1
            ) lm ON TRUE
           WHERE c.business_id = $1 AND c.bot_paused = TRUE AND lm.direction = 'inbound')
                                                                                     AS messages_needing_reply_count,
         -- Products at or below their OWN reorder threshold. Same rule as
         -- /api/inventory/reorder-suggestions, which backs the drill-down
         -- sheet — this is only the count, so the Today view doesn't need a
         -- second round trip on a 3G connection just to render one tile.
         (SELECT COUNT(*)::int FROM products
           WHERE business_id = $1
             AND stock_qty IS NOT NULL
             AND stock_qty <= low_stock_threshold)                                   AS low_stock_count,
         -- Payment attempts that bounced today, across all of today's orders.
         -- Counted from payment_attempts (not orders.payment_status) so an
         -- order that failed twice and then succeeded still shows both
         -- failures — the merchant is troubleshooting attempts, not orders.
         (SELECT COUNT(*)::int
            FROM payment_attempts pa
            JOIN today t ON t.id = pa.order_id
           WHERE pa.status = 'failed'
             AND COALESCE(pa.failure_reason, '') <> 'superseded')                    AS failed_payments_count`,
      [business_id]
    );
    const s = r.rows[0];
    s.payment_success_rate = s.payment_attempts > 0
      ? Math.round((s.paid_count / s.payment_attempts) * 100)
      : null;
    return respond.ok(req, res, { stats: s });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /orders/stats/today', err);
  }
});

/**
 * GET /api/orders/export?business_id=&status= — CSV download of orders.
 */
router.get('/export', async (req, res) => {
  try {
    const { business_id, status } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const params = [business_id];
    let sql =
      `SELECT o.order_number, o.created_at, c.whatsapp_number AS customer_phone,
              c.display_name AS customer_name, o.items, o.subtotal_ghs, o.delivery_fee,
              o.total_ghs, o.payment_status, o.payment_method, o.status, o.delivery_address, o.notes
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.business_id = $1`;
    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }
    sql += ' ORDER BY o.created_at DESC LIMIT 5000';
    const r = await query(sql, params);

    const header = ['order_number','created_at','customer_phone','customer_name','items',
      'subtotal_ghs','delivery_fee_ghs','total_ghs','payment_status','payment_method',
      'status','delivery_address','notes'];
    const lines = [header.join(',')];
    for (const o of r.rows) {
      const items = (Array.isArray(o.items) ? o.items : [])
        .map(i => `${i.quantity || 1}x ${i.name}`).join('; ');
      lines.push([
        o.order_number, new Date(o.created_at).toISOString(), o.customer_phone, o.customer_name,
        items, o.subtotal_ghs, o.delivery_fee, o.total_ghs, o.payment_status,
        o.payment_method, o.status, o.delivery_address, o.notes
      ].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /orders/export', err);
  }
});

/**
 * POST /api/orders
 * Body: { business_id, customer_whatsapp, customer_name?, items: [{product_id, quantity}], delivery_address, delivery_fee?, payment_method?, notes? }
 */
router.post('/', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const {
      business_id,
      customer_whatsapp,
      customer_name,
      items = [],
      delivery_address,
      delivery_fee = 0,
      payment_method,
      notes
    } = req.body || {};

    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const wa = normalizeGhanaPhone(customer_whatsapp);
    if (!wa) return respond.invalid(req, res, 'Invalid customer_whatsapp');
    if (!Array.isArray(items) || !items.length) {
      return respond.invalid(req, res, 'items must be a non-empty array', { items: 'is invalid' });
    }
    const fee = Number(delivery_fee);
    if (!Number.isFinite(fee) || fee < 0) {
      return respond.invalid(req, res, 'delivery_fee must be a non-negative number', { delivery_fee: 'is invalid' });
    }

    const customer = await orderService.getOrCreateCustomer({
      businessId: business_id,
      whatsappNumber: wa,
      displayName: customer_name,
      phoneNetwork: detectNetwork(wa)
    });

    // Resolve product (and optional variant/add-on) details for all items.
    const wanted = items.filter(i => i.product_id);
    const ids = [...new Set(wanted.map(i => String(i.product_id)))];
    const variantIds = [...new Set(wanted.map(i => i.variant_id).filter(Boolean).map(String))];
    const addonIds = [...new Set(wanted.flatMap(i => Array.isArray(i.addon_ids) ? i.addon_ids : []).filter(Boolean).map(String))];
    const [r, vr, ar] = await Promise.all([
      ids.length
        ? query(`SELECT id, name, price_ghs, in_stock, hidden, available_from, available_to FROM products WHERE business_id = $1 AND id = ANY($2::uuid[])`, [business_id, ids])
        : Promise.resolve({ rows: [] }),
      variantIds.length
        ? query(`SELECT id, product_id, name, price_delta_ghs FROM product_variants WHERE business_id = $1 AND id = ANY($2::uuid[])`, [business_id, variantIds])
        : Promise.resolve({ rows: [] }),
      addonIds.length
        ? query(`SELECT id, product_id, name, price_ghs FROM product_addons WHERE business_id = $1 AND id = ANY($2::uuid[])`, [business_id, addonIds])
        : Promise.resolve({ rows: [] })
    ]);
    const byId = new Map(r.rows.map(p => [p.id, p]));
    const variantById = new Map(vr.rows.map(v => [v.id, v]));
    const addonById = new Map(ar.rows.map(a => [a.id, a]));

    const cart = [];
    for (const item of wanted) {
      const p = byId.get(String(item.product_id));
      if (!p) {
        return respond.invalid(req, res, `Product not found: ${item.product_id}`);
      }
      // Don't let customers order items that aren't actually purchasable right
      // now — hidden from the menu, out of stock, or outside their daily
      // availability window. Otherwise the merchant just has to cancel later.
      if (p.hidden) {
        return respond.invalid(req, res, `Product not available: ${p.name}`);
      }
      if (p.in_stock === false) {
        return respond.invalid(req, res, `Out of stock: ${p.name}`);
      }
      if (!isWithinBusinessHours(p.available_from, p.available_to)) {
        return respond.invalid(req, res, `${p.name} is not available at this time`);
      }
      const variant = item.variant_id ? variantById.get(String(item.variant_id)) : null;
      if (item.variant_id && (!variant || variant.product_id !== p.id)) {
        return respond.invalid(req, res, `Variant not found: ${item.variant_id}`);
      }
      const addons = (Array.isArray(item.addon_ids) ? item.addon_ids : [])
        .map(id => addonById.get(String(id)))
        .filter(a => a && a.product_id === p.id);
      if (Array.isArray(item.addon_ids) && addons.length !== item.addon_ids.length) {
        return respond.invalid(req, res, `One or more add-ons not found for product ${p.id}`);
      }

      const addonsTotal = addons.reduce((sum, a) => sum + Number(a.price_ghs), 0);
      const unitPrice = Number(p.price_ghs) + (variant ? Number(variant.price_delta_ghs) : 0) + addonsTotal;
      const displayName = (variant ? `${p.name} (${variant.name})` : p.name)
        + (addons.length ? ` + ${addons.map(a => a.name).join(', ')}` : '');

      cart.push({
        product_id: p.id,
        name: displayName,
        price_ghs: Number(unitPrice.toFixed(2)),
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
        variant_id: variant ? variant.id : undefined,
        variant_name: variant ? variant.name : undefined,
        addon_ids: addons.length ? addons.map(a => a.id) : undefined,
        addons: addons.length ? addons.map(a => ({ id: a.id, name: a.name, price_ghs: Number(a.price_ghs) })) : undefined
      });
    }

    const order = await orderService.createOrder({
      businessId: business_id,
      customerId: customer.id,
      cart,
      deliveryAddress: delivery_address,
      deliveryFee: fee,
      paymentMethod: payment_method,
      notes
    });

    notification.notifyOrderReceived({ order, business: { id: business_id }, customer });

    return respond.ok(req, res, { order, customer }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /orders', err);
  }
});

// 'paid' is a fulfillment-status enum value at the DB level, but no route
// here may set it directly — only orderService.markOrderPaid() (via
// POST /:id/mark-paid or a gateway webhook) may, because that's the only
// path that also updates payment_status/stock/loyalty/GMV together. See the
// comment on POST /:id/mark-paid below.
const PATCHABLE_STATUSES = orderService.VALID_STATUSES.filter(s => s !== 'paid');

/** PATCH /api/orders/:id/status — body: { status, reason? } (reason only used for 'cancelled') */
router.patch('/:id/status', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!PATCHABLE_STATUSES.includes(status)) {
      return respond.invalid(req, res,
        status === 'paid'
          ? "Use POST /:id/mark-paid to record a payment — it's the only path that updates payment_status, stock, and loyalty together."
          : `status must be one of: ${PATCHABLE_STATUSES.join(', ')}`,
        { status: status === 'paid' ? 'cannot be set here' : 'is not a valid status' });
    }
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    const order = await orderService.updateOrderStatus(req.params.id, status, { reason });

    // Keep the customer in the loop, same as the merchant chat flow does.
    if (order && order.status !== existing.status) {
      const bizRes = await query('SELECT id, name, bot_language FROM businesses WHERE id = $1', [order.business_id]);
      notification.notifyOrderStatusChange({ order, business: bizRes.rows[0] })
        .catch(err => logger.warn('order status notify failed: %s', err.message));
    }

    return respond.ok(req, res, { order });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /orders/:id/status', err);
  }
});

/**
 * POST /api/orders/:id/mark-paid — record a payment the merchant collected
 * outside a gateway webhook (cash in hand, a bank transfer, etc). Routes
 * through the SAME orderService.markOrderPaid() the Paystack/MTN MoMo
 * webhook path uses, so payment_status, stock decrement, loyalty, and GMV/
 * analytics (which all gate on payment_status = 'paid') stay correct.
 * PATCH .../status only ever advances the fulfillment stage and never
 * touched payment_status — a merchant flipping an order to "confirmed" as
 * their "mark paid" action would silently undercount that sale everywhere
 * payment_status is the source of truth.
 * body: { method?: 'cash'|'momo'|'card' (default 'cash'), amount_ghs? }
 */
router.post('/:id/mark-paid', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }

    const method = ['cash', 'momo', 'card'].includes(req.body?.method) ? req.body.method : 'cash';
    let amount;
    if (req.body?.amount_ghs !== undefined) {
      amount = Number(req.body.amount_ghs);
      if (!Number.isFinite(amount) || amount <= 0) {
        return respond.invalid(req, res, 'amount_ghs must be a positive number', { amount_ghs: 'is invalid' });
      }
    }

    const result = await orderService.markOrderPaid({
      orderId: existing.id,
      paymentMethod: method,
      amount,
      changedBy: 'merchant'
    });
    if (!result) return respond.notFound(req, res, 'Order');
    if (result.refunded) {
      return respond.fail(req, res, { code: respond.CODES.CONFLICT, message: 'Order was already refunded' });
    }
    if (result.alreadyPaid) {
      return respond.ok(req, res, { order: result.order }, { meta: { alreadyPaid: true } });
    }
    if (result.mismatch) {
      return respond.fail(req, res, {
        code: respond.CODES.VALIDATION,
        message: `Amount does not match the order total (expected GH₵${result.expected}, got GH₵${result.received})`,
        fields: { amount_ghs: 'does not match the order total' },
        // Kept flat in legacy exactly where they were; see respond.fail.
        extra: { expected: result.expected, received: result.received }
      });
    }

    const order = result.order;
    const [bizRes, customerRes] = await Promise.all([
      query('SELECT * FROM businesses WHERE id = $1', [order.business_id]),
      order.customer_id
        ? query('SELECT * FROM customers WHERE id = $1', [order.customer_id])
        : Promise.resolve({ rows: [] })
    ]);
    notification.notifyOrderPaid({ order, business: bizRes.rows[0], customer: customerRes.rows[0] })
      .catch(err => logger.warn('mark-paid notify failed for order %s: %s', order.id, err.message));

    return respond.ok(req, res, { order }, { meta: { lowStock: result.lowStock || [] } });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /orders/:id/mark-paid', err);
  }
});

/**
 * POST /api/orders/:id/payment-reminder — merchant-triggered nudge: resends
 * the same retry/cancel prompt the automatic payment-failed message uses, so
 * the customer's tap is handled by the exact same, already-tested retry flow
 * — this is not a new payment path. Only valid for an order that isn't paid
 * or refunded yet, and rate-limited to one every 10 minutes per order so a
 * merchant can't spam a customer by repeat-tapping the button.
 */
router.post('/:id/payment-reminder', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    if (existing.payment_status === 'paid') {
      return respond.fail(req, res, { code: respond.CODES.CONFLICT, message: 'Order is already paid' });
    }
    if (existing.payment_status === 'refunded') {
      return respond.fail(req, res, { code: respond.CODES.CONFLICT, message: 'Order was refunded' });
    }

    const lastSentAt = await orderService.getLastPaymentReminderAt(existing.id);
    if (lastSentAt && Date.now() - new Date(lastSentAt).getTime() < 10 * 60 * 1000) {
      return respond.fail(req, res, {
        code: respond.CODES.RATE_LIMITED,
        message: 'A reminder was already sent for this order in the last 10 minutes'
      });
    }

    const [bizRes, customerRes] = await Promise.all([
      query('SELECT * FROM businesses WHERE id = $1', [existing.business_id]),
      existing.customer_id
        ? query('SELECT * FROM customers WHERE id = $1', [existing.customer_id])
        : Promise.resolve({ rows: [] })
    ]);
    const business = bizRes.rows[0];
    const customer = customerRes.rows[0];
    if (!customer) {
      return respond.invalid(req, res, 'Order has no customer to remind');
    }

    const sent = await notification.notifyPaymentReminder({ order: existing, business, customer });
    if (!sent?.success) {
      return respond.fail(req, res, { code: respond.CODES.UPSTREAM, message: sent?.error || 'Failed to send reminder' });
    }

    await orderService.recordPaymentReminderSent(existing.id);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /orders/:id/payment-reminder', err);
  }
});

/**
 * GET /api/orders/:id — full order detail for the dashboard: the order row,
 * its status timeline, payment attempts, and any refunds.
 */
router.get('/:id', async (req, res) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    if (!order) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, order.business_id)) {
      return respond.forbidden(req, res);
    }
    const [history, refunds, attempts, customerRes] = await Promise.all([
      orderService.getOrderHistory(order.id),
      orderService.getOrderRefunds(order.id),
      query(
        `SELECT reference, method, created_at, status, failure_reason, failure_code, resolved_at
           FROM payment_attempts WHERE order_id = $1 ORDER BY created_at ASC`,
        [order.id]
      ),
      query('SELECT id, display_name, whatsapp_number, channel FROM customers WHERE id = $1', [order.customer_id])
    ]);
    return respond.ok(req, res, {
      order,
      history,
      refunds,
      payment_attempts: attempts.rows,
      customer: customerRes.rows[0] || null
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /orders/:id', err);
  }
});

/** PATCH /api/orders/:id/notes — body: { note } — appends a merchant-only note. */
router.patch('/:id/notes', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    const note = String(req.body?.note || '').trim();
    if (!note) return respond.invalid(req, res, 'note is required', { note: 'is invalid' });
    const order = await orderService.addOrderNote(req.params.id, note);
    return respond.ok(req, res, { order });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /orders/:id/notes', err);
  }
});

/** PATCH /api/orders/:id/delivery — body: { rider_name, rider_phone?, delivery_status?, delivery_proof_url? } */
router.patch('/:id/delivery', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    const body = req.body || {};
    let order = existing;
    let bizForNotify = null;
    if (body.rider_name !== undefined) {
      order = await orderService.assignDelivery(req.params.id, { riderName: body.rider_name, riderPhone: body.rider_phone });
      if (order && body.rider_phone) {
        const bizRes = await query('SELECT id, name FROM businesses WHERE id = $1', [order.business_id]);
        bizForNotify = bizRes.rows[0];
        notification.notifyRiderAssigned({ order, business: bizForNotify, riderPhone: body.rider_phone })
          .catch(err => logger.warn('rider assigned notify failed: %s', err.message));
      }
    }
    if (body.delivery_status !== undefined) {
      if (!orderService.VALID_DELIVERY_STATUSES.includes(body.delivery_status)) {
        return respond.invalid(req, res,
          `delivery_status must be one of: ${orderService.VALID_DELIVERY_STATUSES.join(', ')}`,
          { delivery_status: 'is not a valid delivery status' });
      }
      order = await orderService.updateDeliveryStatus(req.params.id, body.delivery_status, { proofUrl: body.delivery_proof_url });
      // Only notify the customer when marked delivered WITH a proof photo —
      // the general "your order is delivered" message already goes out via
      // notifyOrderStatusChange when the order's own status column advances;
      // this is additive (the photo), not a duplicate of that.
      if (order && body.delivery_status === 'delivered' && body.delivery_proof_url) {
        if (!bizForNotify) {
          const bizRes = await query('SELECT id, name, bot_language FROM businesses WHERE id = $1', [order.business_id]);
          bizForNotify = bizRes.rows[0];
        }
        notification.notifyDeliveryCompleted({ order, business: bizForNotify })
          .catch(err => logger.warn('delivery completed notify failed: %s', err.message));
      }
    }
    return respond.ok(req, res, { order });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /orders/:id/delivery', err);
  }
});

/** PATCH /api/orders/:id/estimates — body: { estimated_ready_at?, estimated_delivery_at? } (ISO timestamps, or null to clear) */
router.patch('/:id/estimates', requirePermission('orders', 'write'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    const body = req.body || {};
    if (body.estimated_ready_at === undefined && body.estimated_delivery_at === undefined) {
      return respond.invalid(req, res, 'estimated_ready_at or estimated_delivery_at is required', { estimated_ready_at: 'is invalid' });
    }
    const order = await orderService.setEstimates(req.params.id, {
      readyAt: body.estimated_ready_at,
      deliveryAt: body.estimated_delivery_at
    });
    return respond.ok(req, res, { order });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /orders/:id/estimates', err);
  }
});

/** POST /api/orders/:id/refund — body: { amount_ghs, reason? } */
router.post('/:id/refund', requirePermission('financial'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return respond.notFound(req, res, 'Order');
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return respond.forbidden(req, res);
    }
    const amount = Number(req.body?.amount_ghs);
    if (!Number.isFinite(amount) || amount <= 0) {
      return respond.invalid(req, res, 'amount_ghs must be a positive number', { amount_ghs: 'is invalid' });
    }
    const refund = await orderService.createRefund({
      orderId: req.params.id,
      businessId: existing.business_id,
      amountGhs: amount,
      reason: req.body?.reason
    });
    return respond.ok(req, res, { refund }, { status: 201 });
  } catch (err) {
    logger.error('POST /orders/:id/refund failed: %s', err.message);
    return respond.invalid(req, res, err.message || 'Refund failed');
  }
});

module.exports = router;
