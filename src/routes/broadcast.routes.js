const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { buildAudienceClauses, describeAudience } = require('../utils/audience');
const wa = require('../services/whatsapp.service');
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
 * POST /api/broadcasts/preview
 * Body: { business_id, audience?: { tag?, segment?, min_spend_ghs? } }
 *
 * How many customers a broadcast would actually reach, before it is sent.
 *
 * This is the single most important safety rail on this feature: a broadcast
 * fans out to every matching customer's WhatsApp the moment it is created
 * and cannot be recalled. A merchant picking "inactive 60+ days" has no way
 * to know whether that is 4 people or 4,000 — and the difference between
 * those two is the difference between a nudge and a reputational incident.
 *
 * Returns the same opted-out-excluded count the fan-out itself will produce,
 * built from the SAME buildAudienceClauses the sender uses, so the number
 * cannot drift from reality. Also returns how many were excluded for having
 * opted out, because "12 of your 60 customers have opted out" is the fact
 * that makes the enforcement visible rather than merely promised.
 *
 * POST rather than GET: the audience is a nested object, and this is
 * read-only despite the verb.
 */
router.post('/preview', requirePermission('broadcasts', 'write'), async (req, res) => {
  try {
    const { business_id, audience } = req.body || {};
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) return respond.forbidden(req, res);

    const params = [business_id];
    const extra = buildAudienceClauses(audience, params);
    const where = extra.map(cl => `AND ${cl}`).join(' ');

    const [reachable, optedOut, sample] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS n FROM customers c
          WHERE c.business_id = $1 AND c.opted_out = FALSE ${where}`,
        params
      ),
      // Counted against the SAME audience filter, so it answers "how many of
      // the people you targeted have opted out", not "how many overall".
      query(
        `SELECT COUNT(*)::int AS n FROM customers c
          WHERE c.business_id = $1 AND c.opted_out = TRUE ${where}`,
        params
      ),
      query(
        `SELECT c.display_name, c.whatsapp_number FROM customers c
          WHERE c.business_id = $1 AND c.opted_out = FALSE ${where}
          ORDER BY c.total_spent_ghs DESC
          LIMIT 5`,
        params
      )
    ]);

    return respond.ok(req, res, {
      // A handful of real names, so the merchant can sanity-check that the
      // filter means what they think before committing to it.
      sample: sample.rows
    }, {
      meta: {
        recipient_count: reachable.rows[0].n,
        opted_out_count: optedOut.rows[0].n,
        audience_desc: describeAudience(audience)
      }
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /broadcasts/preview', err);
  }
});

/**
 * POST /api/broadcasts/test
 * Body: { business_id, body }
 *
 * Send the composed message to the shop's OWN WhatsApp number, so a merchant
 * can read it the way a customer will before it goes to everyone.
 *
 * Worth having because the failure this catches is not a bug — it is a typo,
 * a missing price, or a line that reads fine in a compose box and badly in a
 * chat bubble. None of those are recoverable once the fan-out starts.
 *
 * Deliberately NOT recorded in `broadcasts`: a test is not a campaign, and
 * counting it would corrupt the history and the delivery stats.
 */
router.post('/test', requirePermission('broadcasts', 'write'), async (req, res) => {
  try {
    const { business_id } = req.body || {};
    const body = String(req.body?.body || '').trim();
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) return respond.forbidden(req, res);
    if (!body) return respond.invalid(req, res, 'body is required', { body: 'is required' });
    if (body.length > 1024) {
      return respond.invalid(req, res, 'body is too long (max 1024 chars)', { body: 'is too long' });
    }

    const bizRes = await query(
      'SELECT id, name, whatsapp_number FROM businesses WHERE id = $1',
      [business_id]
    );
    const business = bizRes.rows[0];
    if (!business) return respond.notFound(req, res, 'Business');
    if (!business.whatsapp_number) {
      return respond.invalid(req, res, 'This shop has no WhatsApp number to send a test to');
    }

    // Prefixed so a merchant reading it on their phone cannot mistake the
    // test for a real campaign that already went out.
    const result = await wa.sendText(business.whatsapp_number,
      `🧪 TEST — this is how your broadcast will look. Only you received it.\n\n${body}`,
      { businessId: business.id });

    if (!result?.success) {
      return respond.fail(req, res, {
        code: respond.CODES.UPSTREAM,
        message: result?.error || 'Could not send the test message'
      });
    }
    return respond.ok(req, res, {}, { meta: { sent_to: business.whatsapp_number } });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /broadcasts/test', err);
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
