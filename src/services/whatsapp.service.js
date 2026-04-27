require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { toWaRecipient, formatGhs, formatDate, truncate } = require('../utils/helpers');

const WA_API_VERSION = process.env.WA_API_VERSION || 'v19.0';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

const BASE_URL = `https://graph.facebook.com/${WA_API_VERSION}`;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' }
});

function authHeaders() {
  return { Authorization: `Bearer ${WA_ACCESS_TOKEN}` };
}

function ensureConfigured() {
  if (!WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    throw new Error('WhatsApp Cloud API not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN missing)');
  }
}

async function logOutbound({ businessId, customerId, type, content, waMessageId, status }) {
  try {
    await query(
      `INSERT INTO message_log
        (business_id, customer_id, direction, message_type, content, wa_message_id, status)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6)`,
      [businessId || null, customerId || null, type, content || '', waMessageId || null, status || 'sent']
    );
  } catch (err) {
    logger.warn('Failed to log outbound message: %s', err.message);
  }
}

/**
 * Low-level send. Returns the WhatsApp message id on success.
 */
async function sendRaw(payload, meta = {}) {
  ensureConfigured();
  try {
    const res = await http.post(
      `/${WA_PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: authHeaders() }
    );
    const waId = res.data?.messages?.[0]?.id;
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: payload.type || 'unknown',
      content: meta.content || JSON.stringify(payload).slice(0, 1000),
      waMessageId: waId,
      status: 'sent'
    });
    return { success: true, messageId: waId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('WhatsApp send failed (%s): %s | payload=%j', status, err.message, payload);
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: payload.type || 'unknown',
      content: meta.content || JSON.stringify(payload).slice(0, 1000),
      status: 'failed'
    });
    return { success: false, error: err.message, status, data };
  }
}

/**
 * Send a plain text message.
 */
async function sendText(to, body, meta = {}) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaRecipient(to),
    type: 'text',
    text: { body: String(body || '').slice(0, 4096), preview_url: !!meta.previewUrl }
  };
  return sendRaw(payload, { ...meta, content: body });
}

/**
 * Send up to 3 reply buttons.
 *   buttons = [{ id: 'BTN_1', title: 'Yes' }, ...]
 */
async function sendButtons(to, body, buttons = [], meta = {}) {
  const trimmed = buttons.slice(0, 3).map((b, i) => ({
    type: 'reply',
    reply: {
      id: String(b.id || `btn_${i}`).slice(0, 256),
      title: truncate(b.title || `Option ${i + 1}`, 20)
    }
  }));

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaRecipient(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: truncate(body, 1024) },
      action: { buttons: trimmed }
    }
  };
  return sendRaw(payload, { ...meta, content: body });
}

/**
 * Send an interactive list message.
 *   sections = [{ title: 'Meals', rows: [{ id, title, description }] }, ...]
 */
async function sendList(to, header, body, sections = [], meta = {}) {
  const cleanedSections = sections.slice(0, 10).map(s => ({
    title: truncate(s.title || 'Items', 24),
    rows: (s.rows || []).slice(0, 10).map((r, i) => ({
      id: String(r.id || `row_${i}`).slice(0, 200),
      title: truncate(r.title || `Item ${i + 1}`, 24),
      description: r.description ? truncate(r.description, 72) : undefined
    }))
  }));

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaRecipient(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      header: header ? { type: 'text', text: truncate(header, 60) } : undefined,
      body: { text: truncate(body, 1024) },
      action: {
        button: truncate(meta.buttonLabel || 'Choose', 20),
        sections: cleanedSections
      }
    }
  };
  return sendRaw(payload, { ...meta, content: body });
}

/**
 * Mark an inbound message as read.
 */
async function markAsRead(messageId) {
  if (!messageId) return;
  ensureConfigured();
  try {
    await http.post(
      `/${WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: authHeaders() }
    );
  } catch (err) {
    logger.debug('markAsRead failed: %s', err.message);
  }
}

/* ================================================================
   High-level templated messages
   ================================================================ */

async function sendPaymentConfirmation(to, { orderNumber, total, businessName }, meta = {}) {
  const body =
`✅ Payment received!

Order: ${orderNumber}
Total: ${formatGhs(total)}
Business: ${businessName || 'your vendor'}

We'll notify you the moment your order is on its way. Thank you for shopping with us! 🛍️`;
  return sendText(to, body, meta);
}

async function sendOrderNotification(to, { orderNumber, customerName, items, total, address }, meta = {}) {
  const itemList = (items || [])
    .map(i => `• ${i.quantity || 1}× ${i.name} — ${formatGhs(i.price_ghs * (i.quantity || 1))}`)
    .join('\n') || '(no items)';

  const body =
`🛎️ New Order: ${orderNumber}

Customer: ${customerName || 'Customer'}
Address: ${address || '—'}

${itemList}

Total: *${formatGhs(total)}*

Reply with the order number to update status.`;
  return sendText(to, body, meta);
}

async function sendSubscriptionReceipt(to, { planName, amountGhs, expiresAt }, meta = {}) {
  const body =
`✅ Subscription Active

Plan: *${planName}*
Amount: ${formatGhs(amountGhs)}
Next billing: ${formatDate(expiresAt)}

Thanks for choosing our SaaS — your WhatsApp commerce is fully active! 🚀`;
  return sendText(to, body, meta);
}

async function sendRenewalReminder(to, { planName, amountGhs, daysLeft }, meta = {}) {
  const body =
`🔔 Renewal reminder

Your *${planName}* plan renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'} for ${formatGhs(amountGhs)}.

Reply *PAY* to renew now, or *STATUS* to see details.`;
  return sendText(to, body, meta);
}

async function sendSuspensionNotice(to, { businessName }, meta = {}) {
  const body =
`⛔ Service suspended

${businessName ? `Hi ${businessName}, your` : 'Your'} subscription is now suspended after the grace period.

Reply *PAY* to reactivate or *SUPPORT* to talk to our team.`;
  return sendText(to, body, meta);
}

module.exports = {
  sendRaw,
  sendText,
  sendButtons,
  sendList,
  markAsRead,
  sendPaymentConfirmation,
  sendOrderNotification,
  sendSubscriptionReceipt,
  sendRenewalReminder,
  sendSuspensionNotice
};
