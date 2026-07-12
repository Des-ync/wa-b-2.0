const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All admin routes require an admin-scoped API key.
router.use(requireAuth('admin'));

/**
 * GET /api/admin/stats — high-level dashboard counters.
 */
router.get('/stats', async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM businesses)                                AS businesses_total,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'active')        AS businesses_active,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'trial')         AS businesses_trial,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'suspended')     AS businesses_suspended,
        (SELECT COUNT(*)::int FROM customers)                                 AS customers_total,
        (SELECT COUNT(*)::int FROM products)                                  AS products_total,
        (SELECT COUNT(*)::int FROM orders)                                    AS orders_total,
        (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'paid')      AS orders_paid,
        (SELECT COALESCE(SUM(total_ghs),0) FROM orders WHERE payment_status='paid') AS gmv_ghs,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active')     AS subscriptions_active,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'grace')      AS subscriptions_grace,
        (SELECT COALESCE(SUM(amount_ghs),0) FROM billing_transactions
            WHERE status = 'success'
              AND completed_at >= date_trunc('month', NOW()))                 AS mrr_ghs_this_month,
        (SELECT COUNT(*)::int FROM message_log
            WHERE created_at >= NOW() - INTERVAL '24 hours')                  AS messages_last_24h
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    logger.error('GET /admin/stats failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/businesses — list businesses (basic).
 */
router.get('/businesses', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await query(
      `SELECT b.id, b.name, b.owner_name, b.whatsapp_number, b.wa_phone_number_id,
              b.industry, b.status, b.trial_ends_at, b.created_at, b.updated_at,
              (SELECT s.status FROM subscriptions s WHERE s.business_id = b.id
                ORDER BY s.created_at DESC LIMIT 1) AS subscription_status,
              (SELECT p.display_name FROM subscriptions s
                 JOIN plans p ON p.id = s.plan_id
                WHERE s.business_id = b.id
                ORDER BY s.created_at DESC LIMIT 1) AS plan_name
         FROM businesses b
        ORDER BY b.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ success: true, businesses: result.rows });
  } catch (err) {
    logger.error('GET /admin/businesses failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/billing — recent SaaS billing transactions.
 */
router.get('/billing', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await query(
      `SELECT bt.*, b.name AS business_name, b.whatsapp_number
         FROM billing_transactions bt
         LEFT JOIN businesses b ON b.id = bt.business_id
        ORDER BY bt.initiated_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    logger.error('GET /admin/billing failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/messages — recent message log entries.
 */
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const result = await query(
      `SELECT * FROM message_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, messages: result.rows });
  } catch (err) {
    logger.error('GET /admin/messages failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
