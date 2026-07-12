const express = require('express');
const logger = require('../utils/logger');
const orderService = require('../services/order.service');
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
    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/status failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
