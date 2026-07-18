const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
const { getAdapter, destOf } = require('./channel.adapter');
const paystack = require('./paystack.service');
const orderService = require('./order.service');
const subService = require('./subscription.service');
const notificationService = require('./notification.service');
const {
  normalizeGhanaPhone,
  detectNetwork,
  formatGhs,
  generateReference,
  truncate,
  formatDate,
  sleep,
  ORDER_NUMBER_RE,
  decayedTypingDelay,
  buildMenuPage
} = require('../utils/helpers');

/* -----------------------------------------------------------------
   Typing indicator pacing: the first reply in a conversation waits the
   longest; each subsequent reply gets progressively shorter, so a busy
   queue drains fast while single messages still feel human.
   ----------------------------------------------------------------- */
const TYPING_RESET_MS = 10 * 60 * 1000;
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

/** Outbound adapter for a customer's channel (WhatsApp unless 'instagram'). */
function chOf(customer) {
  return getAdapter(customer?.channel);
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
 * TODO(IG-API): verify against Meta's Instagram Messaging API docs — the
 * envelope walked below (entry[].messaging[] with sender/recipient/message,
 * message.mid, message.text, quick_reply.payload, is_echo) is a stub and must
 * be confirmed before go-live. Only the field paths need adjusting; the
 * returned normalized shape is final and matches extractWhatsAppInbound.
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
  const ins = await query(
    `INSERT INTO conversation_state (customer_id, current_flow, current_step, flow_data)
     VALUES ($1, 'idle', 'start', '{}'::jsonb)
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

  // Instagram is END-CUSTOMER commerce only: route by the IG business account
  // that received the DM and go straight to the commerce flow. The merchant
  // SaaS billing flow stays WhatsApp-only, keyed on business.whatsapp_number.
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

/* =================================================================
   SaaS billing flow (SME ↔ platform)
   ================================================================= */

async function handleSaasBilling({ business, inbound }) {
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

const MERCHANT_STATUS_LABELS = {
  preparing: 'Preparing',
  ready: 'Ready',
  delivered: 'Delivered'
};

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
  const buttons = Object.entries(MERCHANT_STATUS_LABELS)
    .filter(([status]) => status !== order.status)
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

  // Enforce subscription/trial access before serving any commerce flow.
  if (!await hasCommerceAccess(business)) {
    await ch.sendText(dest,
      `Sorry, ${business.name} is not accepting orders right now. Please check back later.`,
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const state = await loadOrCreateState(customer.id);
  const upper = (inbound.text || '').toUpperCase().trim();

  // Global commands
  if (['HI', 'HELLO', 'START', 'MENU'].includes(upper)) {
    await resetState(customer.id);
    return sendWelcome({ business, customer });
  }
  if (upper === 'CANCEL' || upper === 'STOP') {
    await resetState(customer.id);
    await ch.sendText(dest, 'Cart cleared. Reply *MENU* to start over.', {
      businessId: business.id, customerId: customer.id
    });
    return;
  }

  // "Talk to us" — hand the customer the business's direct contact.
  if (inbound.interactiveId === 'support_request') {
    return sendSupportContact({ business, customer });
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

  // Triggers from idle
  if (['ORDER', 'BUY', 'SHOP'].includes(upper) || inbound.interactiveId === 'start_order') {
    return startOrderingFlow({ business, customer });
  }

  // Default fallback
  return sendWelcome({ business, customer });
}

async function sendSupportContact({ business, customer }) {
  const msisdn = String(business.whatsapp_number || '').replace(/[^\d]/g, '');
  const line = msisdn
    ? `You can reach *${business.name}* directly on WhatsApp: https://wa.me/${msisdn}`
    : `You can reach *${business.name}* directly on their WhatsApp line.`;
  await chOf(customer).sendText(destOf(customer),
    `💬 ${line}\n\nOr reply *MENU* anytime to keep shopping.`,
    { businessId: business.id, customerId: customer.id, previewUrl: false });
}

/**
 * Restart payment on an EXISTING order (from the retry button) instead of
 * making the customer rebuild their cart into a duplicate order.
 */
async function retryOrderPayment({ business, customer, orderId }) {
  const order = await orderService.getOrderById(orderId);
  if (!order || order.business_id !== business.id || order.customer_id !== customer.id) {
    await chOf(customer).sendText(destOf(customer), 'That order is no longer available. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.payment_status === 'paid') {
    await chOf(customer).sendText(destOf(customer),
      `Order *${order.order_number}* is already paid. ✅`,
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.status === 'cancelled') {
    await chOf(customer).sendText(destOf(customer),
      `Order *${order.order_number}* was cancelled. Reply *MENU* to place a new one.`,
      { businessId: business.id, customerId: customer.id });
    return;
  }

  await saveState(customer.id, {
    flow: 'paying',
    step: 'choose_method',
    data: { order_id: order.id, order_number: order.order_number, total: order.total_ghs }
  });
  await chOf(customer).sendButtons(destOf(customer),
    `Let's finish paying for order *${order.order_number}* — total *${formatGhs(order.total_ghs)}*.\n\nHow would you like to pay?`,
    [
      { id: 'pay_momo', title: 'MoMo' },
      { id: 'pay_card', title: 'Card / Link' },
      { id: 'cancel_order', title: 'Cancel' }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

async function cancelUnpaidOrder({ business, customer, orderId }) {
  const order = await orderService.getOrderById(orderId);
  if (!order || order.business_id !== business.id || order.customer_id !== customer.id) {
    await chOf(customer).sendText(destOf(customer), 'That order is no longer available.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (order.payment_status === 'paid') {
    await chOf(customer).sendText(destOf(customer),
      `Order *${order.order_number}* is already paid, so it can't be cancelled here. Contact ${business.name} if you need help.`,
      { businessId: business.id, customerId: customer.id });
    return;
  }
  await orderService.updateOrderStatus(order.id, 'cancelled');
  await resetState(customer.id);
  await chOf(customer).sendText(destOf(customer),
    `Order *${order.order_number}* cancelled. Reply *MENU* anytime to order again.`,
    { businessId: business.id, customerId: customer.id });
}

async function sendWelcome({ business, customer }) {
  const body =
`👋 Welcome to *${business.name}*!

Tap *Order Now* to browse our menu and place an order. Pay easily with MoMo or card.`;
  await chOf(customer).sendButtons(destOf(customer), body, [
    { id: 'start_order', title: 'Order Now' },
    { id: 'support_request', title: 'Talk to us' }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 1 (browse) ---------- */

/**
 * Show the product menu. CARRIES THE EXISTING CART FORWARD — "Add more" and
 * "Continue shopping" must never wipe what the customer already picked.
 * WhatsApp allows max 10 list rows total, so long catalogs are paginated
 * with prev/next rows (handled via `menu_page_<n>` interactive ids).
 */
async function startOrderingFlow({ business, customer, page = 0 }) {
  const products = await query(
    `SELECT id, name, description, price_ghs, category
       FROM products
      WHERE business_id = $1 AND in_stock = TRUE
      ORDER BY category ASC, name ASC
      LIMIT 200`,
    [business.id]
  );
  if (!products.rows.length) {
    await chOf(customer).sendText(destOf(customer),
      `Sorry, ${business.name} has no products available right now. Please check back soon!`,
      { businessId: business.id, customerId: customer.id });
    return;
  }

  // Preserve any in-flight cart across menu views.
  const state = await loadOrCreateState(customer.id);
  const cart = Array.isArray(state.flow_data?.cart) ? state.flow_data.cart : [];

  const menu = buildMenuPage(products.rows, page);
  const sections = [{
    title: menu.totalPages > 1 ? `Menu ${menu.page + 1}/${menu.totalPages}` : 'Menu',
    rows: menu.rows
  }];

  await saveState(customer.id, {
    flow: 'ordering',
    step: 'browse',
    data: { cart, menu_page: menu.page }
  });

  const cartNote = cart.length
    ? `\n\n🛒 ${cart.reduce((n, i) => n + (i.quantity || 1), 0)} item(s) already in your cart.`
    : '';
  await chOf(customer).sendList(
    destOf(customer),
    `${business.name} Menu`,
    `Tap an item to add it to your cart.${cartNote}`,
    sections,
    { buttonLabel: 'View menu', businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Ordering: routing while in flow ---------- */

async function continueOrderingFlow({ business, customer, state, inbound }) {
  const data = state.flow_data || {};
  const cart = Array.isArray(data.cart) ? data.cart : [];
  const upper = (inbound.text || '').toUpperCase().trim();

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

  // After adding, ask "Add more or checkout?"
  if (state.current_step === 'await_more') {
    if (inbound.interactiveId === 'add_more' || upper === 'ADD MORE' || upper === 'MORE') {
      return startOrderingFlow({ business, customer });
    }
    if (inbound.interactiveId === 'checkout' || upper === 'CHECKOUT') {
      return showCartReview({ business, customer, cart });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), 'Order cancelled. Reply *MENU* to start over.',
        { businessId: business.id, customerId: customer.id });
      return;
    }
    return promptAddMoreOrCheckout({ business, customer });
  }

  if (state.current_step === 'cart_review') {
    if (inbound.interactiveId === 'continue_shop' || upper === 'CONTINUE SHOPPING') {
      return startOrderingFlow({ business, customer });
    }
    if (inbound.interactiveId === 'checkout' || upper === 'CHECKOUT') {
      return askForAddress({ business, customer });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), 'Order cancelled. Reply *MENU* to start over.',
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  if (state.current_step === 'get_address') {
    return captureAddress({ business, customer, cart, address: inbound.text, location: inbound.location });
  }

  if (state.current_step === 'confirm_order') {
    if (inbound.interactiveId === 'confirm_pay' || upper === 'CONFIRM & PAY' || upper === 'CONFIRM') {
      return finalizeOrderAndStartPayment({ business, customer, state });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), 'Order cancelled. Reply *MENU* to start over.',
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  // Fallback while in flow
  return showCartReview({ business, customer, cart });
}

async function addProductToCart({ business, customer, productId, cart }) {
  const res = await query(`SELECT * FROM products WHERE id = $1 AND business_id = $2`, [productId, business.id]);
  const product = res.rows[0];
  if (!product) {
    await chOf(customer).sendText(destOf(customer), 'That item is no longer available.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (!product.in_stock) {
    await chOf(customer).sendText(destOf(customer), `Sorry, "${product.name}" is out of stock.`,
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const existing = cart.find(c => c.product_id === product.id);
  if (existing) {
    existing.quantity = (existing.quantity || 1) + 1;
  } else {
    cart.push({
      product_id: product.id,
      name: product.name,
      price_ghs: Number(product.price_ghs),
      quantity: 1
    });
  }

  await saveState(customer.id, { flow: 'ordering', step: 'await_more', data: { cart } });
  await promptAddMoreOrCheckout({ business, customer, justAdded: product.name });
}

async function promptAddMoreOrCheckout({ business, customer, justAdded }) {
  const body = justAdded
    ? `Added *${justAdded}* to your cart. ✅\n\nWould you like to add more items or checkout?`
    : `Would you like to add more items or checkout?`;
  await chOf(customer).sendButtons(destOf(customer), body,
    [
      { id: 'add_more', title: 'Add more' },
      { id: 'checkout', title: 'Checkout' },
      { id: 'cancel_order', title: 'Cancel' }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Ordering: STEP 2 (cart review) ---------- */

async function showCartReview({ business, customer, cart }) {
  if (!cart || cart.length === 0) {
    await chOf(customer).sendText(destOf(customer), 'Your cart is empty. Reply *MENU* to start shopping.',
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }
  const totals = orderService.computeTotals(cart, 0);
  const lines = cart.map(i => `• ${i.quantity}× ${i.name} — ${formatGhs(i.price_ghs * i.quantity)}`).join('\n');
  const body =
`🛒 Your Cart

${lines}

Subtotal: *${formatGhs(totals.subtotal_ghs)}*

Continue shopping or checkout?`;

  await saveState(customer.id, { flow: 'ordering', step: 'cart_review', data: { cart } });
  await chOf(customer).sendButtons(destOf(customer), body, [
    { id: 'continue_shop', title: 'Continue' },
    { id: 'checkout', title: 'Checkout' },
    { id: 'cancel_order', title: 'Cancel' }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 3 (delivery address) ---------- */

async function askForAddress({ business, customer }) {
  const state = await loadOrCreateState(customer.id);
  const cart = state.flow_data?.cart || [];
  await saveState(customer.id, { flow: 'ordering', step: 'get_address', data: { cart } });
  await chOf(customer).sendText(destOf(customer),
    `📍 Please send your delivery address as a text message (landmark, area, any special instructions) — or share your location pin.`,
    { businessId: business.id, customerId: customer.id });
}

async function captureAddress({ business, customer, cart, address, location }) {
  let trimmed = String(address || '').trim();
  // A shared WhatsApp location pin is a perfectly good delivery address.
  if (location) {
    const label = [location.name, location.address].filter(Boolean).join(', ');
    const maps = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
    trimmed = label ? `${label} (pin: ${maps})` : `Pinned location: ${maps}`;
  }
  if (trimmed.length < 5) {
    await chOf(customer).sendText(destOf(customer),
      'That address looks too short. Please send a more detailed delivery address, or share your location pin 📍.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const totals = orderService.computeTotals(cart, 0);
  const lines = cart.map(i => `• ${i.quantity}× ${i.name} — ${formatGhs(i.price_ghs * i.quantity)}`).join('\n');
  const body =
`📦 Order Summary

${lines}

Subtotal: ${formatGhs(totals.subtotal_ghs)}
Delivery: ${formatGhs(totals.delivery_fee)}
*Total: ${formatGhs(totals.total_ghs)}*

Address: ${trimmed}

Confirm and pay now?`;

  await saveState(customer.id, {
    flow: 'ordering',
    step: 'confirm_order',
    data: { cart, delivery_address: trimmed }
  });

  await chOf(customer).sendButtons(destOf(customer), body, [
    { id: 'confirm_pay', title: 'Confirm & Pay' },
    { id: 'cancel_order', title: 'Cancel' }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 4 (create order, move to payment) ---------- */

async function finalizeOrderAndStartPayment({ business, customer, state }) {
  const cart = state.flow_data?.cart || [];
  const address = state.flow_data?.delivery_address || null;
  if (!cart.length || !address) {
    await chOf(customer).sendText(destOf(customer), 'Something went wrong with your order. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  let order;
  try {
    order = await orderService.createOrder({
      businessId: business.id,
      customerId: customer.id,
      cart,
      deliveryAddress: address,
      deliveryFee: 0
    });
  } catch (err) {
    logger.error('createOrder failed: %s', err.message, { stack: err.stack });
    await chOf(customer).sendText(destOf(customer),
      'We could not create your order right now. Please try again in a moment.',
      { businessId: business.id, customerId: customer.id });
    await resetState(customer.id);
    return;
  }

  await saveState(customer.id, {
    flow: 'paying',
    step: 'choose_method',
    data: { order_id: order.id, order_number: order.order_number, total: order.total_ghs }
  });

  await chOf(customer).sendButtons(destOf(customer),
    `Order *${order.order_number}* created — total *${formatGhs(order.total_ghs)}*.\n\nHow would you like to pay?`,
    [
      { id: 'pay_momo', title: 'MoMo' },
      { id: 'pay_card', title: 'Card / Link' },
      { id: 'cancel_order', title: 'Cancel' }
    ],
    { businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Payment flow ---------- */

async function continuePaymentFlow({ business, customer, state, inbound }) {
  const upper = (inbound.text || '').toUpperCase().trim();
  const data = state.flow_data || {};
  const orderId = data.order_id;

  if (!orderId) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), 'Your session expired. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    return;
  }

  if (state.current_step === 'choose_method') {
    if (inbound.interactiveId === 'pay_momo' || upper === 'MOMO' || upper === 'MOBILE MONEY') {
      await saveState(customer.id, { flow: 'paying', step: 'momo_get_phone', data });
      // "USE THIS" only makes sense on WhatsApp, where the chat identity IS a
      // phone number. Instagram customers must type their MoMo number.
      const prompt = customer.channel === 'instagram'
        ? '📱 Reply with the MoMo number to charge (e.g. 0241234567).'
        : `📱 Reply with the MoMo number to charge (or send *USE THIS* to use ${customer.whatsapp_number}).`;
      await chOf(customer).sendText(destOf(customer), prompt,
        { businessId: business.id, customerId: customer.id });
      return;
    }
    if (inbound.interactiveId === 'pay_card' || upper === 'CARD' || upper === 'LINK') {
      return startCardPayment({ business, customer, orderId });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await orderService.updateOrderStatus(orderId, 'cancelled');
      await resetState(customer.id);
      await chOf(customer).sendText(destOf(customer), 'Order cancelled.',
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  if (state.current_step === 'momo_get_phone') {
    let momoNumber;
    if (upper === 'USE THIS' && customer.channel !== 'instagram') {
      momoNumber = customer.whatsapp_number;
    } else {
      momoNumber = normalizeGhanaPhone(inbound.text);
      if (!momoNumber) {
        await chOf(customer).sendText(destOf(customer),
          'That doesn\'t look like a valid Ghana MoMo number. Try again (e.g. 0241234567).',
          { businessId: business.id, customerId: customer.id });
        return;
      }
    }
    return startMomoPayment({ business, customer, orderId, momoNumber });
  }

  await chOf(customer).sendText(destOf(customer), 'Reply *MENU* to start over.',
    { businessId: business.id, customerId: customer.id });
}

async function startMomoPayment({ business, customer, orderId, momoNumber }) {
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), 'Order not found. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const reference = generateReference('ORD');
  await orderService.attachPaymentReference(order.id, reference, 'momo');

  const result = await paystack.initializeMoMoCharge({
    email: `customer+${reference}@whatsapp-saas.local`,
    amountGhs: order.total_ghs,
    phoneNumber: momoNumber,
    reference,
    metadata: { order_id: order.id, order_number: order.order_number, business_id: business.id }
  });

  if (!result.success) {
    await chOf(customer).sendText(destOf(customer),
      `⚠️ Could not start MoMo charge: ${result.error || 'unknown error'}.\n\nReply *MENU* to try again.`,
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
    : `Approve the MoMo prompt on ${momoNumber} to complete payment.`;
  await chOf(customer).sendText(destOf(customer),
    `✅ MoMo charge initiated for *${formatGhs(order.total_ghs)}*.\n\n${display}\n\nWe'll confirm here once payment is received.`,
    { businessId: business.id, customerId: customer.id });
}

async function startCardPayment({ business, customer, orderId }) {
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await chOf(customer).sendText(destOf(customer), 'Order not found. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  const reference = generateReference('ORD');
  await orderService.attachPaymentReference(order.id, reference, 'card');

  const callbackUrl = PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/paystack/callback`
    : undefined;

  const result = await paystack.createPaymentLink({
    email: `customer+${reference}@whatsapp-saas.local`,
    amountGhs: order.total_ghs,
    reference,
    callbackUrl,
    metadata: { order_id: order.id, order_number: order.order_number, business_id: business.id }
  });

  if (!result.success || !result.authorization_url) {
    await chOf(customer).sendText(destOf(customer),
      `⚠️ Could not generate payment link: ${result.error || 'unknown error'}.\n\nReply *MENU* to try again.`,
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
    `💳 Pay *${formatGhs(order.total_ghs)}* securely via this link:\n\n${result.authorization_url}\n\nWe'll confirm here once payment is received.`,
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
    logger.info('handlePaymentSuccess: order %s already paid (idempotent skip)', result.order.order_number);
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
      await chOf(customer).sendText(destOf(customer),
        `⚠️ The payment received for order *${result.order.order_number}* did not match the order total. Our team will be in touch.`,
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

  return { handled: true, order: updated };
}

async function handlePaymentFailure({ reference }) {
  const order = await orderService.getOrderByPaymentRef(reference);
  if (!order) return { handled: false };
  await orderService.markOrderFailed({ orderId: order.id, paymentRef: reference });

  const customerRes = await query('SELECT * FROM customers WHERE id = $1', [order.customer_id]);
  const customer = customerRes.rows[0];
  if (customer) {
    await chOf(customer).sendButtons(destOf(customer),
      `⚠️ Payment for order *${order.order_number}* did not go through.\n\nYour order is saved — you can try paying again.`,
      [
        { id: `retrypay_${order.id}`, title: 'Try again' },
        { id: `cancelord_${order.id}`, title: 'Cancel order' }
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
  handlePaymentFailure
};
