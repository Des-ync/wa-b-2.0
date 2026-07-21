const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
const { getAdapter, destOf } = require('./channel.adapter');
const { detectIntent, normalizeIntent } = require('./nl.intent');
const paystack = require('./paystack.service');
const orderService = require('./order.service');
const subService = require('./subscription.service');
const notificationService = require('./notification.service');
const push = require('./push.service');
const dashboardNotify = require('./dashboard.notify');
const {
  normalizeGhanaPhone,
  detectNetwork,
  formatGhs,
  generateReference,
  syntheticEmail,
  truncate,
  formatDate,
  sleep,
  ORDER_NUMBER_RE,
  decayedTypingDelay,
  buildMenuPage,
  parseQuantityExpression,
  isWithinBusinessHours
} = require('../utils/helpers');
const { t, langOf, detectLikelyLanguage } = require('../utils/i18n');
const { detectProductQuery } = require('../utils/productQuery');
const { fuzzyMatchProducts } = require('../utils/fuzzyMatch');
const { pickFrequentlyBoughtSuggestion, pickVariantUpgrade } = require('../utils/upsell');
const { generateReferralCode } = require('../utils/loyalty');
const { setBusinessId } = require('../utils/requestContext');

/* -----------------------------------------------------------------
   Typing indicator pacing: the first reply in a conversation waits the
   longest; each subsequent reply gets progressively shorter, so a busy
   queue drains fast while single messages still feel human.
   ----------------------------------------------------------------- */
const TYPING_RESET_MS = 10 * 60 * 1000;

// orderService.validatePromoCode's error codes -> customer-facing i18n keys.
const PROMO_ERROR_KEYS = {
  expired: 'promo_expired',
  exhausted: 'promo_exhausted',
  min_order_not_met: 'promo_min_order_not_met',
  first_order_only: 'promo_first_order_only',
  not_eligible: 'promo_not_eligible',
  product_not_in_cart: 'promo_wrong_items',
  category_not_in_cart: 'promo_wrong_items'
};
const typingCounts = new Map(); // key -> { count, ts }

function nextTypingDelay(key) {
  const now = Date.now();
  if (typingCounts.size > 5000) {
    for (const [k, v] of typingCounts) {
      if (now - v.ts > TYPING_RESET_MS) typingCounts.delete(k);
    }
  }
  const entry = typingCounts.get(key);
  const count = entry && now - entry.ts < TYPING_RESET_MS ? entry.count : 0;
  typingCounts.set(key, { count: count + 1, ts: now });
  return decayedTypingDelay(count);
}

const SUPPORT_NUMBER = process.env.SUPPORT_WHATSAPP_NUMBER || '+233241234567';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/* -----------------------------------------------------------------
   Per-customer inbound rate limit. A hostile or looping customer spamming
   the bot burns Meta conversation fees; past the soft cap they get ONE
   cool-off notice per window, past the hard cap we stop replying entirely
   (their messages are still logged/deduped above).
   ----------------------------------------------------------------- */
// NOTE: this limiter (like typingCounts above) is in-memory and therefore
// per-process. It is only effective while exactly ONE process runs the
// webhook processor (the current pm2 setup). Scaling RUN_PROCESSOR to
// multiple instances multiplies every customer's budget — move these
// counters to Postgres before doing that.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_SOFT_MAX = 25;   // replies allowed per window
const RATE_HARD_MAX = 50;   // beyond this: silent drop
const rateBuckets = new Map(); // customerId -> { timestamps: number[], warnedAt: number }

function checkInboundRate(customerId) {
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (!v.timestamps.length || now - v.timestamps[v.timestamps.length - 1] > RATE_WINDOW_MS) {
        rateBuckets.delete(k);
      }
    }
  }
  const bucket = rateBuckets.get(customerId) || { timestamps: [], warnedAt: 0 };
  bucket.timestamps = bucket.timestamps.filter(t => now - t < RATE_WINDOW_MS);
  bucket.timestamps.push(now);
  rateBuckets.set(customerId, bucket);

  if (bucket.timestamps.length > RATE_HARD_MAX) return 'drop';
  if (bucket.timestamps.length > RATE_SOFT_MAX) {
    if (now - bucket.warnedAt > RATE_WINDOW_MS) {
      bucket.warnedAt = now;
      return 'warn';
    }
    return 'drop';
  }
  return 'ok';
}

/** Outbound adapter for a customer's channel (WhatsApp unless 'instagram'). */
function chOf(customer) {
  return getAdapter(customer?.channel);
}

/** Does the typed text equal any of these i18n button labels (en or tw)?
 * (normalizeIntent lives in nl.intent.js — uppercase, Twi vowels folded.) */
function titleMatches(text, ...keys) {
  const norm = normalizeIntent(text);
  if (!norm) return false;
  return keys.some(k =>
    ['en', 'tw'].some(lang => normalizeIntent(t(lang, k)) === norm));
}

/* =================================================================
   Inbound message normalizer
   ================================================================= */

/**
 * Normalize an inbound webhook payload into one channel-tagged shape:
 *   { channel, from, profileName, messageId, type, text,
 *     interactiveId, interactiveTitle, location, raw, ... }
 * WhatsApp payloads additionally carry businessPhoneId; Instagram payloads
 * carry igBusinessAccountId. Both feed the SAME conversation state machine.
 */
function extractInbound(payload, channel = 'whatsapp') {
  if (channel === 'instagram') return extractInstagramInbound(payload);
  if (channel === 'messenger') return extractMessengerInbound(payload);
  return extractWhatsAppInbound(payload);
}

function extractWhatsAppInbound(payload) {
  try {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return null;
    const message = value.messages?.[0];
    if (!message) return null;

    const contact = value.contacts?.[0];
    // Meta's "message without sharing your number" mode omits `message.from`
    // entirely — the sender is identified only by an opaque from_user_id
    // (e.g. "GH.1051901200567604") plus a username, no phone number at all.
    // Falling back blindly to message.from.replace(...) throws on that shape
    // and this whole function returns null, silently dropping the message.
    const senderId = message.from || message.from_user_id || contact?.user_id;
    if (!senderId) return null;
    const looksLikePhone = /^\+?\d+$/.test(senderId);
    const from = looksLikePhone ? `+${senderId.replace(/^\+/, '')}` : senderId;
    const profileName = contact?.profile?.name;
    const messageId = message.id;

    let text = '';
    let interactiveId = null;
    let interactiveTitle = null;
    let location = null;
    let type = message.type;

    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      const inter = message.interactive;
      if (inter?.type === 'button_reply') {
        interactiveId = inter.button_reply?.id;
        interactiveTitle = inter.button_reply?.title;
        text = interactiveTitle || '';
      } else if (inter?.type === 'list_reply') {
        interactiveId = inter.list_reply?.id;
        interactiveTitle = inter.list_reply?.title;
        text = interactiveTitle || '';
      }
    } else if (message.type === 'button') {
      text = message.button?.text || '';
    } else if (message.type === 'location') {
      const loc = message.location || {};
      if (loc.latitude != null && loc.longitude != null) {
        location = {
          latitude: loc.latitude,
          longitude: loc.longitude,
          name: loc.name || null,
          address: loc.address || null
        };
      }
    }

    return {
      channel: 'whatsapp',
      from: normalizeGhanaPhone(from) || from,
      profileName,
      messageId,
      type,
      text: String(text || '').trim(),
      interactiveId,
      interactiveTitle,
      location,
      raw: message,
      businessPhoneId: value.metadata?.phone_number_id
    };
  } catch (err) {
    logger.error('extractInbound failed: %s', err.message);
    return null;
  }
}

/**
 * Envelope confirmed against Meta's Instagram Messaging webhook docs:
 * entry[].messaging[] with sender.id / recipient.id, message.mid,
 * message.text, quick_reply.payload, and is_echo for business-sent echoes.
 * entry[].id is the IG Professional account id (used for tenant routing).
 */
function extractInstagramInbound(payload) {
  try {
    const entry = payload?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging) return null;
    const message = messaging.message;
    if (!message || message.is_echo) return null;

    const quickReplyId = message.quick_reply?.payload || null;
    const text = String(message.text || '').trim();

    return {
      channel: 'instagram',
      from: String(messaging.sender?.id || ''),
      profileName: null,
      messageId: message.mid || null,
      type: quickReplyId ? 'interactive' : 'text',
      text,
      interactiveId: quickReplyId,
      interactiveTitle: quickReplyId ? (text || null) : null,
      location: null,
      raw: messaging,
      igBusinessAccountId: String(messaging.recipient?.id || entry?.id || '')
    };
  } catch (err) {
    logger.error('extractInstagramInbound failed: %s', err.message);
    return null;
  }
}

/**
 * Envelope confirmed against Meta's Messenger Platform webhook docs:
 * entry[].messaging[] with sender.id / recipient.id, message.mid,
 * message.text, quick_reply.payload, and is_echo for Page-sent echoes —
 * the identical shape Instagram uses (same underlying Send/webhook API).
 * entry[].id is the Facebook Page id (used for tenant routing).
 */
function extractMessengerInbound(payload) {
  try {
    const entry = payload?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging) return null;
    const message = messaging.message;
    if (!message || message.is_echo) return null;

    const quickReplyId = message.quick_reply?.payload || null;
    const text = String(message.text || '').trim();

    return {
      channel: 'messenger',
      from: String(messaging.sender?.id || ''),
      profileName: null,
      messageId: message.mid || null,
      type: quickReplyId ? 'interactive' : 'text',
      text,
      interactiveId: quickReplyId,
      interactiveTitle: quickReplyId ? (text || null) : null,
      location: null,
      raw: messaging,
      messengerPageId: String(messaging.recipient?.id || entry?.id || '')
    };
  } catch (err) {
    logger.error('extractMessengerInbound failed: %s', err.message);
    return null;
  }
}

/* =================================================================
   Delivery status updates (sent → delivered → read, or failed)
   ================================================================= */

const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Apply Meta status webhooks to message_log so delivery failures are visible.
 * Only upgrades status (a late 'delivered' never overwrites 'read').
 */
async function handleStatuses(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const statuses = value?.statuses;
  if (!Array.isArray(statuses) || !statuses.length) return false;

  for (const st of statuses) {
    const rank = STATUS_RANK[st?.status];
    if (!st?.id || !rank) continue;
    try {
      await query(
        `UPDATE message_log
            SET status = $2
          WHERE wa_message_id = $1
            AND direction = 'outbound'
            AND (CASE status
                   WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                   WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0
                 END) < $3`,
        [st.id, st.status, rank]
      );
    } catch (err) {
      logger.warn('handleStatuses update failed for %s: %s', st.id, err.message);
    }
    if (st.status === 'failed') {
      logger.warn(
        'WhatsApp message %s to %s FAILED: %j',
        st.id, st.recipient_id, st.errors || []
      );
    }
  }
  return true;
}

/* =================================================================
   State helpers
   ================================================================= */

async function loadOrCreateState(customerId) {
  const existing = await query(
    `SELECT * FROM conversation_state WHERE customer_id = $1`,
    [customerId]
  );
  if (existing.rows.length) {
    if (new Date(existing.rows[0].expires_at) < new Date()) {
      await query(
        `UPDATE conversation_state
            SET current_flow = 'idle', current_step = 'start',
                flow_data = '{}'::jsonb,
                last_message_at = NOW(),
                expires_at = NOW() + INTERVAL '30 minutes'
          WHERE customer_id = $1`,
        [customerId]
      );
      return { customer_id: customerId, current_flow: 'idle', current_step: 'start', flow_data: {} };
    }
    return existing.rows[0];
  }
  // Two messages from a brand-new customer can land on two workers at once,
  // racing this insert. ON CONFLICT makes the loser return the row the winner
  // just created instead of throwing a unique-violation that aborts (and drops)
  // the webhook. DO UPDATE (not DO NOTHING) guarantees a row is always returned.
  const ins = await query(
    `INSERT INTO conversation_state (customer_id, current_flow, current_step, flow_data)
     VALUES ($1, 'idle', 'start', '{}'::jsonb)
     ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [customerId]
  );
  return ins.rows[0];
}

async function saveState(customerId, { flow, step, data }) {
  await query(
    `INSERT INTO conversation_state (customer_id, current_flow, current_step, flow_data, last_message_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW() + INTERVAL '30 minutes')
     ON CONFLICT (customer_id) DO UPDATE SET
       current_flow    = EXCLUDED.current_flow,
       current_step    = EXCLUDED.current_step,
       flow_data       = EXCLUDED.flow_data,
       last_message_at = NOW(),
       expires_at      = NOW() + INTERVAL '30 minutes',
       updated_at      = NOW()`,
    [customerId, flow, step, JSON.stringify(data || {})]
  );
}

async function resetState(customerId) {
  await saveState(customerId, { flow: 'idle', step: 'start', data: {} });
}

/**
 * Insert into message_log. Returns true if a NEW row was written, false if this
 * wa_message_id was already logged (duplicate inbound, processed before).
 * The unique index on message_log.wa_message_id is what enforces this.
 */
async function logInbound({ businessId, customerId, type, content, waMessageId }) {
  try {
    if (waMessageId) {
      const res = await query(
        `INSERT INTO message_log
          (business_id, customer_id, direction, message_type, content, wa_message_id, status)
         VALUES ($1,$2,'inbound',$3,$4,$5,'received')
         ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [businessId || null, customerId || null, type || 'text', content || '', waMessageId]
      );
      return res.rowCount > 0;
    }
    await query(
      `INSERT INTO message_log
        (business_id, customer_id, direction, message_type, content, wa_message_id, status)
       VALUES ($1,$2,'inbound',$3,$4,NULL,'received')`,
      [businessId || null, customerId || null, type || 'text', content || '']
    );
    return true;
  } catch (err) {
    logger.warn('logInbound failed: %s', err.message);
    return true; // best-effort: don't drop a real message because logging failed
  }
}

/* =================================================================
   Routing — top-level dispatcher
   ================================================================= */

async function handleInbound(payload, channel = 'whatsapp') {
  const inbound = extractInbound(payload, channel);
  if (!inbound) {
    logger.debug('Inbound payload had no message — likely a status update.');
    return;
  }

  // Instagram and Messenger are END-CUSTOMER commerce only: route by the
  // account/Page that received the message and go straight to the commerce
  // flow. The merchant SaaS billing flow stays WhatsApp-only, keyed on
  // business.whatsapp_number.
  if (inbound.channel === 'instagram') {
    const tenant = await getBusinessByIgAccountId(inbound.igBusinessAccountId);
    if (!tenant) {
      logger.warn(
        'IG inbound from %s on ig_business_account_id=%s — no matching tenant; dropping.',
        inbound.from, inbound.igBusinessAccountId
      );
      return;
    }
    return handleCommerce({ business: tenant, inbound });
  }

  if (inbound.channel === 'messenger') {
    const tenant = await getBusinessByMessengerPageId(inbound.messengerPageId);
    if (!tenant) {
      logger.warn(
        'Messenger inbound from %s on messenger_page_id=%s — no matching tenant; dropping.',
        inbound.from, inbound.messengerPageId
      );
      return;
    }
    return handleCommerce({ business: tenant, inbound });
  }

  const fromWa = inbound.from;
  const phoneNumberId = inbound.businessPhoneId;

  // Locate the tenant business by the Meta phone_number_id that RECEIVED
  // the message. This is the only reliable multi-tenant routing key —
  // never fall back to "first business", which would leak messages
  // between tenants.
  const tenant = await getBusinessByPhoneNumberId(phoneNumberId);
  if (!tenant) {
    logger.warn(
      'Inbound from %s on phone_number_id=%s — no matching tenant; dropping.',
      fromWa, phoneNumberId
    );
    return;
  }

  // SaaS billing flow only fires when the SENDER is the tenant's own owner
  // number AND no other tenant owns that sender. This blocks one tenant
  // from impersonating SaaS commands against another tenant's inbox.
  if (
    tenant.whatsapp_number === fromWa &&
    inbound.businessPhoneId &&
    tenant.wa_phone_number_id === inbound.businessPhoneId
  ) {
    return handleSaasBilling({ business: tenant, inbound });
  }

  // Otherwise this is an end-customer texting the SME — commerce flow.
  return handleCommerce({ business: tenant, inbound });
}

async function getBusinessByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const res = await query(
    `SELECT * FROM businesses WHERE wa_phone_number_id = $1 LIMIT 1`,
    [phoneNumberId]
  );
  return res.rows[0] || null;
}

async function getBusinessByIgAccountId(igAccountId) {
  if (!igAccountId) return null;
  const res = await query(
    `SELECT * FROM businesses WHERE ig_business_account_id = $1 LIMIT 1`,
    [igAccountId]
  );
  return res.rows[0] || null;
}

async function getBusinessByMessengerPageId(pageId) {
  if (!pageId) return null;
  const res = await query(
    `SELECT * FROM businesses WHERE messenger_page_id = $1 LIMIT 1`,
    [pageId]
  );
  return res.rows[0] || null;
}

/* =================================================================
   SaaS billing flow (SME ↔ platform)
   ================================================================= */

async function handleSaasBilling({ business, inbound }) {
  setBusinessId(business.id);
  const text = inbound.text;
  const upper = text.toUpperCase().trim();

  const isNew = await logInbound({
    businessId: business.id,
    type: inbound.type,
    content: text,
    waMessageId: inbound.messageId
  });
  if (!isNew) {
    logger.info('Duplicate inbound %s for business %s — skipping', inbound.messageId, business.id);
    return;
  }
  if (inbound.messageId) {
    await wa.markAsRead(inbound.messageId, { businessId: business.id, typing: true });
    await sleep(nextTypingDelay(`biz:${business.id}`));
  }

  if (upper === 'STATUS') return saasStatus(business);
  if (upper === 'PAY' || upper === 'RENEW' || upper === 'RETRY') return saasPay(business);
  if (upper === 'CANCEL') return saasCancelConfirm(business);
  if (upper === 'UPGRADE') return saasUpgradeMenu(business);
  if (upper === 'SUPPORT') return saasSupport(business);

  // Interactive reply: did they pick a plan during UPGRADE?
  if (inbound.interactiveId && inbound.interactiveId.startsWith('plan_')) {
    const planName = inbound.interactiveId.slice('plan_'.length);
    return saasUpgradeSelect(business, planName);
  }

  // Cancel confirmation buttons
  if (inbound.interactiveId === 'confirm_cancel') return saasCancel(business);
  if (inbound.interactiveId === 'keep_sub') {
    await wa.sendText(business.whatsapp_number,
      'Great — no changes made. Your subscription continues as normal. 👍',
      { businessId: business.id });
    return;
  }

  // Order status updates: merchant taps a status button…
  if (inbound.interactiveId && inbound.interactiveId.startsWith('ordst_')) {
    return merchantSetOrderStatus(business, inbound.interactiveId);
  }
  // …or replies with an order number to get the status buttons.
  const orderMatch = text.match(ORDER_NUMBER_RE);
  if (orderMatch) {
    return merchantShowOrder(business, orderMatch[0].toUpperCase());
  }

  return saasMenu(business);
}

/* ---------- Merchant order management by chat ---------- */

// Full fulfilment ladder a merchant can move an order through by chat.
// 'confirmed' matters for orders that reach the merchant before payment
// (e.g. cash orders created from the dashboard) — paid orders are already
// auto-confirmed by markOrderPaid, so this button just won't show for them.
const MERCHANT_STATUS_LABELS = {
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  delivered: 'Delivered'
};
const STATUS_LADDER_ORDER = ['pending', 'confirmed', 'preparing', 'ready', 'delivered'];

async function merchantShowOrder(business, orderNumber) {
  const order = await orderService.getOrderByNumber(orderNumber);
  if (!order || order.business_id !== business.id) {
    await wa.sendText(business.whatsapp_number,
      `No order *${orderNumber}* found for ${business.name}.`,
      { businessId: business.id });
    return;
  }
  const items = (Array.isArray(order.items) ? order.items : [])
    .map(i => `• ${i.quantity || 1}× ${i.name}`).join('\n') || '(no items)';
  const body =
`📋 Order *${order.order_number}*

${items}

Total: ${formatGhs(order.total_ghs)}
Payment: ${order.payment_status}
Status: *${order.status}*
Address: ${order.delivery_address || '—'}

Update the status:`;
  // Show the nearest next statuses first so the common case (advance one
  // step) is always a visible button, even when the ladder has more than
  // 3 remaining options (WhatsApp's button cap).
  const currentRank = STATUS_LADDER_ORDER.indexOf(order.status);
  const buttons = Object.entries(MERCHANT_STATUS_LABELS)
    .filter(([status]) => status !== order.status)
    .sort(([a], [b]) => {
      const da = Math.abs(STATUS_LADDER_ORDER.indexOf(a) - currentRank);
      const db = Math.abs(STATUS_LADDER_ORDER.indexOf(b) - currentRank);
      return da - db;
    })
    .slice(0, 3)
    .map(([status, label]) => ({ id: `ordst_${order.id}_${status}`, title: label }));
  await wa.sendButtons(business.whatsapp_number, body, buttons, { businessId: business.id });
}

async function merchantSetOrderStatus(business, interactiveId) {
  // ordst_<uuid>_<status>
  const rest = interactiveId.slice('ordst_'.length);
  const sep = rest.lastIndexOf('_');
  const orderId = rest.slice(0, sep);
  const newStatus = rest.slice(sep + 1);

  if (!MERCHANT_STATUS_LABELS[newStatus]) {
    await wa.sendText(business.whatsapp_number, 'That status is not available.', { businessId: business.id });
    return;
  }
  const order = await orderService.getOrderById(orderId);
  if (!order || order.business_id !== business.id) {
    await wa.sendText(business.whatsapp_number, 'Order not found.', { businessId: business.id });
    return;
  }
  if (order.status === 'cancelled') {
    await wa.sendText(business.whatsapp_number,
      `Order *${order.order_number}* is cancelled and can't be updated.`,
      { businessId: business.id });
    return;
  }

  const updated = await orderService.updateOrderStatus(order.id, newStatus);
  await notificationService.notifyOrderStatusChange({ order: updated, business });
  await wa.sendText(business.whatsapp_number,
    `✅ Order *${updated.order_number}* marked as *${newStatus}*. The customer has been notified.`,
    { businessId: business.id });
}

async function saasMenu(business) {
  const sub = await subService.getActiveSubscription(business.id);
  const planName = sub?.plan_display_name || 'No active plan';
  const status = sub?.status || business.status;

  const body =
`👋 Hello ${business.name || 'there'}!

Plan: *${planName}*
Status: *${status}*

Reply with one of:
• *PAY* — renew now
• *STATUS* — full subscription details
• *UPGRADE* — change plan
• *CANCEL* — cancel subscription
• *SUPPORT* — talk to a human`;
  await wa.sendButtons(business.whatsapp_number, body,
    [
      { id: 'PAY', title: 'Pay now' },
      { id: 'STATUS', title: 'Status' },
      { id: 'UPGRADE', title: 'Upgrade' }
    ],
    { businessId: business.id }
  );
}

async function saasStatus(business) {
  const sub = await subService.getActiveSubscription(business.id);
  if (!sub) {
    await wa.sendText(business.whatsapp_number,
      `You don't have a subscription yet. Reply *PAY* to choose a plan and activate.`,
      { businessId: business.id });
    return;
  }
  const lines = [
    `📊 Subscription`,
    ``,
    `Plan: *${sub.plan_display_name}*`,
    `Status: *${sub.status}*`,
    sub.current_period_end ? `Current period ends: ${formatDate(sub.current_period_end)}` : null,
    sub.next_billing_date ? `Next billing: ${formatDate(sub.next_billing_date)}` : null,
    sub.max_msgs_month ? `Message quota: ${sub.max_msgs_month === -1 ? 'unlimited' : sub.max_msgs_month + '/month'}` : null,
    ``,
    `Reply *PAY* to renew, *UPGRADE* to change plan.`
  ].filter(Boolean);
  await wa.sendText(business.whatsapp_number, lines.join('\n'), { businessId: business.id });
}

async function saasPay(business) {
  const sub = await subService.getActiveSubscription(business.id);
  let plan;
  if (sub) {
    plan = await subService.getPlanById(sub.plan_id);
  } else {
    plan = await subService.getPlanByName('starter');
  }
  if (!plan) {
    await wa.sendText(business.whatsapp_number, 'No plan available right now. Please contact support.',
      { businessId: business.id });
    return;
  }

  await wa.sendText(business.whatsapp_number,
    `Initiating MoMo charge for *${plan.display_name}* — ${formatGhs(plan.price_ghs)}.\n\nYou'll receive a MoMo prompt on ${business.whatsapp_number}. Approve it to activate.`,
    { businessId: business.id });

  const result = await subService.initiateRenewal({ business, plan });
  if (!result.success) {
    await wa.sendText(business.whatsapp_number,
      `⚠️ Could not start the MoMo charge: ${result.error || 'unknown error'}.\n\nReply *RETRY* to try again or *SUPPORT* for help.`,
      { businessId: business.id });
  }
}

async function saasCancelConfirm(business) {
  await wa.sendButtons(business.whatsapp_number,
    `⚠️ You're about to cancel your ${business.name || ''} subscription.\n\nYou'll keep access until the end of your paid period, then your shop stops taking orders.\n\nAre you sure?`,
    [
      { id: 'confirm_cancel', title: 'Yes, cancel' },
      { id: 'keep_sub', title: 'Keep my plan' }
    ],
    { businessId: business.id }
  );
}

async function saasCancel(business) {
  const result = await subService.cancelSubscription(business.id);
  let body;
  if (result.mode === 'period_end' && result.endsAt) {
    body =
`Your subscription is set to cancel on *${formatDate(result.endsAt)}*.\n\nYou'll keep full access until then. Reply *PAY* anytime to keep your subscription active.`;
  } else {
    body =
`Your subscription is now cancelled. Reply *PAY* anytime to reactivate.`;
  }
  await wa.sendText(business.whatsapp_number, body, { businessId: business.id });
}

async function saasUpgradeMenu(business) {
  const plans = await subService.listPlans();
  if (!plans.length) {
    await wa.sendText(business.whatsapp_number, 'No plans available right now. Please try again later.',
      { businessId: business.id });
    return;
  }
  const rows = plans.map(p => ({
    id: `plan_${p.name}`,
    title: `${p.display_name} — ${formatGhs(p.price_ghs)}`,
    description: truncate(planSummary(p), 72)
  }));
  await wa.sendList(
    business.whatsapp_number,
    'Choose a Plan',
    'Pick a plan that suits your business. Pricing is monthly via MoMo.',
    [{ title: 'Plans', rows }],
    { buttonLabel: 'View plans', businessId: business.id }
  );
}

function planSummary(p) {
  const parts = [];
  parts.push(`${p.max_msgs_month === -1 ? 'Unlimited' : p.max_msgs_month} msgs/mo`);
  if (p.analytics) parts.push('analytics');
  if (p.ai_replies) parts.push('AI replies');
  if (p.multi_agent) parts.push('multi-agent');
  return parts.join(' · ');
}

async function saasUpgradeSelect(business, planName) {
  const plan = await subService.getPlanByName(planName);
  if (!plan) {
    await wa.sendText(business.whatsapp_number, 'That plan is not available. Reply *UPGRADE* to see options.',
      { businessId: business.id });
    return;
  }
  await wa.sendText(business.whatsapp_number,
    `Selected *${plan.display_name}* — ${formatGhs(plan.price_ghs)}/month.\n\nInitiating MoMo charge…`,
    { businessId: business.id });

  const result = await subService.initiateRenewal({ business, plan });
  if (!result.success) {
    await wa.sendText(business.whatsapp_number,
      `⚠️ Could not start the MoMo charge: ${result.error || 'unknown error'}.`,
      { businessId: business.id });
  }
}

async function saasSupport(business) {
  await wa.sendText(business.whatsapp_number,
    `Our support team is on WhatsApp at ${SUPPORT_NUMBER}. Send them a message any time — they typically reply within an hour during business hours.`,
    { businessId: business.id });
}

/* =================================================================
   Commerce flow (end-customer ↔ SME)
   ================================================================= */

/**
 * A business can serve customers only if:
 *  - status is 'trial' AND trial has not expired, OR
 *  - status is 'active', OR
 *  - status is 'grace' (still within grace period before suspension)
 * Suspended/cancelled businesses are blocked.
 */
async function hasCommerceAccess(business) {
  if (!business) return false;
  if (business.status === 'suspended' || business.status === 'cancelled') return false;
  if (business.status === 'trial') {
    if (business.trial_ends_at && new Date(business.trial_ends_at) < new Date()) {
      return false;
    }
    return true;
  }
  if (business.status === 'active' || business.status === 'grace') return true;
  return false;
}

async function handleCommerce({ business, inbound }) {
  setBusinessId(business.id);
  const channel = inbound.channel || 'whatsapp';
  const isWhatsApp = channel === 'whatsapp';
  const network = isWhatsApp ? detectNetwork(inbound.from) : null;

  const customer = await orderService.getOrCreateCustomer({
    businessId: business.id,
    whatsappNumber: isWhatsApp ? inbound.from : undefined,
    displayName: inbound.profileName,
    phoneNetwork: network,
    channel,
    channelId: inbound.from
  });
  const ch = chOf(customer);
  const dest = destOf(customer);

  const isNew = await logInbound({
    businessId: business.id,
    customerId: customer.id,
    type: inbound.type,
    content: inbound.text,
    waMessageId: inbound.messageId
  });
  if (!isNew) {
    logger.info('Duplicate inbound %s for customer %s — skipping', inbound.messageId, customer.id);
    return;
  }
  if (inbound.messageId) {
    await ch.markAsRead(inbound.messageId, { businessId: business.id, customerId: customer.id, typing: true });
    await sleep(nextTypingDelay(`cust:${customer.id}`));
  }

  // Human takeover: a merchant is answering this customer from the dashboard
  // inbox. The state machine stays completely silent — the message is
  // already logged above, that's all the merchant needs.
  if (customer.bot_paused) {
    logger.debug('Bot paused for customer %s — skipping auto-reply', customer.id);
    push.pushToBusiness(business.id, {
      title: `💬 ${customer.display_name || customer.whatsapp_number || 'Customer'}`,
      body: (inbound.text || 'New message').slice(0, 200),
      data: { type: 'message', customer_id: customer.id }
    });
    return;
  }

  // Per-customer language: a confident signal in what they just typed
  // updates their stored preference; business.bot_language is mutated
  // in-memory (this `business` object is freshly fetched per request, never
  // shared/cached) so every langOf(business) call below — and in every
  // helper this request calls — picks it up without threading `customer`
  // through two dozen call sites.
  const detectedLang = detectLikelyLanguage(inbound.text);
  if (detectedLang && detectedLang !== customer.language_override) {
    customer.language_override = detectedLang;
    query('UPDATE customers SET language_override = $2 WHERE id = $1', [customer.id, detectedLang])
      .catch(err => logger.debug('language_override update failed: %s', err.message));
  }
  if (customer.language_override) business.bot_language = customer.language_override;

  // Abuse guard: replies stop past the cap; the customer's messages are
  // still logged above so nothing is lost, we just stop paying to answer.
  const rate = checkInboundRate(customer.id);
  if (rate === 'drop') {
    logger.warn('Rate-limited customer %s (business %s) — dropping reply', customer.id, business.id);
    return;
  }
  const lang = langOf(business);
  if (rate === 'warn') {
    await ch.sendText(dest, t(lang, 'slow_down'),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  // Enforce subscription/trial access before serving any commerce flow.
  if (!await hasCommerceAccess(business)) {
    await ch.sendText(dest, t(lang, 'shop_unavailable', { shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  // Business hours: outside the configured window the bot auto-replies with
  // the opening time instead of taking orders. Order-status lookups still work.
  if (!isWithinBusinessHours(business.open_time, business.close_time)) {
    const orderRef = (inbound.text || '').match(ORDER_NUMBER_RE);
    if (orderRef) {
      return customerOrderStatus({ business, customer, orderNumber: orderRef[0].toUpperCase() });
    }
    await ch.sendText(dest,
      t(lang, 'shop_closed', { shop: business.name, open: business.open_time }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const state = await loadOrCreateState(customer.id);

  // Instagram/Messenger text mode: both adapters send numbered text menus
  // instead of native buttons (chips vanish mid-conversation and never
  // render on desktop), so typed replies are translated here — BEFORE any
  // routing looks at the message — onto the same interactive ids the button
  // UI produces.
  //   "2"            → the 2nd option of the last menu we sent (ig_options)
  //   simple phrases → fixed en/tw vocabulary (nl.intent.js), business
  //                    context only; anything unknown falls through untouched.
  if (['instagram', 'messenger'].includes(customer.channel) && !inbound.interactiveId && inbound.text) {
    const step = state.current_step;
    // Steps where free text IS the answer — never reinterpret those.
    const freeTextSteps = ['get_address', 'momo_get_phone'];
    const typed = inbound.text.trim();

    const opts = Array.isArray(state.flow_data?.ig_options) ? state.flow_data.ig_options : [];
    if (!freeTextSteps.includes(step) && /^\d{1,2}$/.test(typed)) {
      const pick = opts[parseInt(typed, 10) - 1];
      if (pick) {
        inbound.interactiveId = String(pick.id);
        inbound.interactiveTitle = pick.title || null;
        inbound.type = 'interactive';
      }
    }

    if (!inbound.interactiveId && !freeTextSteps.includes(step)) {
      const allowProduct = state.current_flow === 'idle'
        || ['browse', 'await_more'].includes(step);
      const nl = detectIntent(inbound.text, { allowProduct });
      if (nl) {
        switch (nl.intent) {
          case 'GREET':
            await resetState(customer.id);
            return sendWelcome({ business, customer });
          case 'MENU': inbound.interactiveId = 'start_order'; break;
          case 'HELP': inbound.interactiveId = 'support_request'; break;
          case 'REPEAT': inbound.interactiveId = 'repeat_order'; break;
          case 'CHECKOUT': inbound.interactiveId = 'checkout'; break;
          case 'CANCEL': inbound.text = 'CANCEL'; break;
          case 'YES':
            if (step === 'confirm_order') inbound.interactiveId = 'confirm_pay';
            break;
          case 'NO':
            if (['confirm_order', 'cart_review', 'await_more'].includes(step)) {
              inbound.text = 'CANCEL';
            }
            break;
          case 'PRODUCT': {
            // Rewrite to the canonical "Nx name" the product matcher parses.
            inbound.text = nl.quantity > 1 ? `${nl.quantity}x ${nl.name}` : nl.name;
            // From idle, "I want jollof" starts an order with that item.
            if (state.current_flow === 'idle'
                && await tryTypedProductAdd({ business, customer, cart: [], inbound, page: 0 })) {
              return;
            }
            break;
          }
        }
      }
    }
  }

  const upper = (inbound.text || '').toUpperCase().trim();

  // Global commands
  if (['HI', 'HELLO', 'START', 'MENU'].includes(upper)) {
    // START doubles as "resubscribe" — idempotent no-op if not opted out.
    if (upper === 'START' && customer.opted_out) {
      await query('UPDATE customers SET opted_out = FALSE WHERE id = $1', [customer.id]);
    }
    await resetState(customer.id);
    return sendWelcome({ business, customer });
  }
  // STOP is WhatsApp's standard opt-out keyword — unsubscribes from broadcast
  // messages AND clears the cart, distinct from CANCEL (cart-only).
  if (upper === 'STOP') {
    await query('UPDATE customers SET opted_out = TRUE WHERE id = $1', [customer.id]);
    await resetState(customer.id);
    await ch.sendText(dest, t(lang, 'opted_out_confirm', { shop: business.name }), {
      businessId: business.id, customerId: customer.id
    });
    return;
  }
  if (upper === 'CANCEL') {
    await resetState(customer.id);
    await ch.sendText(dest, t(lang, 'cart_cleared'), {
      businessId: business.id, customerId: customer.id
    });
    return;
  }

  // "Talk to us" — hand the customer the business's direct contact.
  // Accept the tap payload OR the typed button label (see normalizeIntent).
  if (inbound.interactiveId === 'support_request'
      || titleMatches(inbound.text, 'btn_talk_to_us')) {
    return sendSupportContact({ business, customer, lastMessage: inbound.text });
  }

  // Payment retry / order cancel buttons work from ANY state (they arrive
  // after the flow state may have expired).
  if (inbound.interactiveId && inbound.interactiveId.startsWith('retrypay_')) {
    return retryOrderPayment({ business, customer, orderId: inbound.interactiveId.slice('retrypay_'.length) });
  }
  if (inbound.interactiveId && inbound.interactiveId.startsWith('cancelord_')) {
    return cancelUnpaidOrder({ business, customer, orderId: inbound.interactiveId.slice('cancelord_'.length) });
  }

  // Active flow routing
  if (state.current_flow === 'ordering') {
    return continueOrderingFlow({ business, customer, state, inbound });
  }

  if (state.current_flow === 'paying') {
    return continuePaymentFlow({ business, customer, state, inbound });
  }

  // Triggers from idle — tap payload, keyword, or typed button label.
  if (['ORDER', 'BUY', 'SHOP', 'ORDER NOW'].includes(upper)
      || inbound.interactiveId === 'start_order'
      || titleMatches(inbound.text, 'btn_order_now')) {
    return startOrderingFlow({ business, customer });
  }

  // Self-service order status: customer texts their order number.
  const orderRef = (inbound.text || '').match(ORDER_NUMBER_RE);
  if (orderRef) {
    return customerOrderStatus({ business, customer, orderNumber: orderRef[0].toUpperCase() });
  }

  // Reorder: rebuild the cart from the customer's last order.
  if (['REPEAT', 'REORDER'].includes(upper) || inbound.interactiveId === 'repeat_order'
      || titleMatches(inbound.text, 'btn_repeat')) {
    return reorderLastOrder({ business, customer });
  }

  // Referral: "REFERRAL <code>" self-links a brand-new customer to whoever
  // referred them; "MY CODE" hands back their own shareable code.
  const referralMatch = !inbound.interactiveId && /^REFERRAL\s+(\S+)/i.exec(inbound.text || '');
  if (referralMatch) {
    return applyReferralCode({ business, customer, code: referralMatch[1] });
  }
  if (upper === 'MY CODE' || upper === 'REFERRAL CODE') {
    return sendMyReferralCode({ business, customer });
  }

  // A question before the customer has even opened the menu ("Do you have
  // jollof?", "Anything below 50 cedis?") — answer it directly.
  if (!inbound.interactiveId && await tryProductInquiry({ business, customer, text: inbound.text })) {
    return;
  }

  // Default fallback
  return sendWelcome({ business, customer });
}

/**
 * Customer-facing order status lookup. Only reveals orders belonging to THIS
 * customer at THIS business — an order number alone is not proof of ownership.
 */
async function customerOrderStatus({ business, customer, orderNumber }) {
  const lang = langOf(business);
  const order = await orderService.getOrderByNumber(orderNumber);
  if (!order || order.business_id !== business.id || order.customer_id !== customer.id) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'order_not_found', { n: orderNumber, shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const items = (Array.isArray(order.items) ? order.items : [])
    .map(i => `• ${i.quantity || 1}× ${i.name}`).join('\n') || '(no items)';
  const statusKey = {
    pending: 'st_pending', confirmed: 'st_confirmed', paid: 'st_paid',
    preparing: 'st_preparing', ready: 'st_ready',
    delivered: 'st_delivered', cancelled: 'st_cancelled'
  }[order.status];
  await chOf(customer).sendText(destOf(customer),
    t(lang, 'order_card', {
      n: order.order_number,
      shop: business.name,
      items,
      total: formatGhs(order.total_ghs),
      payment: order.payment_status,
      status: statusKey ? t(lang, statusKey) : order.status
    }),
    { businessId: business.id, customerId: customer.id });

  // Unpaid orders (guest storefront checkouts land here, but so does any
  // WhatsApp order abandoned before payment) get the same pay-now buttons
  // retryOrderPayment already offers from the "retry payment" button — this
  // is what lets a storefront guest checkout's wa.me link, once tapped and
  // sent, drop the shopper straight into payment on this order.
  if (['unpaid', 'pending', 'failed'].includes(order.payment_status) && order.status !== 'cancelled') {
    await retryOrderPayment({ business, customer, orderId: order.id });
  }
}

/**
 * "REPEAT" — rebuild the cart from the last non-cancelled order, using
 * current prices and skipping items no longer in stock.
 */
async function reorderLastOrder({ business, customer }) {
  const lang = langOf(business);
  const last = await orderService.getLastOrderForCustomer(customer.id, business.id);
  const items = last && Array.isArray(last.items) ? last.items : [];
  if (!items.length) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'no_previous_order', { shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const ids = items.map(i => i.product_id).filter(Boolean);
  const res = ids.length
    ? await query(
        `SELECT id, name, price_ghs, in_stock FROM products
          WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [business.id, ids])
    : { rows: [] };
  const byId = new Map(res.rows.map(p => [p.id, p]));

  const cart = [];
  const dropped = [];
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (p && p.in_stock) {
      cart.push({
        product_id: p.id,
        name: p.name,
        price_ghs: Number(p.price_ghs),
        quantity: Math.max(1, Number(item.quantity) || 1)
      });
    } else {
      dropped.push(item.name);
    }
  }

  if (!cart.length) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'prev_items_unavailable'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (dropped.length) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'items_dropped', { list: dropped.join(', '), count: dropped.length }),
      { businessId: business.id, customerId: customer.id });
  }
  return showCartReview({ business, customer, cart });
}

/** Lazily assign this customer their own shareable referral code. */
async function getOrCreateReferralCode(customerId) {
  const existing = await query('SELECT referral_code FROM customers WHERE id = $1', [customerId]);
  if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      await query('UPDATE customers SET referral_code = $2 WHERE id = $1', [customerId, code]);
      return code;
    } catch (err) {
      if (err.code === '23505') continue; // UNIQUE collision — vanishingly rare, just retry
      throw err;
    }
  }
  throw new Error('Failed to allocate a unique referral code');
}

async function sendMyReferralCode({ business, customer }) {
  const lang = langOf(business, customer);
  const code = await getOrCreateReferralCode(customer.id);
  await chOf(customer).sendText(destOf(customer),
    t(lang, 'my_referral_code', { code, shop: business.name }),
    { businessId: business.id, customerId: customer.id });
}

/**
 * Self-reported referral link: a brand-new customer types "REFERRAL <code>"
 * to credit whoever sent them. Guards against abuse — only works before the
 * customer's first paid order, can't self-refer, and can only be set once.
 */
async function applyReferralCode({ business, customer, code }) {
  const lang = langOf(business, customer);
  const clean = String(code || '').trim().toUpperCase();

  if (customer.referred_by_customer_id) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'referral_already_linked'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const paidRes = await query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_status = 'paid'`,
    [customer.id]
  );
  if (paidRes.rows[0].n > 0) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'referral_not_new'),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const referrerRes = await query(
    'SELECT id FROM customers WHERE business_id = $1 AND referral_code = $2',
    [business.id, clean]
  );
  const referrer = referrerRes.rows[0];
  if (!referrer) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'referral_invalid'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (referrer.id === customer.id) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'referral_self'),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  await query('UPDATE customers SET referred_by_customer_id = $2 WHERE id = $1', [customer.id, referrer.id]);
  await chOf(customer).sendText(destOf(customer), t(lang, 'referral_applied', { shop: business.name }),
    { businessId: business.id, customerId: customer.id });
}

/**
 * "Talk to a human" handoff: pause the bot for this customer (so the state
 * machine goes silent — see the bot_paused check at the top of handleInbound)
 * and make sure the merchant actually notices, then reassure the customer.
 */
async function sendSupportContact({ business, customer, lastMessage }) {
  await query('UPDATE customers SET bot_paused = TRUE WHERE id = $1', [customer.id]);
  notificationService.notifyHumanHandoffRequested({ business, customer, lastMessage })
    .catch(err => logger.warn('human handoff notify failed: %s', err.message));
  await chOf(customer).sendText(destOf(customer),
    t(langOf(business), 'human_handoff', { shop: business.name }),
    { businessId: business.id, customerId: customer.id, previewUrl: false });
}

/**
 * Restart payment on an EXISTING order (from the retry button) instead of
 * making the customer rebuild their cart into a duplicate order.
 */
async function retryOrderPayment({ business, customer, orderId }) {
  const lang = langOf(business);
  const order = await orderService.getOrderById(orderId);
  if (!order || order.business_id !== business.id || order.customer_id !== customer.id) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'order_gone'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.payment_status === 'paid') {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'order_already_paid', { n: order.order_number }),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.status === 'cancelled') {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'order_was_cancelled', { n: order.order_number }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  await saveState(customer.id, {
    flow: 'paying',
    step: 'choose_method',
    data: { order_id: order.id, order_number: order.order_number, total: order.total_ghs }
  });
  await chOf(customer).sendButtons(destOf(customer),
    t(lang, 'finish_paying', { n: order.order_number, total: formatGhs(order.total_ghs) }),
    [
      { id: 'pay_momo', title: t(lang, 'btn_momo') },
      { id: 'pay_card', title: t(lang, 'btn_card') },
      { id: 'cancel_order', title: t(lang, 'btn_cancel') }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

async function cancelUnpaidOrder({ business, customer, orderId }) {
  const lang = langOf(business);
  const order = await orderService.getOrderById(orderId);
  if (!order || order.business_id !== business.id || order.customer_id !== customer.id) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'order_gone'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.payment_status === 'paid') {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'cannot_cancel_paid', { n: order.order_number, shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  await orderService.updateOrderStatus(order.id, 'cancelled');
  notificationService.notifyOrderCancelled({ order, business, customer });
  await resetState(customer.id);
  await chOf(customer).sendText(destOf(customer),
    t(lang, 'order_cancelled_ok', { n: order.order_number }),
    { businessId: business.id, customerId: customer.id });
}

async function sendWelcome({ business, customer }) {
  // Merchants can brand their greeting from the dashboard; the stock copy is
  // only the fallback. The action buttons are always appended.
  const lang = langOf(business);
  const greeting = String(business.welcome_message || '').trim();
  const body = greeting
    ? `${greeting.slice(0, 900)}\n\n${t(lang, 'welcome_custom_suffix')}`
    : t(lang, 'welcome_default', { shop: business.name });
  const buttons = [
    { id: 'start_order', title: t(lang, 'btn_order_now') },
    { id: 'support_request', title: t(lang, 'btn_talk_to_us') }
  ];
  if (Number(customer.total_orders) > 0) {
    buttons.push({ id: 'repeat_order', title: t(lang, 'btn_repeat') });
  }
  await chOf(customer).sendButtons(destOf(customer), body, buttons,
    { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 1 (browse) ---------- */

/**
 * Show the product menu. CARRIES THE EXISTING CART FORWARD — "Add more" and
 * "Continue shopping" must never wipe what the customer already picked.
 * WhatsApp allows max 10 list rows total, so long catalogs are paginated
 * with prev/next rows (handled via `menu_page_<n>` interactive ids).
 */
/**
 * The full "what can a customer currently see" product set: in stock, not
 * hidden (product or category), and inside its availability window if it
 * has one. Shared by the menu, NL product search, and the typed-add
 * fallback so an inquiry can never reveal something the menu itself hides.
 */
async function fetchVisibleProducts(businessId) {
  const products = await query(
    `SELECT p.id, p.name, p.description, p.price_ghs, p.category,
            p.featured, p.available_from, p.available_to
       FROM products p
       LEFT JOIN categories c ON c.business_id = p.business_id AND lower(c.name) = lower(p.category)
      WHERE p.business_id = $1 AND p.in_stock = TRUE AND p.hidden = FALSE
        AND COALESCE(c.hidden, FALSE) = FALSE
      ORDER BY p.featured DESC, COALESCE(c.sort_order, 0) ASC, p.category ASC, p.sort_order ASC, p.name ASC
      LIMIT 200`,
    [businessId]
  );
  // Availability windows (e.g. a breakfast menu, 07:00-11:00) are time-zone
  // sensitive, so filter in JS with the same Africa/Accra helper business
  // hours already use, rather than juggling SQL time-zone conversions.
  return products.rows.filter(p => isWithinBusinessHours(p.available_from, p.available_to));
}

async function startOrderingFlow({ business, customer, page = 0 }) {
  const lang = langOf(business);
  const available = await fetchVisibleProducts(business.id);
  if (!available.length) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'no_products', { shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  // Preserve any in-flight cart across menu views.
  const state = await loadOrCreateState(customer.id);
  const cart = Array.isArray(state.flow_data?.cart) ? state.flow_data.cart : [];

  const menu = buildMenuPage(available, page);
  const sections = [{
    title: menu.totalPages > 1 ? `Menu ${menu.page + 1}/${menu.totalPages}` : 'Menu',
    rows: menu.rows
  }];

  await saveState(customer.id, {
    flow: 'ordering',
    step: 'browse',
    data: { cart, menu_page: menu.page }
  });

  let cartNote = cart.length
    ? t(lang, 'cart_note', { count: cart.reduce((n, i) => n + (i.quantity || 1), 0) })
    : '';
  // "Your usual" only on the very first browse of a fresh cart — repeating
  // it on every page flip or after items are added would just be noise.
  if (page === 0 && !cart.length) {
    try {
      const top = await orderService.getTopOrderedItem(customer.id);
      if (top && available.some(p => p.name.toLowerCase() === top.name.toLowerCase())) {
        cartNote += t(lang, 'usual_hint', { name: top.name });
      }
    } catch (err) {
      logger.debug('usual-item lookup failed: %s', err.message);
    }
  }
  await chOf(customer).sendList(
    destOf(customer),
    t(lang, 'menu_title', { shop: business.name }),
    t(lang, 'menu_body', { cartNote }),
    sections,
    { buttonLabel: t(lang, 'btn_view_menu'), businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Ordering: routing while in flow ---------- */

async function continueOrderingFlow({ business, customer, state, inbound }) {
  const lang = langOf(business);
  const data = state.flow_data || {};
  const cart = Array.isArray(data.cart) ? data.cart : [];
  const promoCode = data.promo_code || null;
  const upper = (inbound.text || '').toUpperCase().trim();

  // Promo code entry: "PROMO SAVE10" works from cart review through order
  // confirmation — anywhere the customer has an active cart.
  const promoMatch = !inbound.interactiveId && cart.length
    && (inbound.text || '').match(/^PROMO\s+(\S+)/i);
  if (promoMatch && ['cart_review', 'confirm_order'].includes(state.current_step)) {
    return applyPromoCode({ business, customer, state, cart, code: promoMatch[1] });
  }

  // Menu pagination rows
  if (inbound.interactiveId && inbound.interactiveId.startsWith('menu_page_')) {
    const page = parseInt(inbound.interactiveId.slice('menu_page_'.length), 10) || 0;
    return startOrderingFlow({ business, customer, page });
  }

  // Selecting a product from list
  if (inbound.interactiveId && inbound.interactiveId.startsWith('prod_')) {
    const productId = inbound.interactiveId.slice('prod_'.length);
    return addProductToCart({ business, customer, productId, cart });
  }

  // Picking a variant (size/color/flavor/bundle) for a product that has them
  if (state.current_step === 'choose_variant') {
    let variantInteractiveId = inbound.interactiveId;
    if (!variantInteractiveId) {
      // Typed fallback (Instagram / re-typed number): a bare number picks
      // the Nth variant from the list this step just sent.
      const options = Array.isArray(data.pending_variant_options) ? data.pending_variant_options : [];
      const n = /^\d{1,2}$/.test(upper) ? parseInt(upper, 10) : NaN;
      if (n >= 1 && n <= options.length) variantInteractiveId = `variant_${options[n - 1]}`;
    }
    if (variantInteractiveId) {
      return chooseVariant({ business, customer, state, interactiveId: variantInteractiveId });
    }
    return startOrderingFlow({ business, customer });
  }

  // Typed multi-select of add-ons ("1,3" or "0" for none)
  if (state.current_step === 'choose_addons' && !inbound.interactiveId) {
    return chooseAddons({ business, customer, state, text: inbound.text });
  }

  // After adding, ask "Add more or checkout?"
  if (state.current_step === 'await_more') {
    if (inbound.interactiveId === 'add_more' || upper === 'ADD MORE' || upper === 'MORE'
        || titleMatches(inbound.text, 'btn_add_more')) {
      return startOrderingFlow({ business, customer });
    }
    if (inbound.interactiveId === 'checkout' || upper === 'CHECKOUT'
        || titleMatches(inbound.text, 'btn_checkout')) {
      return showCartReview({ business, customer, cart, promoCode });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL'
        || titleMatches(inbound.text, 'btn_cancel')) {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), t(lang, 'order_cancelled_menu'),
        { businessId: business.id, customerId: customer.id });
      return;
    }
    // A question ("Anything below 50 cedis?") gets answered without
    // touching the cart or derailing the add-more/checkout prompt.
    if (!inbound.interactiveId && await tryProductInquiry({ business, customer, text: inbound.text })) {
      return;
    }
    // Typing another item ("2x Jollof" or just "Jollof") keeps ordering.
    if (!inbound.interactiveId
        && await tryTypedProductAdd({ business, customer, cart, inbound, page: data.menu_page || 0 })) {
      return;
    }
    return promptAddMoreOrCheckout({ business, customer });
  }

  if (state.current_step === 'cart_review') {
    if (inbound.interactiveId === 'continue_shop' || upper === 'CONTINUE SHOPPING'
        || titleMatches(inbound.text, 'btn_add_more', 'btn_continue')) {
      return startOrderingFlow({ business, customer });
    }
    if (inbound.interactiveId === 'checkout' || upper === 'CHECKOUT'
        || titleMatches(inbound.text, 'btn_checkout')) {
      return askForAddress({ business, customer, promoCode });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL'
        || titleMatches(inbound.text, 'btn_cancel')) {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), t(lang, 'order_cancelled_menu'),
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  if (state.current_step === 'get_address') {
    return captureAddress({ business, customer, cart, address: inbound.text, location: inbound.location, promoCode });
  }

  if (state.current_step === 'choose_zone') {
    const zones = deliveryZonesOf(business);
    let zone = null;
    if (inbound.interactiveId && inbound.interactiveId.startsWith('zone_')) {
      zone = zones[parseInt(inbound.interactiveId.slice('zone_'.length), 10)] || null;
    } else if (inbound.text) {
      // Typed fallback (Instagram chips are gone once anything else is sent):
      // a bare number picks the Nth zone, otherwise match the zone name.
      const n = /^\d{1,2}$/.test(upper) ? parseInt(upper, 10) : NaN;
      zone = (n >= 1 && n <= zones.length)
        ? zones[n - 1]
        : zones.find(z => normalizeIntent(z.name) === normalizeIntent(inbound.text)) || null;
    }
    if (zone) {
      return showOrderConfirm({
        business, customer, cart,
        address: data.delivery_address,
        fee: zone.fee_ghs,
        zoneName: zone.name,
        promoCode
      });
    }
    return askForDeliveryZone({ business, customer, cart, address: data.delivery_address, promoCode });
  }

  if (state.current_step === 'confirm_order') {
    if (inbound.interactiveId === 'confirm_pay' || upper === 'CONFIRM & PAY' || upper === 'CONFIRM'
        || titleMatches(inbound.text, 'btn_confirm_pay')) {
      return finalizeOrderAndStartPayment({ business, customer, state });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL'
        || titleMatches(inbound.text, 'btn_cancel')) {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), t(lang, 'order_cancelled_menu'),
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  // A question ("Do you have spicy rice?") gets answered in place.
  if (!inbound.interactiveId && state.current_step === 'browse'
      && await tryProductInquiry({ business, customer, text: inbound.text })) {
    return;
  }

  // Typed product picks while browsing: "2x Jollof" or just "Jollof".
  if (!inbound.interactiveId && state.current_step === 'browse'
      && await tryTypedProductAdd({ business, customer, cart, inbound, page: data.menu_page || 0 })) {
    return;
  }

  // Fallback while in flow
  return showCartReview({ business, customer, cart, promoCode });
}

/**
 * Typed product selection: "2x Jollof" (explicit quantity) or a bare product
 * name ("Jollof"). Returns true when the message was handled. This is the
 * only path back into the menu on Instagram once the flattened quick-reply
 * chips are gone — IG has no list messages, chips vanish after the next
 * message, and they never render on desktop.
 *
 * A bare name that matches nothing returns false so the caller's own
 * re-prompt runs; an explicit "2x ..." that matches nothing gets a
 * product-not-found reply plus the menu (the customer clearly meant to order).
 */
async function tryTypedProductAdd({ business, customer, cart, inbound, page = 0 }) {
  const explicit = parseQuantityExpression(inbound.text);
  const name = explicit ? explicit.name : String(inbound.text || '').trim();
  if (!name || name.length < 3) return false;

  // Fuzzy match (typo tolerance + synonyms) against the same visible-product
  // set the menu itself shows — a customer typing "waachy" or "kelly welly"
  // still lands on the right item.
  const visible = await fetchVisibleProducts(business.id);
  const [hit] = fuzzyMatchProducts(name, visible, { maxResults: 1 });
  if (hit) {
    await addProductToCart({
      business, customer, productId: hit.id, cart,
      quantity: explicit ? explicit.quantity : 1
    });
    return true;
  }
  if (explicit) {
    const lang = langOf(business);
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'product_not_found', { name }),
      { businessId: business.id, customerId: customer.id });
    await startOrderingFlow({ business, customer, page });
    return true;
  }
  return false;
}

/**
 * Answer a natural-language product question ("Do you have spicy rice?",
 * "Anything below 50 cedis?") without touching the cart — these are
 * inquiries, not add-to-cart actions. Falls through (returns false) for
 * anything that doesn't look like a question so the caller's normal
 * add/re-prompt logic still runs.
 */
async function tryProductInquiry({ business, customer, text }) {
  const parsed = detectProductQuery(text);
  if (!parsed) return false;

  const lang = langOf(business);
  const visible = await fetchVisibleProducts(business.id);

  let matches;
  if (parsed.type === 'availability') {
    matches = fuzzyMatchProducts(parsed.term, visible, { maxResults: 5 });
  } else if (parsed.type === 'price_below') {
    matches = visible.filter(p => Number(p.price_ghs) <= parsed.max);
  } else if (parsed.type === 'price_above') {
    matches = visible.filter(p => Number(p.price_ghs) >= parsed.min);
  } else if (parsed.type === 'price_between') {
    matches = visible.filter(p => Number(p.price_ghs) >= parsed.min && Number(p.price_ghs) <= parsed.max);
  } else {
    return false;
  }

  if (!matches.length) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'product_query_none', { shop: business.name }),
      { businessId: business.id, customerId: customer.id });
    return true;
  }

  const list = matches.slice(0, 8).map(p => `• ${p.name} — ${formatGhs(p.price_ghs)}`).join('\n');
  await chOf(customer).sendText(destOf(customer), t(lang, 'product_query_results', { list }),
    { businessId: business.id, customerId: customer.id });
  return true;
}

async function addProductToCart({ business, customer, productId, cart, quantity = 1 }) {
  const lang = langOf(business);
  const res = await query(`SELECT * FROM products WHERE id = $1 AND business_id = $2`, [productId, business.id]);
  const product = res.rows[0];
  if (!product) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'item_gone'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (!product.in_stock) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'out_of_stock', { name: product.name }),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const qty = Math.min(99, Math.max(1, Number(quantity) || 1));

  // Products with variants (size/color/flavor/bundle) can't be added
  // straight to the cart — the customer picks one first. This is the only
  // branch point: a product with no variants behaves exactly as before.
  const variantsRes = await query(
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC, name ASC`,
    [product.id]
  );
  if (variantsRes.rows.length) {
    return askForVariant({ business, customer, cart, product, variants: variantsRes.rows, quantity: qty });
  }

  return addResolvedItemToCart({ business, customer, cart, product, quantity: qty });
}

/**
 * Sends the variant list. WhatsApp list rows top out at 10, so a product
 * with more than 10 variants keeps only the first 10 — rare in practice for
 * size/color/flavor style choices, but worth a debug log if it happens.
 */
async function askForVariant({ business, customer, cart, product, variants, quantity }) {
  const lang = langOf(business);
  if (variants.length > 10) {
    logger.debug('product %s has %d variants — truncating to 10 for the WhatsApp list', product.id, variants.length);
  }
  const limited = variants.slice(0, 10);
  await saveState(customer.id, {
    flow: 'ordering',
    step: 'choose_variant',
    data: {
      cart, pending_product_id: product.id, pending_quantity: quantity,
      pending_variant_options: limited.map(v => v.id)
    }
  });
  const rows = limited.map(v => ({
    id: `variant_${v.id}`,
    title: truncate(v.name, 24),
    description: formatGhs(Number(product.price_ghs) + Number(v.price_delta_ghs))
  }));
  await chOf(customer).sendList(
    destOf(customer),
    t(lang, 'variant_header', { name: product.name }),
    t(lang, 'variant_body'),
    [{ title: product.name, rows }],
    { buttonLabel: t(lang, 'btn_choose_option'), businessId: business.id, customerId: customer.id }
  );
}

async function chooseVariant({ business, customer, state, interactiveId }) {
  const lang = langOf(business);
  const data = state.flow_data || {};
  const cart = Array.isArray(data.cart) ? data.cart : [];
  const variantId = interactiveId && interactiveId.startsWith('variant_')
    ? interactiveId.slice('variant_'.length) : null;

  if (!variantId || !data.pending_product_id) {
    return startOrderingFlow({ business, customer });
  }

  const [productRes, variantRes] = await Promise.all([
    query('SELECT * FROM products WHERE id = $1 AND business_id = $2', [data.pending_product_id, business.id]),
    query('SELECT * FROM product_variants WHERE id = $1 AND product_id = $2', [variantId, data.pending_product_id])
  ]);
  const product = productRes.rows[0];
  const variant = variantRes.rows[0];
  if (!product || !variant) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'item_gone'),
      { businessId: business.id, customerId: customer.id });
    return startOrderingFlow({ business, customer });
  }
  if (variant.stock_qty !== null && variant.stock_qty <= 0) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'variant_out_of_stock', { name: `${product.name} (${variant.name})` }),
      { businessId: business.id, customerId: customer.id });
    return askForVariant({
      business, customer, cart, product,
      variants: (await query('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC, name ASC', [product.id])).rows,
      quantity: data.pending_quantity || 1
    });
  }

  return addResolvedItemToCart({
    business, customer, cart, product, variant,
    quantity: data.pending_quantity || 1
  });
}

/**
 * After a product (and its variant, if any) is resolved, offer add-ons —
 * these are typed multi-select (WhatsApp list/button messages are
 * single-select only, and this also keeps Instagram, which has no
 * interactive lists, working the same way).
 */
async function addResolvedItemToCart({ business, customer, cart, product, variant = null, quantity }) {
  const addonsRes = await query(
    `SELECT * FROM product_addons WHERE product_id = $1 ORDER BY sort_order ASC, name ASC LIMIT 20`,
    [product.id]
  );
  if (addonsRes.rows.length) {
    return askForAddons({ business, customer, cart, product, variant, quantity, addons: addonsRes.rows });
  }
  return finalizeCartAdd({ business, customer, cart, product, variant, addons: [], quantity });
}

async function askForAddons({ business, customer, cart, product, variant, quantity, addons }) {
  const lang = langOf(business);
  await saveState(customer.id, {
    flow: 'ordering',
    step: 'choose_addons',
    data: {
      cart,
      pending_product_id: product.id,
      pending_variant_id: variant ? variant.id : null,
      pending_quantity: quantity,
      pending_addon_options: addons.map(a => ({ id: a.id, name: a.name, price_ghs: Number(a.price_ghs) }))
    }
  });
  const lines = addons.map((a, i) => `${i + 1}. ${a.name} — ${formatGhs(a.price_ghs)}`).join('\n');
  await chOf(customer).sendText(destOf(customer),
    t(lang, 'addon_prompt', { name: product.name, lines }),
    { businessId: business.id, customerId: customer.id });
}

async function chooseAddons({ business, customer, state, text }) {
  const lang = langOf(business);
  const data = state.flow_data || {};
  const cart = Array.isArray(data.cart) ? data.cart : [];
  const options = Array.isArray(data.pending_addon_options) ? data.pending_addon_options : [];

  const raw = String(text || '').trim();
  let chosen = [];
  if (raw !== '0' && raw !== '') {
    const indices = raw.split(',').map(s => parseInt(s.trim(), 10));
    const valid = indices.every(n => Number.isInteger(n) && n >= 1 && n <= options.length);
    if (!valid || !indices.length) {
      await chOf(customer).sendText(destOf(customer), t(lang, 'addon_invalid'),
        { businessId: business.id, customerId: customer.id });
      return;
    }
    chosen = [...new Set(indices)].map(n => options[n - 1]);
  }

  const [productRes, variantRes] = await Promise.all([
    query('SELECT * FROM products WHERE id = $1 AND business_id = $2', [data.pending_product_id, business.id]),
    data.pending_variant_id
      ? query('SELECT * FROM product_variants WHERE id = $1', [data.pending_variant_id])
      : Promise.resolve({ rows: [] })
  ]);
  const product = productRes.rows[0];
  if (!product) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'item_gone'),
      { businessId: business.id, customerId: customer.id });
    return startOrderingFlow({ business, customer });
  }
  const variant = variantRes.rows[0] || null;

  return finalizeCartAdd({
    business, customer, cart, product, variant, addons: chosen,
    quantity: data.pending_quantity || 1
  });
}

async function finalizeCartAdd({ business, customer, cart, product, variant, addons = [], quantity }) {
  const qty = Math.min(99, Math.max(1, Number(quantity) || 1));
  const addonsTotal = addons.reduce((sum, a) => sum + Number(a.price_ghs), 0);
  const unitPrice = Number(product.price_ghs) + (variant ? Number(variant.price_delta_ghs) : 0) + addonsTotal;
  const displayName = variant ? `${product.name} (${variant.name})` : product.name;
  const addonSuffix = addons.length ? ` + ${addons.map(a => a.name).join(', ')}` : '';

  // Variant/add-on combinations are distinct cart lines — merging "Large +
  // extra sauce" into a plain "Large" line would silently drop the add-on.
  const existing = cart.find(c =>
    c.product_id === product.id &&
    (c.variant_id || null) === (variant ? variant.id : null) &&
    JSON.stringify((c.addon_ids || []).slice().sort()) === JSON.stringify(addons.map(a => a.id).sort())
  );
  if (existing) {
    existing.quantity = (existing.quantity || 1) + qty;
  } else {
    cart.push({
      product_id: product.id,
      name: displayName + addonSuffix,
      price_ghs: Number(unitPrice.toFixed(2)),
      quantity: qty,
      variant_id: variant ? variant.id : undefined,
      variant_name: variant ? variant.name : undefined,
      addon_ids: addons.length ? addons.map(a => a.id) : undefined,
      addons: addons.length ? addons.map(a => ({ id: a.id, name: a.name, price_ghs: Number(a.price_ghs) })) : undefined
    });
  }

  // Product photo sells food better than text — send it with the add
  // confirmation when the merchant has uploaded one. Best-effort only.
  if (product.image_url && typeof chOf(customer).sendImage === 'function') {
    try {
      await chOf(customer).sendImage(destOf(customer), product.image_url,
        `${displayName} — ${formatGhs(unitPrice)}`,
        { businessId: business.id, customerId: customer.id });
    } catch (err) {
      logger.debug('product image send failed: %s', err.message);
    }
  }

  await saveState(customer.id, { flow: 'ordering', step: 'await_more', data: { cart } });
  await promptAddMoreOrCheckout({
    business, customer,
    justAdded: qty > 1 ? `${qty}× ${displayName}` : displayName,
    upsell: await buildUpsellHint({ business, cart, product, variant })
  });
}

/**
 * One short upsell line, or null: a variant upgrade takes priority over a
 * frequently-bought-together suggestion (both would be noisy together).
 * Best-effort — a failure here must never block the add-to-cart flow.
 */
async function buildUpsellHint({ business, cart, product, variant }) {
  try {
    if (variant) {
      const variantsRes = await query(
        'SELECT name, price_delta_ghs FROM product_variants WHERE product_id = $1',
        [product.id]
      );
      const upgrade = pickVariantUpgrade(variant, variantsRes.rows);
      if (upgrade) {
        const delta = Number(upgrade.price_delta_ghs) - Number(variant.price_delta_ghs);
        return t(langOf(business), 'upsell_variant', { name: upgrade.name, delta: formatGhs(delta) });
      }
    }
    const cartNames = cart.map(i => i.name);
    const coRows = await orderService.getFrequentlyBoughtWith(business.id, cartNames);
    if (coRows.length) {
      const visible = await fetchVisibleProducts(business.id);
      const pick = pickFrequentlyBoughtSuggestion(coRows, visible, cartNames);
      if (pick) return t(langOf(business), 'upsell_frequently_bought', { name: pick.name });
    }
  } catch (err) {
    logger.debug('buildUpsellHint failed: %s', err.message);
  }
  return null;
}

async function promptAddMoreOrCheckout({ business, customer, justAdded, upsell }) {
  const lang = langOf(business);
  let body = justAdded
    ? t(lang, 'added_prompt', { name: justAdded })
    : t(lang, 'add_or_checkout');
  if (upsell) body += `\n\n${upsell}`;
  await chOf(customer).sendButtons(destOf(customer), body,
    [
      { id: 'add_more', title: t(lang, 'btn_add_more') },
      { id: 'checkout', title: t(lang, 'btn_checkout') },
      { id: 'cancel_order', title: t(lang, 'btn_cancel') }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Ordering: STEP 2 (cart review) ---------- */

async function showCartReview({ business, customer, cart, promoCode }) {
  const lang = langOf(business);
  if (!cart || cart.length === 0) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'cart_empty'),
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }
  let promo = promoCode ? (await orderService.validatePromoCode(business.id, promoCode, customer.id, cart)).promo : null;

  // Auto-apply the best available discount when the customer hasn't typed a
  // code themselves — once applied it's stored on the flow state, so this
  // only ever fires the FIRST time cart review is shown for a given cart.
  let autoApplied = null;
  if (!promo) {
    promo = await orderService.findBestApplicablePromo(business.id, customer.id, cart);
    if (promo) autoApplied = promo;
  }

  const totals = orderService.computeTotals(cart, 0, promo);
  let lines = cart.map(i => `• ${i.quantity}× ${i.name} — ${formatGhs(i.price_ghs * i.quantity)}`).join('\n');

  if (autoApplied) {
    lines += `\n\n${t(lang, 'promo_auto_applied', { code: autoApplied.code, discount: formatGhs(totals.discount_ghs) })}`;
  }

  const upsell = await buildUpsellHint({ business, cart, product: {}, variant: null });
  if (upsell) lines += `\n\n${upsell}`;

  await saveState(customer.id, { flow: 'ordering', step: 'cart_review', data: { cart, promo_code: promo ? promo.code : null } });
  await chOf(customer).sendButtons(destOf(customer),
    t(lang, 'cart_review', {
      lines,
      subtotal: promo ? formatGhs(totals.total_ghs) : formatGhs(totals.subtotal_ghs)
    }), [
    { id: 'continue_shop', title: t(lang, 'btn_continue') },
    { id: 'checkout', title: t(lang, 'btn_checkout') },
    { id: 'cancel_order', title: t(lang, 'btn_cancel') }
  ], { businessId: business.id, customerId: customer.id });
}

/**
 * "PROMO <code>" command — validates and applies (or clears, on failure) a
 * discount code, re-validating fresh each time rather than trusting whatever
 * was stored earlier, since a code can expire or hit its usage cap mid-flow.
 */
async function applyPromoCode({ business, customer, state, cart, code }) {
  const lang = langOf(business);
  const { promo, error } = await orderService.validatePromoCode(business.id, code, customer.id, cart);
  if (error) {
    const key = PROMO_ERROR_KEYS[error] || 'promo_invalid';
    await chOf(customer).sendText(destOf(customer), t(lang, key),
      { businessId: business.id, customerId: customer.id });
  } else {
    const totals = orderService.computeTotals(cart, 0, promo);
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'promo_applied', { code: promo.code, discount: formatGhs(totals.discount_ghs), total: formatGhs(totals.total_ghs) }),
      { businessId: business.id, customerId: customer.id });
  }

  const promoCode = promo ? promo.code : null;
  if (state.current_step === 'confirm_order') {
    const data = state.flow_data || {};
    return showOrderConfirm({
      business, customer, cart,
      address: data.delivery_address,
      fee: data.delivery_fee,
      zoneName: data.delivery_zone,
      promoCode
    });
  }
  return showCartReview({ business, customer, cart, promoCode });
}

/* ---------- Ordering: STEP 3 (delivery address) ---------- */

async function askForAddress({ business, customer, promoCode }) {
  const state = await loadOrCreateState(customer.id);
  const cart = state.flow_data?.cart || [];
  await saveState(customer.id, { flow: 'ordering', step: 'get_address', data: { cart, promo_code: promoCode || null } });
  await chOf(customer).sendText(destOf(customer),
    t(langOf(business), 'ask_address'),
    { businessId: business.id, customerId: customer.id });
}

/**
 * Parse businesses.delivery_zones (JSONB) into a clean [{ name, fee_ghs }] list.
 */
function deliveryZonesOf(business) {
  const raw = Array.isArray(business.delivery_zones) ? business.delivery_zones : [];
  return raw
    .filter(z => z && typeof z.name === 'string' && z.name.trim() && Number.isFinite(Number(z.fee_ghs)) && Number(z.fee_ghs) >= 0)
    .slice(0, 9)
    .map(z => ({ name: z.name.trim(), fee_ghs: Number(Number(z.fee_ghs).toFixed(2)) }));
}

async function captureAddress({ business, customer, cart, address, location, promoCode }) {
  let trimmed = String(address || '').trim();
  // A shared WhatsApp location pin is a perfectly good delivery address.
  if (location) {
    const label = [location.name, location.address].filter(Boolean).join(', ');
    const maps = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
    trimmed = label ? `${label} (pin: ${maps})` : `Pinned location: ${maps}`;
  }
  if (trimmed.length < 5) {
    await chOf(customer).sendText(destOf(customer),
      t(langOf(business), 'address_short'),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  // Zones configured → let the customer pick one (per-zone fee); otherwise
  // apply the business's flat delivery fee (0 if unset).
  const zones = deliveryZonesOf(business);
  if (zones.length) {
    return askForDeliveryZone({ business, customer, cart, address: trimmed, promoCode });
  }
  return showOrderConfirm({
    business, customer, cart,
    address: trimmed,
    fee: Number(business.delivery_fee_ghs) || 0,
    promoCode
  });
}

async function askForDeliveryZone({ business, customer, cart, address, promoCode }) {
  const lang = langOf(business);
  const zones = deliveryZonesOf(business);
  await saveState(customer.id, {
    flow: 'ordering',
    step: 'choose_zone',
    data: { cart, delivery_address: address, promo_code: promoCode || null }
  });
  const rows = zones.map((z, i) => ({
    id: `zone_${i}`,
    title: truncate(z.name, 24),
    description: t(lang, 'zone_fee', { fee: formatGhs(z.fee_ghs) })
  }));
  await chOf(customer).sendList(
    destOf(customer),
    t(lang, 'zone_header'),
    t(lang, 'zone_body'),
    [{ title: t(lang, 'zone_section'), rows }],
    { buttonLabel: t(lang, 'btn_choose_zone'), businessId: business.id, customerId: customer.id }
  );
}

async function showOrderConfirm({ business, customer, cart, address, fee, zoneName, promoCode }) {
  const lang = langOf(business);
  const promo = promoCode ? (await orderService.validatePromoCode(business.id, promoCode, customer.id, cart)).promo : null;
  const totals = orderService.computeTotals(cart, fee, promo);
  const lines = cart.map(i => `• ${i.quantity}× ${i.name} — ${formatGhs(i.price_ghs * i.quantity)}`).join('\n');

  await saveState(customer.id, {
    flow: 'ordering',
    step: 'confirm_order',
    data: {
      cart, delivery_address: address, delivery_fee: totals.delivery_fee, delivery_zone: zoneName || null,
      promo_code: promo ? promo.code : null
    }
  });

  await chOf(customer).sendButtons(destOf(customer),
    t(lang, 'order_summary', {
      lines,
      subtotal: formatGhs(totals.subtotal_ghs),
      discountLine: promo ? t(lang, 'order_summary_discount_line', { code: promo.code, discount: formatGhs(totals.discount_ghs) }) : '',
      zone: zoneName,
      fee: formatGhs(totals.delivery_fee),
      total: formatGhs(totals.total_ghs),
      address
    }), [
    { id: 'confirm_pay', title: t(lang, 'btn_confirm_pay') },
    { id: 'cancel_order', title: t(lang, 'btn_cancel') }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 4 (create order, move to payment) ---------- */

async function finalizeOrderAndStartPayment({ business, customer, state }) {
  const lang = langOf(business);
  const cart = state.flow_data?.cart || [];
  const address = state.flow_data?.delivery_address || null;
  if (!cart.length || !address) {
    await chOf(customer).sendText(destOf(customer), t(lang, 'order_broken'),
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  // Re-validate one last time — a code can expire or hit its usage cap in
  // the gap between confirm-order and this tap. Silently proceed without the
  // discount rather than block the order over a stale promo.
  const promoCode = state.flow_data?.promo_code || null;
  const promo = promoCode ? (await orderService.validatePromoCode(business.id, promoCode, customer.id, cart)).promo : null;

  let order;
  try {
    order = await orderService.createOrder({
      businessId: business.id,
      customerId: customer.id,
      cart,
      deliveryAddress: address,
      deliveryFee: Number(state.flow_data?.delivery_fee) || 0,
      promo,
      notes: state.flow_data?.delivery_zone ? `Zone: ${state.flow_data.delivery_zone}` : undefined
    });
  } catch (err) {
    logger.error('createOrder failed: %s', err.message, { stack: err.stack });
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'order_create_failed'),
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  notificationService.notifyOrderReceived({ order, business, customer });

  await saveState(customer.id, {
    flow: 'paying',
    step: 'choose_method',
    data: { order_id: order.id, order_number: order.order_number, total: order.total_ghs }
  });

  await chOf(customer).sendButtons(destOf(customer),
    t(lang, 'order_created', { n: order.order_number, total: formatGhs(order.total_ghs) }),
    [
      { id: 'pay_momo', title: t(lang, 'btn_momo') },
      { id: 'pay_card', title: t(lang, 'btn_card') },
      { id: 'cancel_order', title: t(lang, 'btn_cancel') }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Payment flow ---------- */

async function continuePaymentFlow({ business, customer, state, inbound }) {
  const lang = langOf(business);
  const upper = (inbound.text || '').toUpperCase().trim();
  const data = state.flow_data || {};
  const orderId = data.order_id;

  if (!orderId) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), t(lang, 'session_expired'),
      { businessId: business.id, customerId: customer.id });
    return;
  }

  if (state.current_step === 'choose_method') {
    if (inbound.interactiveId === 'pay_momo' || upper === 'MOMO' || upper === 'MOBILE MONEY') {
      await saveState(customer.id, { flow: 'paying', step: 'momo_get_phone', data });
      // "USE THIS" only makes sense on WhatsApp, where the chat identity IS a
      // phone number. Instagram/Messenger customers must type their MoMo number.
      const prompt = ['instagram', 'messenger'].includes(customer.channel)
        ? t(lang, 'momo_ask_ig')
        : t(lang, 'momo_ask', { number: customer.whatsapp_number });
      await chOf(customer).sendText(destOf(customer), prompt,
        { businessId: business.id, customerId: customer.id });
      return;
    }
    if (inbound.interactiveId === 'pay_card' || upper === 'CARD' || upper === 'LINK'
        || titleMatches(inbound.text, 'btn_card')) {
      return startCardPayment({ business, customer, orderId });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      const cancelled = await orderService.updateOrderStatus(orderId, 'cancelled');
      if (cancelled) notificationService.notifyOrderCancelled({ order: cancelled, business, customer });
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), t(lang, 'order_cancelled_short'),
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  if (state.current_step === 'momo_get_phone') {
    let momoNumber;
    if (upper === 'USE THIS' && !['instagram', 'messenger'].includes(customer.channel)) {
      momoNumber = customer.whatsapp_number;
    } else {
      momoNumber = normalizeGhanaPhone(inbound.text);
      if (!momoNumber) {
        await chOf(customer).sendText(destOf(customer),
          t(lang, 'momo_invalid'),
          { businessId: business.id, customerId: customer.id });
        return;
      }
    }
    return startMomoPayment({ business, customer, orderId, momoNumber });
  }

  await chOf(customer).sendText(destOf(customer), t(lang, 'reply_menu'),
    { businessId: business.id, customerId: customer.id });
}

async function startMomoPayment({ business, customer, orderId, momoNumber }) {
  const lang = langOf(business);
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), t(lang, 'order_gone'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const reference = generateReference('ORD');
  await orderService.attachPaymentReference(order.id, reference, 'momo');

  const result = await paystack.initializeMoMoCharge({
    email: syntheticEmail('customer', reference),
    amountGhs: order.total_ghs,
    phoneNumber: momoNumber,
    reference,
    metadata: { order_id: order.id, order_number: order.order_number, business_id: business.id }
  });

  if (!result.success) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'momo_start_failed', { err: result.error || 'unknown error' }),
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  await saveState(customer.id, {
    flow: 'paying',
    step: 'awaiting_momo_confirm',
    data: { order_id: order.id, reference }
  });

  const display = result.display_text
    ? result.display_text
    : t(lang, 'momo_approve_hint', { number: momoNumber });
  await chOf(customer).sendText(destOf(customer),
    t(lang, 'momo_initiated', { total: formatGhs(order.total_ghs), display }),
    { businessId: business.id, customerId: customer.id });
}

async function startCardPayment({ business, customer, orderId }) {
  const lang = langOf(business);
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), t(lang, 'order_gone'),
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const reference = generateReference('ORD');
  await orderService.attachPaymentReference(order.id, reference, 'card');

  const callbackUrl = PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/paystack/callback`
    : undefined;

  const result = await paystack.createPaymentLink({
    email: syntheticEmail('customer', reference),
    amountGhs: order.total_ghs,
    reference,
    callbackUrl,
    metadata: { order_id: order.id, order_number: order.order_number, business_id: business.id }
  });

  if (!result.success || !result.authorization_url) {
    await chOf(customer).sendText(destOf(customer),
      t(lang, 'card_link_failed', { err: result.error || 'unknown error' }),
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  await saveState(customer.id, {
    flow: 'paying',
    step: 'awaiting_link_payment',
    data: { order_id: order.id, reference }
  });

  await chOf(customer).sendText(destOf(customer),
    t(lang, 'card_link', { total: formatGhs(order.total_ghs), url: result.authorization_url }),
    { businessId: business.id, customerId: customer.id, previewUrl: true });
}

/**
 * Called by the Paystack webhook handler after a successful payment.
 */
async function handlePaymentSuccess({ reference, gatewayRef, amount }) {
  const order = await orderService.getOrderByPaymentRef(reference);
  if (!order) {
    logger.warn('handlePaymentSuccess: no order with payment_ref=%s', reference);
    return { handled: false };
  }

  const result = await orderService.markOrderPaid({
    orderId: order.id,
    paymentRef: reference,
    amount
  });
  if (!result) return { handled: false };

  if (result.alreadyPaid) {
    // Same reference replayed → normal idempotent skip. A DIFFERENT reference
    // succeeding against an already-paid order means the customer approved
    // two live prompts — money was collected twice and a refund is owed.
    if (result.order.payment_ref && result.order.payment_ref !== reference) {
      logger.error(
        'POSSIBLE DOUBLE CHARGE: success for ref=%s but order %s was already paid via ref=%s — refund ref=%s at the gateway',
        reference, result.order.order_number, result.order.payment_ref, reference
      );
    } else {
      logger.info('handlePaymentSuccess: order %s already paid (idempotent skip)', result.order.order_number);
    }
    return { handled: true, alreadyPaid: true };
  }
  if (result.mismatch) {
    logger.warn(
      'handlePaymentSuccess: amount mismatch for order %s expected=%s got=%s reason=%s',
      result.order.order_number, result.expected, result.received, result.reason
    );
    // Notify customer that the payment did not satisfy the order.
    const customerRes = await query('SELECT * FROM customers WHERE id = $1', [result.order.customer_id]);
    const customer = customerRes.rows[0];
    if (customer) {
      const bizRes = await query('SELECT bot_language FROM businesses WHERE id = $1', [result.order.business_id]);
      await chOf(customer).sendText(destOf(customer),
        t(langOf(bizRes.rows[0]), 'payment_mismatch', { n: result.order.order_number }),
        { businessId: result.order.business_id, customerId: customer.id });
    }
    return { handled: true, mismatch: true };
  }

  const updated = result.order;
  const businessRes = await query('SELECT * FROM businesses WHERE id = $1', [updated.business_id]);
  const business = businessRes.rows[0];
  const customerRes = await query('SELECT * FROM customers WHERE id = $1', [updated.customer_id]);
  const customer = customerRes.rows[0];

  if (customer) {
    try { await resetState(customer.id); } catch (_e) { /* ignore */ }
  }

  await notificationService.notifyOrderPaid({ order: updated, business, customer });

  if (business?.whatsapp_number && result.lowStock?.length) {
    for (const p of result.lowStock) {
      const qtyLabel = p.stock_qty === 0 ? 'OUT OF STOCK' : `${p.stock_qty} left`;
      wa.sendText(business.whatsapp_number,
        `📉 Low stock: *${p.name}* — ${qtyLabel}. Update it from your dashboard.`,
        { businessId: business.id }
      ).catch(err => logger.warn('low-stock nudge failed for %s: %s', p.id, err.message));
      push.pushToBusiness(business.id, {
        title: '📉 Low stock',
        body: `${p.name} — ${qtyLabel}`,
        data: { type: 'product', product_id: p.id }
      });
      dashboardNotify.notifyDashboard(business.id, {
        type: 'low_stock', title: '📉 Low stock', body: `${p.name} — ${qtyLabel}`,
        data: { product_id: p.id }
      });
    }
  }

  if (customer && result.loyalty) {
    const lang = langOf(business, customer);
    const parts = [];
    if (result.loyalty.pointsEarned > 0) {
      parts.push(t(lang, 'loyalty_points_earned', { points: result.loyalty.pointsEarned, total: result.loyalty.stamps }));
    }
    if (result.loyalty.freeItemReward) {
      parts.push(t(lang, 'loyalty_free_item_earned', { code: result.loyalty.freeItemReward.code, value: formatGhs(result.loyalty.freeItemReward.value_ghs) }));
    }
    if (parts.length) {
      chOf(customer).sendText(destOf(customer), parts.join('\n\n'), { businessId: business.id, customerId: customer.id })
        .catch(err => logger.debug('loyalty notify failed: %s', err.message));
    }
    if (result.loyalty.referrerReward) {
      const referrerRes = await query('SELECT * FROM customers WHERE id = $1', [result.loyalty.referrerReward.customerId]);
      const referrer = referrerRes.rows[0];
      if (referrer) {
        chOf(referrer).sendText(destOf(referrer),
          t(langOf(business, referrer), 'loyalty_referral_earned', {
            code: result.loyalty.referrerReward.code, value: formatGhs(result.loyalty.referrerReward.value_ghs), shop: business.name
          }),
          { businessId: business.id, customerId: referrer.id }
        ).catch(err => logger.debug('referral reward notify failed: %s', err.message));
      }
    }
  }

  return { handled: true, order: updated };
}

async function handlePaymentFailure({ reference }) {
  const order = await orderService.getOrderByPaymentRef(reference);
  if (!order) return { handled: false };
  // A failure for a SUPERSEDED attempt (customer already retried with a new
  // reference) must not clobber the newer in-flight payment's state.
  if (order.payment_ref && order.payment_ref !== reference) {
    logger.info('handlePaymentFailure: stale attempt ref=%s for order %s (current ref=%s) — ignoring',
      reference, order.order_number, order.payment_ref);
    return { handled: true, stale: true };
  }
  await orderService.markOrderFailed({ orderId: order.id, paymentRef: reference });
  dashboardNotify.notifyDashboard(order.business_id, {
    type: 'failed_payment', title: '⚠️ Payment failed',
    body: `Order #${order.order_number} — GH₵${Number(order.total_ghs).toFixed(2)} payment did not go through.`,
    data: { order_id: order.id, order_number: order.order_number }
  });

  const customerRes = await query('SELECT * FROM customers WHERE id = $1', [order.customer_id]);
  const customer = customerRes.rows[0];
  if (customer) {
    const bizRes = await query('SELECT bot_language FROM businesses WHERE id = $1', [order.business_id]);
    const lang = langOf(bizRes.rows[0]);
    await chOf(customer).sendButtons(destOf(customer),
      t(lang, 'payment_failed_retry', { n: order.order_number }),
      [
        { id: `retrypay_${order.id}`, title: t(lang, 'btn_try_again') },
        { id: `cancelord_${order.id}`, title: t(lang, 'btn_cancel_order') }
      ],
      { businessId: order.business_id, customerId: customer.id });
    try { await resetState(customer.id); } catch (_e) { /* ignore */ }
  }
  return { handled: true };
}

module.exports = {
  handleInbound,
  handleStatuses,
  handlePaymentSuccess,
  handlePaymentFailure,
  // exported for tests
  normalizeIntent,
  titleMatches
};
