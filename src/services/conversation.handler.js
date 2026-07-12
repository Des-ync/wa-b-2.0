const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
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
  formatDate
} = require('../utils/helpers');

const SUPPORT_NUMBER = process.env.SUPPORT_WHATSAPP_NUMBER || '+233241234567';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/* =================================================================
   Inbound message normalizer
   ================================================================= */

function extractInbound(payload) {
  try {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return null;
    const message = value.messages?.[0];
    if (!message) return null;

    const contact = value.contacts?.[0];
    const from = `+${message.from.replace(/^\+/, '')}`;
    const profileName = contact?.profile?.name;
    const messageId = message.id;

    let text = '';
    let interactiveId = null;
    let interactiveTitle = null;
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
    }

    return {
      from: normalizeGhanaPhone(from) || from,
      profileName,
      messageId,
      type,
      text: String(text || '').trim(),
      interactiveId,
      interactiveTitle,
      raw: message,
      businessPhoneId: value.metadata?.phone_number_id
    };
  } catch (err) {
    logger.error('extractInbound failed: %s', err.message);
    return null;
  }
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

async function handleInbound(payload) {
  const inbound = extractInbound(payload);
  if (!inbound) {
    logger.debug('Inbound payload had no message — likely a status update.');
    return;
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
  if (inbound.messageId) wa.markAsRead(inbound.messageId, { businessId: business.id });

  if (upper === 'STATUS') return saasStatus(business);
  if (upper === 'PAY' || upper === 'RENEW' || upper === 'RETRY') return saasPay(business);
  if (upper === 'CANCEL') return saasCancel(business);
  if (upper === 'UPGRADE') return saasUpgradeMenu(business);
  if (upper === 'SUPPORT') return saasSupport(business);

  // Interactive reply: did they pick a plan during UPGRADE?
  if (inbound.interactiveId && inbound.interactiveId.startsWith('plan_')) {
    const planName = inbound.interactiveId.slice('plan_'.length);
    return saasUpgradeSelect(business, planName);
  }

  return saasMenu(business);
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
  const fromWa = inbound.from;
  const network = detectNetwork(fromWa);

  const customer = await orderService.getOrCreateCustomer({
    businessId: business.id,
    whatsappNumber: fromWa,
    displayName: inbound.profileName,
    phoneNetwork: network
  });

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
  if (inbound.messageId) wa.markAsRead(inbound.messageId, { businessId: business.id });

  // Enforce subscription/trial access before serving any commerce flow.
  if (!await hasCommerceAccess(business)) {
    await wa.sendText(fromWa,
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
    await wa.sendText(fromWa, 'Cart cleared. Reply *MENU* to start over.', {
      businessId: business.id, customerId: customer.id
    });
    return;
  }

  // Active flow routing
  if (state.current_flow === 'ordering') {
    return continueOrderingFlow({ business, customer, state, inbound });
  }

  if (state.current_flow === 'paying') {
    return continuePaymentFlow({ business, customer, state, inbound });
  }

  // Triggers from idle
  if (['ORDER', 'MENU', 'BUY', 'SHOP'].includes(upper) || inbound.interactiveId === 'start_order') {
    return startOrderingFlow({ business, customer });
  }

  // Default fallback
  return sendWelcome({ business, customer });
}

async function sendWelcome({ business, customer }) {
  const body =
`👋 Welcome to *${business.name}*!

Tap *Order Now* to browse our menu and place an order. Pay easily with MoMo or card.`;
  await wa.sendButtons(customer.whatsapp_number, body, [
    { id: 'start_order', title: 'Order Now' },
    { id: 'support_request', title: 'Talk to us' }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 1 (browse) ---------- */

async function startOrderingFlow({ business, customer }) {
  const products = await query(
    `SELECT id, name, description, price_ghs, category
       FROM products
      WHERE business_id = $1 AND in_stock = TRUE
      ORDER BY category ASC, name ASC
      LIMIT 50`,
    [business.id]
  );
  if (!products.rows.length) {
    await wa.sendText(customer.whatsapp_number,
      `Sorry, ${business.name} has no products available right now. Please check back soon!`,
      { businessId: business.id, customerId: customer.id });
    return;
  }

  const sectionsMap = {};
  for (const p of products.rows) {
    const cat = p.category || 'general';
    sectionsMap[cat] = sectionsMap[cat] || [];
    sectionsMap[cat].push({
      id: `prod_${p.id}`,
      title: truncate(p.name, 24),
      description: `${formatGhs(p.price_ghs)}${p.description ? ' · ' + p.description : ''}`
    });
  }
  const sections = Object.entries(sectionsMap).map(([title, rows]) => ({ title, rows }));

  await saveState(customer.id, {
    flow: 'ordering',
    step: 'browse',
    data: { cart: [] }
  });

  await wa.sendList(
    customer.whatsapp_number,
    `${business.name} Menu`,
    'Tap an item to add it to your cart.',
    sections,
    { buttonLabel: 'View menu', businessId: business.id, customerId: customer.id }
  );
}

/* ---------- Ordering: routing while in flow ---------- */

async function continueOrderingFlow({ business, customer, state, inbound }) {
  const data = state.flow_data || {};
  const cart = Array.isArray(data.cart) ? data.cart : [];
  const upper = (inbound.text || '').toUpperCase().trim();

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
      await wa.sendText(customer.whatsapp_number, 'Order cancelled. Reply *MENU* to start over.',
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
  }

  if (state.current_step === 'get_address') {
    return captureAddress({ business, customer, cart, address: inbound.text });
  }

  if (state.current_step === 'confirm_order') {
    if (inbound.interactiveId === 'confirm_pay' || upper === 'CONFIRM & PAY' || upper === 'CONFIRM') {
      return finalizeOrderAndStartPayment({ business, customer, state });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await resetState(customer.id);
      await wa.sendText(customer.whatsapp_number, 'Order cancelled. Reply *MENU* to start over.',
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
    await wa.sendText(customer.whatsapp_number, 'That item is no longer available.',
      { businessId: business.id, customerId: customer.id });
    return;
  }
  if (!product.in_stock) {
    await wa.sendText(customer.whatsapp_number, `Sorry, "${product.name}" is out of stock.`,
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
  await wa.sendButtons(customer.whatsapp_number, body,
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
    await wa.sendText(customer.whatsapp_number, 'Your cart is empty. Reply *MENU* to start shopping.',
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
  await wa.sendButtons(customer.whatsapp_number, body, [
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
  await wa.sendText(customer.whatsapp_number,
    `📍 Please send your delivery address as a text message.\n\nInclude landmark, area, and any special instructions.`,
    { businessId: business.id, customerId: customer.id });
}

async function captureAddress({ business, customer, cart, address }) {
  const trimmed = String(address || '').trim();
  if (trimmed.length < 5) {
    await wa.sendText(customer.whatsapp_number,
      'That address looks too short. Please send a more detailed delivery address.',
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

  await wa.sendButtons(customer.whatsapp_number, body, [
    { id: 'confirm_pay', title: 'Confirm & Pay' },
    { id: 'cancel_order', title: 'Cancel' }
  ], { businessId: business.id, customerId: customer.id });
}

/* ---------- Ordering: STEP 4 (create order, move to payment) ---------- */

async function finalizeOrderAndStartPayment({ business, customer, state }) {
  const cart = state.flow_data?.cart || [];
  const address = state.flow_data?.delivery_address || null;
  if (!cart.length || !address) {
    await wa.sendText(customer.whatsapp_number, 'Something went wrong with your order. Reply *MENU* to start over.',
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
    await wa.sendText(customer.whatsapp_number,
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

  await wa.sendButtons(customer.whatsapp_number,
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
    await wa.sendText(customer.whatsapp_number, 'Your session expired. Reply *MENU* to start over.',
      { businessId: business.id, customerId: customer.id });
    return;
  }

  if (state.current_step === 'choose_method') {
    if (inbound.interactiveId === 'pay_momo' || upper === 'MOMO' || upper === 'MOBILE MONEY') {
      await saveState(customer.id, { flow: 'paying', step: 'momo_get_phone', data });
      await wa.sendText(customer.whatsapp_number,
        `📱 Reply with the MoMo number to charge (or send *USE THIS* to use ${customer.whatsapp_number}).`,
        { businessId: business.id, customerId: customer.id });
      return;
    }
    if (inbound.interactiveId === 'pay_card' || upper === 'CARD' || upper === 'LINK') {
      return startCardPayment({ business, customer, orderId });
    }
    if (inbound.interactiveId === 'cancel_order' || upper === 'CANCEL') {
      await orderService.updateOrderStatus(orderId, 'cancelled');
      await resetState(customer.id);
      await wa.sendText(customer.whatsapp_number, 'Order cancelled.',
        { businessId: business.id, customerId: customer.id });
      return;
    }
  }

  if (state.current_step === 'momo_get_phone') {
    let momoNumber;
    if (upper === 'USE THIS') {
      momoNumber = customer.whatsapp_number;
    } else {
      momoNumber = normalizeGhanaPhone(inbound.text);
      if (!momoNumber) {
        await wa.sendText(customer.whatsapp_number,
          'That doesn\'t look like a valid Ghana MoMo number. Try again (e.g. 0241234567).',
          { businessId: business.id, customerId: customer.id });
        return;
      }
    }
    return startMomoPayment({ business, customer, orderId, momoNumber });
  }

  await wa.sendText(customer.whatsapp_number, 'Reply *MENU* to start over.',
    { businessId: business.id, customerId: customer.id });
}

async function startMomoPayment({ business, customer, orderId, momoNumber }) {
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await wa.sendText(customer.whatsapp_number, 'Order not found. Reply *MENU* to start over.',
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
    await wa.sendText(customer.whatsapp_number,
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
  await wa.sendText(customer.whatsapp_number,
    `✅ MoMo charge initiated for *${formatGhs(order.total_ghs)}*.\n\n${display}\n\nWe'll confirm here once payment is received.`,
    { businessId: business.id, customerId: customer.id });
}

async function startCardPayment({ business, customer, orderId }) {
  const order = await orderService.getOrderById(orderId);
  if (!order) {
    await resetState(customer.id);
    await wa.sendText(customer.whatsapp_number, 'Order not found. Reply *MENU* to start over.',
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
    await wa.sendText(customer.whatsapp_number,
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

  await wa.sendText(customer.whatsapp_number,
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
      await wa.sendText(customer.whatsapp_number,
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
    await wa.sendText(customer.whatsapp_number,
      `⚠️ Payment for order *${order.order_number}* did not go through.\n\nReply *MENU* to retry.`,
      { businessId: order.business_id, customerId: customer.id });
    try { await resetState(customer.id); } catch (_e) { /* ignore */ }
  }
  return { handled: true };
}

module.exports = {
  handleInbound,
  handlePaymentSuccess,
  handlePaymentFailure
};
