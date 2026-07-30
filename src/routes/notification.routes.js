const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');

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
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) return respond.forbidden(req, res);
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
    // unread_count is ABOUT the collection rather than in it, so it belongs in
    // meta. Legacy callers still see it flat at the top level, which is what
    // the mobile home screen reads.
    return respond.ok(req, res,
      { notifications: rows.rows },
      { meta: { unread_count: unreadCount.rows[0].n } });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /notifications', err);
  }
});

/** POST /api/notifications/:id/read */
router.post('/:id/read', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM dashboard_notifications WHERE id = $1', [req.params.id]);
    const notif = existing.rows[0];
    if (!notif) return respond.notFound(req, res, 'Notification');
    if (tenantBlocksBusinessId(req, notif.business_id)) return respond.forbidden(req, res);

    await query('UPDATE dashboard_notifications SET read_at = NOW() WHERE id = $1 AND read_at IS NULL', [req.params.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /notifications/:id/read', err);
  }
});

/** POST /api/notifications/mark-all-read — body: { business_id? } */
router.post('/mark-all-read', async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) return respond.forbidden(req, res);

    await query('UPDATE dashboard_notifications SET read_at = NOW() WHERE business_id = $1 AND read_at IS NULL', [businessId]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /notifications/mark-all-read', err);
  }
});

module.exports = router;
