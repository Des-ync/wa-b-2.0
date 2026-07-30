const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/search?business_id=&q= — global dashboard search across orders,
 * customers, and products in one round trip (powers the Cmd/Ctrl+K palette).
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, q } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const term = String(q || '').trim();
    if (term.length < 2) {
      return respond.ok(req, res, { orders: [], customers: [], products: [] });
    }
    // Escape ILIKE metacharacters so search text can't wildcard-match.
    const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';

    const [orders, customers, products] = await Promise.all([
      query(
        `SELECT id, order_number, status, payment_status, total_ghs, created_at
           FROM orders
          WHERE business_id = $1 AND order_number ILIKE $2
          ORDER BY created_at DESC LIMIT 6`,
        [business_id, like]
      ),
      query(
        `SELECT id, display_name, whatsapp_number, total_orders, total_spent_ghs
           FROM customers
          WHERE business_id = $1 AND (display_name ILIKE $2 OR whatsapp_number ILIKE $2)
          ORDER BY total_spent_ghs DESC LIMIT 6`,
        [business_id, like]
      ),
      query(
        `SELECT id, name, price_ghs, category, in_stock
           FROM products
          WHERE business_id = $1 AND name ILIKE $2
          ORDER BY name ASC LIMIT 6`,
        [business_id, like]
      )
    ]);

    return respond.ok(req, res, {
      orders: orders.rows, customers: customers.rows, products: products.rows
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /search', err);
  }
});

module.exports = router;
