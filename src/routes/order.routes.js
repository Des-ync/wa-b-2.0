const express = require('express');
const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const notification = require('../services/notification.service');
const { query } = require('../config/database');
const { normalizeGhanaPhone, detectNetwork } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every order route requires authentication. Admin keys see anything; tenant
// keys are restricted to their own business_id (enforced inline below since
// business_id arrives in the query string or body, not as a route param).
router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

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

    const csvCell = v => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
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

/** GET /api/orders/:id */
router.get('/:id', async (req, res) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (tenantBlocksBusinessId(req, order.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    res.json({ success: true, order });
  } catch (err) {
    logger.error('GET /orders/:id failed: %s', err.message);
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

    // Resolve product details for each item.
    const cart = [];
    for (const item of items) {
      if (!item.product_id) continue;
      const r = await query(
        `SELECT id, name, price_ghs FROM products WHERE id = $1 AND business_id = $2`,
        [item.product_id, business_id]
      );
      const p = r.rows[0];
      if (!p) {
        return res.status(400).json({
          success: false,
          error: `Product not found: ${item.product_id}`
        });
      }
      cart.push({
        product_id: p.id,
        name: p.name,
        price_ghs: Number(p.price_ghs),
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
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

    res.status(201).json({ success: true, order, customer });
  } catch (err) {
    logger.error('POST /orders failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/orders/:id/status — body: { status } */
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body || {};
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
    const order = await orderService.updateOrderStatus(req.params.id, status);

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

module.exports = router;
