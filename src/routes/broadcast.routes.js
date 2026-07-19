const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

/**
 * GET /api/broadcasts?business_id=
 * Past broadcasts with delivery stats — sent_count/failed_count are updated
 * live by broadcast.sender.js as the queue drains.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const r = await query(
      `SELECT id, body, status, target_count, sent_count, failed_count, created_at, completed_at
         FROM broadcasts
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [business_id]
    );
    res.json({ success: true, broadcasts: r.rows });
  } catch (err) {
    logger.error('GET /broadcasts failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/broadcasts
 * Body: { business_id, body }
 *
 * Fans out immediately to every non-opted-out customer of the business —
 * one broadcast_recipients row per customer, all 'pending'. The actual
 * sends happen in broadcast.sender.js's rate-limited cron drain, not here,
 * so a merchant blasting 5,000 customers never ties up this request or
 * blows through Meta's per-second send limits.
 */
router.post('/', async (req, res) => {
  try {
    const { business_id } = req.body || {};
    const body = String(req.body?.body || '').trim();
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (!body) return res.status(400).json({ success: false, error: 'body is required' });
    if (body.length > 1024) return res.status(400).json({ success: false, error: 'body is too long (max 1024 chars)' });

    // Create + fan out atomically so a crash mid-request can't leave a
    // broadcast without its recipient rows. A broadcast with zero eligible
    // recipients is marked 'done' immediately — the sender job only ever
    // completes broadcasts by draining recipients, so an empty one would
    // otherwise sit in 'pending' forever.
    const result = await transaction(async client => {
      const created = await client.query(
        `INSERT INTO broadcasts (business_id, body, status)
         VALUES ($1, $2, 'pending')
         RETURNING id`,
        [business_id, body]
      );
      const broadcastId = created.rows[0].id;

      const recipients = await client.query(
        `INSERT INTO broadcast_recipients (broadcast_id, customer_id)
         SELECT $1, id FROM customers
          WHERE business_id = $2 AND opted_out = FALSE`,
        [broadcastId, business_id]
      );
      const count = recipients.rowCount;

      await client.query(
        `UPDATE broadcasts
            SET target_count = $2,
                status       = CASE WHEN $2 = 0 THEN 'done' ELSE status END,
                completed_at = CASE WHEN $2 = 0 THEN NOW() ELSE completed_at END
          WHERE id = $1`,
        [broadcastId, count]
      );

      return { broadcastId, count };
    });

    res.status(201).json({ success: true, broadcast_id: result.broadcastId, target_count: result.count });
  } catch (err) {
    logger.error('POST /broadcasts failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
