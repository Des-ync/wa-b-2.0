const logger = require('../utils/logger');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const { getAdapter, destOf } = require('./channel.adapter');
const sms = require('./sms.service');
const { t, langOf } = require('../utils/i18n');

/**
 * Deterministic A/B bucket for a customer: same customer always lands in the
 * same arm across repeat nudges, which is what makes the test valid. Not
 * cryptographic — just needs to be a stable, roughly-even split.
 */
function variantFor(customerId) {
  let hash = 0;
  for (let i = 0; i < customerId.length; i++) {
    hash = (hash * 31 + customerId.charCodeAt(i)) >>> 0;
  }
  return hash % 2 === 0 ? 'a' : 'b';
}

function renderTemplate(template, { shop, count }) {
  return String(template)
    .replace(/\{shop\}/g, shop)
    .replace(/\{count\}/g, String(count))
    .slice(0, 1024);
}

/**
 * Cart-abandonment recovery. Every run finds ordering-flow conversations that
 * have a non-empty cart, went quiet since the business's configured delay,
 * and haven't hit the business's max-nudges-per-cart cap, then sends a
 * reminder — using the merchant's custom copy/coupon if configured, an A/B
 * variant if a second template is set, and logs the send for analytics.
 *
 * Why 23 hours: the nudge is a free-form message, deliverable only inside
 * Meta's 24-hour customer-service window that opened with the customer's last
 * inbound message. Past that we stay silent rather than fail sends. That
 * ceiling is anchored to last_message_at (the customer's own last message),
 * not to our own last nudge — replying to ourselves doesn't reopen the window.
 *
 * The nudge also (a) moves the flow step to 'await_more' so the reminder's
 * Checkout / Add more buttons land in a step that understands them, and
 * (b) extends expires_at — otherwise the state would have already expired
 * and the customer's tap would reset the flow and wipe the cart.
 */
async function runCartNudgeJob() {
  await lock.withLock('cart_nudge_job', 300, async () => {
    const candidates = await query(
      `SELECT cs.customer_id, cs.flow_data, cs.nudge_count, c.channel, c.channel_id, c.whatsapp_number,
              b.id AS business_id, b.name AS business_name, b.status AS business_status,
              b.trial_ends_at, b.bot_language,
              b.cart_nudge_enabled, b.cart_nudge_delay_minutes, b.cart_nudge_max_per_cart,
              b.cart_nudge_message_template, b.cart_nudge_template_b, b.cart_nudge_coupon_code
         FROM conversation_state cs
         JOIN customers c ON c.id = cs.customer_id
         JOIN businesses b ON b.id = c.business_id
        WHERE cs.current_flow = 'ordering'
          AND jsonb_array_length(COALESCE(cs.flow_data->'cart', '[]'::jsonb)) > 0
          AND b.cart_nudge_enabled = TRUE
          AND cs.nudge_count < b.cart_nudge_max_per_cart
          AND cs.last_message_at > NOW() - INTERVAL '23 hours'
          AND COALESCE(cs.nudge_sent_at, cs.last_message_at)
                < NOW() - (b.cart_nudge_delay_minutes || ' minutes')::interval
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
      // Claim first (bump nudge_count) so a crash mid-loop can't double-send,
      // and re-check the cap in the same statement to close the race window.
      const claimed = await query(
        `UPDATE conversation_state
            SET nudge_sent_at = NOW(),
                nudge_count   = nudge_count + 1,
                current_step  = 'await_more',
                expires_at    = NOW() + INTERVAL '23 hours'
          WHERE customer_id = $1 AND nudge_count < $2
          RETURNING nudge_count`,
        [row.customer_id, row.cart_nudge_max_per_cart]
      );
      if (!claimed.rowCount || blocked) continue;

      try {
        const cart = Array.isArray(row.flow_data?.cart) ? row.flow_data.cart : [];
        const count = cart.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
        const cartValue = cart.reduce((sum, i) => sum + (Number(i.price_ghs) || 0) * (Number(i.quantity) || 1), 0);
        const customer = { channel: row.channel, channel_id: row.channel_id, whatsapp_number: row.whatsapp_number };
        const lang = langOf(row);

        const variant = (row.cart_nudge_template_b && row.cart_nudge_template_b.trim())
          ? variantFor(row.customer_id) : 'a';
        const template = variant === 'b' ? row.cart_nudge_template_b : row.cart_nudge_message_template;
        let body = template
          ? renderTemplate(template, { shop: row.business_name, count })
          : t(lang, 'cart_nudge', { shop: row.business_name, count });
        if (row.cart_nudge_coupon_code) {
          body += t(lang, 'cart_nudge_coupon', { code: row.cart_nudge_coupon_code });
        }

        const nudgeResult = await getAdapter(row.channel).sendButtons(
          destOf(customer),
          body,
          [
            { id: 'checkout', title: t(lang, 'btn_checkout') },
            { id: 'add_more', title: t(lang, 'btn_add_more') },
            { id: 'cancel_order', title: t(lang, 'btn_cancel') }
          ],
          { businessId: row.business_id, customerId: row.customer_id }
        );

        // SMS fallback: same constraint as the receipt fallback in
        // notification.service — only WhatsApp customers have a real phone
        // number on file. IG/Messenger customers' whatsapp_number column
        // holds their platform user id, not something we can text.
        if (nudgeResult?.success === false && row.channel === 'whatsapp' && row.whatsapp_number) {
          await sms.sendSms(row.whatsapp_number, t(lang, 'sms_cart_nudge', {
            shop: row.business_name, count
          }), { businessId: row.business_id, customerId: row.customer_id });
        }

        await query(
          `INSERT INTO cart_nudges (business_id, customer_id, nudge_number, variant, coupon_code, cart_value_ghs)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.business_id, row.customer_id, claimed.rows[0].nudge_count, variant,
            row.cart_nudge_coupon_code || null, cartValue.toFixed(2)]
        );
        sent++;
      } catch (err) {
        logger.warn('[cron] cart nudge send failed for customer %s: %s', row.customer_id, err.message);
      }
    }
    logger.info('[cron] cart nudge done: %d reminder(s) sent', sent);
  });
}

module.exports = { runCartNudgeJob, variantFor, renderTemplate };
