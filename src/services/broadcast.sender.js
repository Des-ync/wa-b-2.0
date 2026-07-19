const logger = require('../utils/logger');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const wa = require('./whatsapp.service');
const ig = require('./instagram.service');

// Messages sent per drain tick, across all businesses combined. Deliberately
// low and shared globally (not per-business) — this is the throttle that
// keeps a merchant blasting a big list from tripping Meta's WhatsApp rate
// limits and getting the shop's number restricted or banned.
const BATCH_SIZE = 20;
// Small pacing gap between individual sends within a batch, same reason.
const SEND_GAP_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Drains broadcast_recipients: claims up to BATCH_SIZE 'pending' rows across
 * all businesses, sends one message each (paced), records the outcome, and
 * closes out any broadcast whose recipients are all resolved.
 *
 * Re-checks opted_out and bot_paused status at send time (not just at fanout
 * time) — a customer who opts out between broadcast creation and drain must
 * never receive the message.
 */
async function runBroadcastSenderJob() {
  await lock.withLock('broadcast_sender_job', 120, async () => {
    const claimed = await query(
      `UPDATE broadcast_recipients br
          SET status = 'sending'
        FROM (
          SELECT br2.id
            FROM broadcast_recipients br2
            JOIN broadcasts b ON b.id = br2.broadcast_id
           WHERE br2.status = 'pending'
             AND b.status IN ('pending', 'sending')
           ORDER BY br2.id
           LIMIT $1
           FOR UPDATE OF br2 SKIP LOCKED
        ) claim
       WHERE br.id = claim.id
       RETURNING br.id, br.broadcast_id, br.customer_id`,
      [BATCH_SIZE]
    );
    if (!claimed.rowCount) return;

    // Mark the parent broadcast(s) as actively sending.
    const broadcastIds = [...new Set(claimed.rows.map(r => r.broadcast_id))];
    await query(
      `UPDATE broadcasts SET status = 'sending' WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [broadcastIds]
    );

    for (const row of claimed.rows) {
      const detail = await query(
        `SELECT br.id AS recipient_id, br.broadcast_id, b.body,
                c.id AS customer_id, c.channel, c.channel_id, c.whatsapp_number,
                c.opted_out, c.business_id
           FROM broadcast_recipients br
           JOIN broadcasts b ON b.id = br.broadcast_id
           JOIN customers c ON c.id = br.customer_id
          WHERE br.id = $1`,
        [row.id]
      );
      const d = detail.rows[0];
      if (!d) continue;

      let ok = false;
      if (d.opted_out) {
        logger.info('[cron] broadcast skip: customer %s opted out since fanout', d.customer_id);
      } else {
        try {
          const meta = { businessId: d.business_id, customerId: d.customer_id };
          if (d.channel === 'instagram') {
            const result = await ig.sendText(d.channel_id, d.body, meta);
            ok = !!result.success;
          } else {
            const result = await wa.sendBusinessNotice({
              to: d.whatsapp_number,
              templateEnv: 'WA_TPL_BROADCAST',
              bodyParams: [d.body],
              fallbackText: d.body,
              meta
            });
            ok = !!result.success;
          }
        } catch (err) {
          logger.warn('[cron] broadcast send failed for recipient %s: %s', d.recipient_id, err.message);
        }
      }

      await query(
        `UPDATE broadcast_recipients SET status = $2, sent_at = NOW() WHERE id = $1`,
        [d.recipient_id, ok ? 'sent' : 'failed']
      );
      await query(
        `UPDATE broadcasts
            SET sent_count   = sent_count + $2,
                failed_count = failed_count + $3
          WHERE id = $1`,
        [d.broadcast_id, ok ? 1 : 0, ok ? 0 : 1]
      );

      await sleep(SEND_GAP_MS);
    }

    // Close out any broadcast with no pending/sending recipients left.
    await query(
      `UPDATE broadcasts b
          SET status = 'done', completed_at = NOW()
        WHERE b.id = ANY($1::uuid[])
          AND b.status = 'sending'
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_recipients br
             WHERE br.broadcast_id = b.id AND br.status IN ('pending', 'sending')
          )`,
      [broadcastIds]
    );

    logger.info('[cron] broadcast sender: drained %d recipient(s)', claimed.rowCount);
  });
}

module.exports = { runBroadcastSenderJob };
