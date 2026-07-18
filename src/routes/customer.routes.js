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
 * GET /api/customers?business_id=&limit=&sort=spent|recent
 * Ranked customer list for the merchant dashboard ("best customers").
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, sort } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const orderBy = sort === 'recent'
      ? 'last_seen_at DESC'
      : 'total_spent_ghs DESC, total_orders DESC';
    const r = await query(
      `SELECT id, whatsapp_number, display_name, channel, phone_network,
              total_orders, total_spent_ghs, last_seen_at, created_at
         FROM customers
        WHERE business_id = $1
        ORDER BY ${orderBy}
        LIMIT $2`,
      [business_id, limit]
    );
    res.json({ success: true, customers: r.rows });
  } catch (err) {
    logger.error('GET /customers failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
