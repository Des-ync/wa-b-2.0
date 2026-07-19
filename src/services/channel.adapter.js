const wa = require('./whatsapp.service');
const ig = require('./instagram.service');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const { truncate } = require('../utils/helpers');

/**
 * Resolve the outbound messaging adapter for a channel. Both adapters expose
 * the same customer-facing surface: sendText, sendButtons, sendList,
 * markAsRead, sendPaymentConfirmation.
 *
 * WhatsApp is the default for any unknown/missing channel so pre-migration
 * customer rows (channel column absent/NULL) behave exactly as before.
 *
 * Instagram runs in TEXT MODE: quick-reply chips vanish as soon as the
 * conversation moves on and never render on desktop, so buttons and lists go
 * out as numbered text menus instead. The options shown are remembered in
 * conversation_state.flow_data.ig_options, and the conversation handler
 * translates a typed "2" back into the second option's interactive id.
 */
function getAdapter(channel) {
  return channel === 'instagram' ? igText : wa;
}

// NEEDS_NATIVE_REVIEW (Twi half of the hint)
const NUMBER_HINT = 'Reply with a number, e.g. 1 (Fa nɔma bua, te sɛ 1)';

/**
 * Remember the numbered options just shown to an IG customer. Merged into
 * flow_data (never replacing it) and without touching flow/step/expiry —
 * the flow state machine stays the single owner of those.
 */
async function rememberIgOptions(customerId, options) {
  if (!customerId || !options?.length) return;
  try {
    await query(
      `INSERT INTO conversation_state
         (customer_id, current_flow, current_step, flow_data, last_message_at, expires_at)
       VALUES ($1, 'idle', 'start', jsonb_build_object('ig_options', $2::jsonb),
               NOW(), NOW() + INTERVAL '30 minutes')
       ON CONFLICT (customer_id) DO UPDATE SET
         flow_data = conversation_state.flow_data || jsonb_build_object('ig_options', $2::jsonb),
         updated_at = NOW()`,
      [customerId, JSON.stringify(options)]
    );
  } catch (err) {
    logger.warn('rememberIgOptions failed for customer %s: %s', customerId, err.message);
  }
}

const igText = {
  ...ig,

  /** Buttons → "1. Order Now  2. Talk to us" numbered text. */
  async sendButtons(to, body, buttons = [], meta = {}) {
    const opts = buttons.map((b, i) => ({ id: b.id, title: b.title || `Option ${i + 1}` }));
    const lines = opts.map((o, i) => `${i + 1}. ${o.title}`);
    const text = [body, lines.join('\n'), NUMBER_HINT].filter(Boolean).join('\n\n');
    const res = await ig.sendText(to, text, meta);
    if (res?.success) await rememberIgOptions(meta.customerId, opts);
    return res;
  },

  /** List rows → numbered lines with a shortened description. */
  async sendList(to, header, body, sections = [], meta = {}) {
    const rows = sections.flatMap(s => s.rows || []).slice(0, 10);
    const opts = rows.map((r, i) => ({ id: r.id, title: r.title || `Item ${i + 1}` }));
    const lines = rows.map((r, i) => {
      const desc = r.description ? ` — ${truncate(r.description, 48)}` : '';
      return `${i + 1}. ${r.title}${desc}`;
    });
    const text = [header, body, lines.join('\n'), NUMBER_HINT].filter(Boolean).join('\n\n');
    const res = await ig.sendText(to, text, meta);
    if (res?.success) await rememberIgOptions(meta.customerId, opts);
    return res;
  }
};

/**
 * The channel-native destination for a customer row: IG-scoped user id for
 * Instagram, the WhatsApp number (unchanged, backward-compatible) otherwise.
 */
function destOf(customer) {
  return customer?.channel === 'instagram'
    ? customer.channel_id
    : customer?.whatsapp_number;
}

module.exports = { getAdapter, destOf };
