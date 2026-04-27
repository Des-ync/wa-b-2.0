const express = require('express');
const logger = require('../utils/logger');
const orderService = require('../services/order.service');
const { query } = require('../config/database');
const { normalizeGhanaPhone, detectNetwork } = require('../utils/helpers');

const router = express.Router();

/**
 * GET /api/orders?business_id=&status=&limit=
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, status, limit } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    const orders = await orderService.listOrdersForBusiness(business_id, { status, limit });
    res.json({ success: true, orders });
  } catch (err) {
    logger.error('GET /orders failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/orders/:id */
router.get('/:id', async (req, res) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    logger.error('GET /orders/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
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
    const wa = normalizeGhanaPhone(customer_whatsapp);
    if (!wa) return res.status(400).json({ success: false, error: 'Invalid customer_whatsapp' });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, error: 'items must be a non-empty array' });
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
      deliveryFee: Number(delivery_fee) || 0,
      paymentMethod: payment_method,
      notes
    });

    res.status(201).json({ success: true, order, customer });
  } catch (err) {
    logger.error('POST /orders failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
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
    const order = await orderService.updateOrderStatus(req.params.id, status);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    logger.error('PATCH /orders/:id/status failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
