const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { buildAudienceClauses, describeAudience } = require('../utils/audience');
const respond = require('../utils/response');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/broadcasts?business_id=
 * Past broadcasts with delivery stats — sent_count/failed_count are updated
 * live by broadcast.sender.js as the queue drains.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const r = await query(
      `SELECT id, body, status, target_count, sent_count, failed_count, audience_desc, created_at, completed_at
         FROM broadcasts
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [business_id]
    );
    return respond.ok(req, res, { broadcasts: r.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /broadcasts', err);
  }
});

/**
 * POST /api/broadcasts
 * Body: { business_id, body, audience?: { tag?, segment?, min_spend_ghs? } }
 *
 * Fans out immediately to every non-opted-out customer matching the audience
 * filter (default: everyone) — one broadcast_recipients row per customer,
 * all 'pending'. The actual sends happen in broadcast.sender.js's
 * rate-limited cron drain, not here, so a merchant blasting 5,000 customers
 * never ties up this request or blows through Meta's per-second send limits.
 */
router.post('/', requirePermission('broadcasts', 'write'), async (req, res) => {
  try {
    const { business_id, audience } = req.body || {};
    const body = String(req.body?.body || '').trim();
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    if (!body) return respond.invalid(req, res, 'body is required', { body: 'is invalid' });
    if (body.length > 1024) return respond.invalid(req, res, 'body is too long (max 1024 chars)', { body: 'is invalid' });

    const audienceDesc = describeAudience(audience);

    // Create + fan out atomically so a crash mid-request can't leave a
    // broadcast without its recipient rows. A broadcast with zero eligible
    // recipients is marked 'done' immediately — the sender job only ever
    // completes broadcasts by draining recipients, so an empty one would
    // otherwise sit in 'pending' forever.
    const result = await transaction(async client => {
      const created = await client.query(
        `INSERT INTO broadcasts (business_id, body, status, audience_desc)
         VALUES ($1, $2, 'pending', $3)
         RETURNING id`,
        [business_id, body, audienceDesc]
      );
      const broadcastId = created.rows[0].id;

      const params = [broadcastId, business_id];
      const extra = buildAudienceClauses(audience, params);
      const recipients = await client.query(
        `INSERT INTO broadcast_recipients (broadcast_id, customer_id)
         SELECT $1, c.id FROM customers c
          WHERE c.business_id = $2 AND c.opted_out = FALSE ${extra.map(cl => `AND ${cl}`).join(' ')}`,
        params
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

    return respond.ok(req, res, { broadcast_id: result.broadcastId, target_count: result.count }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /broadcasts', err);
  }
});

module.exports = router;
