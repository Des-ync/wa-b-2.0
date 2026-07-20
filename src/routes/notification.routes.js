const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/notifications?business_id=&unread_only=&limit=
 * The dashboard bell icon's feed — new orders, failed payments, low stock,
 * and "talk to a human" requests, newest first.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, unread_only } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const params = [business_id];
    let sql = 'SELECT * FROM dashboard_notifications WHERE business_id = $1';
    if (unread_only === 'true' || unread_only === '1') sql += ' AND read_at IS NULL';
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const [rows, unreadCount] = await Promise.all([
      query(sql, params),
      query('SELECT COUNT(*)::int AS n FROM dashboard_notifications WHERE business_id = $1 AND read_at IS NULL', [business_id])
    ]);
    res.json({ success: true, notifications: rows.rows, unread_count: unreadCount.rows[0].n });
  } catch (err) {
    logger.error('GET /notifications failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/notifications/:id/read */
router.post('/:id/read', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM dashboard_notifications WHERE id = $1', [req.params.id]);
    const notif = existing.rows[0];
    if (!notif) return res.status(404).json({ success: false, error: 'Notification not found' });
    if (tenantBlocksBusinessId(req, notif.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('UPDATE dashboard_notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /notifications/:id/read failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/notifications/mark-all-read — body: { business_id? } */
router.post('/mark-all-read', async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('UPDATE dashboard_notifications SET read_at = NOW() WHERE business_id = $1 AND read_at IS NULL', [businessId]);
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /notifications/mark-all-read failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
