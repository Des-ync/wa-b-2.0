const logger = require('../utils/logger');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const { getAdapter, destOf } = require('./channel.adapter');
const { t, langOf } = require('../utils/i18n');

/**
 * Cart-abandonment recovery. Every run finds ordering-flow conversations that
 * have a non-empty cart, went quiet 1–23 hours ago, and haven't been nudged,
 * then sends ONE "your cart is saved" reminder.
 *
 * Why 23 hours: the nudge is a free-form message, deliverable only inside
 * Meta's 24-hour customer-service window that opened with the customer's last
 * inbound message. Past that we stay silent rather than fail sends.
 *
 * The nudge also (a) moves the flow step to 'await_more' so the reminder's
 * Checkout / Add more buttons land in a step that understands them, and
 * (b) extends expires_at — otherwise the state would have already expired
 * and the customer's tap would reset the flow and wipe the cart.
 */
async function runCartNudgeJob() {
  await lock.withLock('cart_nudge_job', 300, async () => {
    const candidates = await query(
      `SELECT cs.customer_id, cs.flow_data, c.channel, c.channel_id, c.whatsapp_number,
              b.id AS business_id, b.name AS business_name, b.status AS business_status,
              b.trial_ends_at, b.bot_language
         FROM conversation_state cs
         JOIN customers c ON c.id = cs.customer_id
         JOIN businesses b ON b.id = c.business_id
        WHERE cs.current_flow = 'ordering'
          AND jsonb_array_length(COALESCE(cs.flow_data->'cart', '[]'::jsonb)) > 0
          AND cs.last_message_at < NOW() - INTERVAL '1 hour'
          AND cs.last_message_at > NOW() - INTERVAL '23 hours'
          AND cs.nudge_sent_at IS NULL
        LIMIT 100`
    );
    if (!candidates.rows.length) return;
    logger.info('[cron] cart nudge: %d abandoned cart(s) found', candidates.rows.length);

    let sent = 0;
    for (const row of candidates.rows) {
      // Mirror hasCommerceAccess: never nudge for a shop that can't take orders.
      const blocked =
        ['suspended', 'cancelled'].includes(row.business_status) ||
        (row.business_status === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at) < new Date());
      // Claim first (set nudge_sent_at) so a crash mid-loop can't double-send.
      const claimed = await query(
        `UPDATE conversation_state
            SET nudge_sent_at = NOW(),
                current_step  = 'await_more',
                expires_at    = NOW() + INTERVAL '23 hours'
          WHERE customer_id = $1 AND nudge_sent_at IS NULL
          RETURNING customer_id`,
        [row.customer_id]
      );
      if (!claimed.rowCount || blocked) continue;

      try {
        const cart = Array.isArray(row.flow_data?.cart) ? row.flow_data.cart : [];
        const count = cart.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
        const customer = { channel: row.channel, channel_id: row.channel_id, whatsapp_number: row.whatsapp_number };
        const lang = langOf(row);
        await getAdapter(row.channel).sendButtons(
          destOf(customer),
          t(lang, 'cart_nudge', { shop: row.business_name, count }),
          [
            { id: 'checkout', title: t(lang, 'btn_checkout') },
            { id: 'add_more', title: t(lang, 'btn_add_more') },
            { id: 'cancel_order', title: t(lang, 'btn_cancel') }
          ],
          { businessId: row.business_id, customerId: row.customer_id }
        );
        sent++;
      } catch (err) {
        logger.warn('[cron] cart nudge send failed for customer %s: %s', row.customer_id, err.message);
      }
    }
    logger.info('[cron] cart nudge done: %d reminder(s) sent', sent);
  });
}

module.exports = { runCartNudgeJob };
