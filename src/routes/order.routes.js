const express = require('express');
const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const notification = require('../services/notification.service');
const { query } = require('../config/database');
const { normalizeGhanaPhone, detectNetwork } = require('../utils/helpers');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { csvCell } = require('../utils/csv');

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
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const orders = await orderService.listOrdersForBusiness(business_id, { status, limit });
    res.json({ success: true, orders });
  } catch (err) {
    logger.error('GET /orders failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/orders/stats/today?business_id= — merchant "how did I do today"
 * counters, computed in Africa/Accra local time.
 */
router.get('/stats/today', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
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
           WHERE business_id = $1 AND status IN ('confirmed','paid','preparing'))   AS open_orders`,
      [business_id]
    );
    const s = r.rows[0];
    s.payment_success_rate = s.payment_attempts > 0
      ? Math.round((s.paid_count / s.payment_attempts) * 100)
      : null;
    res.json({ success: true, stats: s });
  } catch (err) {
    logger.error('GET /orders/stats/today failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/orders/export?business_id=&status= — CSV download of orders.
 */
router.get('/export', async (req, res) => {
  try {
    const { business_id, status } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
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
    logger.error('GET /orders/export failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/orders
 * Body: { business_id, customer_whatsapp, customer_name?, items: [{product_id, quantity}], delivery_address, delivery_fee?, payment_method?, notes? }
 */
router.post('/', async (req, res) => {
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

    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const wa = normalizeGhanaPhone(customer_whatsapp);
    if (!wa) return res.status(400).json({ success: false, error: 'Invalid customer_whatsapp' });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, error: 'items must be a non-empty array' });
    }
    const fee = Number(delivery_fee);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ success: false, error: 'delivery_fee must be a non-negative number' });
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
        ? query(`SELECT id, name, price_ghs FROM products WHERE business_id = $1 AND id = ANY($2::uuid[])`, [business_id, ids])
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
        return res.status(400).json({ success: false, error: `Product not found: ${item.product_id}` });
      }
      const variant = item.variant_id ? variantById.get(String(item.variant_id)) : null;
      if (item.variant_id && (!variant || variant.product_id !== p.id)) {
        return res.status(400).json({ success: false, error: `Variant not found: ${item.variant_id}` });
      }
      const addons = (Array.isArray(item.addon_ids) ? item.addon_ids : [])
        .map(id => addonById.get(String(id)))
        .filter(a => a && a.product_id === p.id);
      if (Array.isArray(item.addon_ids) && addons.length !== item.addon_ids.length) {
        return res.status(400).json({ success: false, error: `One or more add-ons not found for product ${p.id}` });
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

    res.status(201).json({ success: true, order, customer });
  } catch (err) {
    logger.error('POST /orders failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/orders/:id/status — body: { status, reason? } (reason only used for 'cancelled') */
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!orderService.VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${orderService.VALID_STATUSES.join(', ')}`
      });
    }
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const order = await orderService.updateOrderStatus(req.params.id, status, { reason });

    // Keep the customer in the loop, same as the merchant chat flow does.
    if (order && order.status !== existing.status) {
      const bizRes = await query('SELECT id, name, bot_language FROM businesses WHERE id = $1', [order.business_id]);
      notification.notifyOrderStatusChange({ order, business: bizRes.rows[0] })
        .catch(err => logger.warn('order status notify failed: %s', err.message));
    }

    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/status failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/orders/:id — full order detail for the dashboard: the order row,
 * its status timeline, payment attempts, and any refunds.
 */
router.get('/:id', async (req, res) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, order.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const [history, refunds, attempts, customerRes] = await Promise.all([
      orderService.getOrderHistory(order.id),
      orderService.getOrderRefunds(order.id),
      query('SELECT reference, method, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at ASC', [order.id]),
      query('SELECT id, display_name, whatsapp_number, channel FROM customers WHERE id = $1', [order.customer_id])
    ]);
    res.json({
      success: true,
      order,
      history,
      refunds,
      payment_attempts: attempts.rows,
      customer: customerRes.rows[0] || null
    });
  } catch (err) {
    logger.error('GET /orders/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/orders/:id/notes — body: { note } — appends a merchant-only note. */
router.patch('/:id/notes', async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ success: false, error: 'note is required' });
    const order = await orderService.addOrderNote(req.params.id, note);
    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/notes failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/orders/:id/delivery — body: { rider_name, rider_phone?, delivery_status?, delivery_proof_url? } */
router.patch('/:id/delivery', async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
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
        return res.status(400).json({
          success: false,
          error: `delivery_status must be one of: ${orderService.VALID_DELIVERY_STATUSES.join(', ')}`
        });
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
    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/delivery failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/orders/:id/estimates — body: { estimated_ready_at?, estimated_delivery_at? } (ISO timestamps, or null to clear) */
router.patch('/:id/estimates', async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const body = req.body || {};
    if (body.estimated_ready_at === undefined && body.estimated_delivery_at === undefined) {
      return res.status(400).json({ success: false, error: 'estimated_ready_at or estimated_delivery_at is required' });
    }
    const order = await orderService.setEstimates(req.params.id, {
      readyAt: body.estimated_ready_at,
      deliveryAt: body.estimated_delivery_at
    });
    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/estimates failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/orders/:id/refund — body: { amount_ghs, reason? } */
router.post('/:id/refund', requirePermission('financial'), async (req, res) => {
  try {
    const existing = await orderService.getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, existing.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const amount = Number(req.body?.amount_ghs);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount_ghs must be a positive number' });
    }
    const refund = await orderService.createRefund({
      orderId: req.params.id,
      businessId: existing.business_id,
      amountGhs: amount,
      reason: req.body?.reason
    });
    res.status(201).json({ success: true, refund });
  } catch (err) {
    logger.error('POST /orders/:id/refund failed: %s', err.message);
    res.status(400).json({ success: false, error: err.message || 'Refund failed' });
  }
});

module.exports = router;
