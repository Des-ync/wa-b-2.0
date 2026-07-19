const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

/**
 * GET /api/search?business_id=&q= — global dashboard search across orders,
 * customers, and products in one round trip (powers the Cmd/Ctrl+K palette).
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, q } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const term = String(q || '').trim();
    if (term.length < 2) return res.json({ success: true, orders: [], customers: [], products: [] });
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

    res.json({ success: true, orders: orders.rows, customers: customers.rows, products: products.rows });
  } catch (err) {
    logger.error('GET /search failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
