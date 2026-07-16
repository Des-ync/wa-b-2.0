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

/**
 * Resolve per-tenant WhatsApp credentials, falling back to global env vars.
 * Tenant credentials are stored in businesses.wa_phone_number_id / wa_access_token.
 *
 * Safety: a tenant routed on its OWN phone_number_id (different from the
 * platform's) but missing its access token must fail loudly — silently falling
 * back to the platform credentials would send its replies from the platform's
 * WhatsApp number, leaking messages across tenants.
 */
async function resolveCredentials(businessId) {
  if (businessId) {
    try {
      const res = await query(
        `SELECT wa_phone_number_id, wa_access_token FROM businesses WHERE id = $1`,
        [businessId]
      );
      const biz = res.rows[0];
      if (biz && biz.wa_phone_number_id && biz.wa_access_token) {
        return { phoneNumberId: biz.wa_phone_number_id, accessToken: biz.wa_access_token };
      }
      if (
        biz && biz.wa_phone_number_id && !biz.wa_access_token &&
        biz.wa_phone_number_id !== WA_PHONE_NUMBER_ID
      ) {
        throw new Error(
          `Business ${businessId} has its own wa_phone_number_id but no wa_access_token — refusing to send from the platform number`
        );
      }
    } catch (err) {
      if (/refusing to send/.test(err.message)) throw err;
      logger.warn('resolveCredentials: DB lookup failed for businessId=%s, falling back to global: %s', businessId, err.message);
    }
  }
  return { phoneNumberId: WA_PHONE_NUMBER_ID, accessToken: WA_ACCESS_TOKEN };
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
  const { phoneNumberId, accessToken } = await resolveCredentials(meta.businessId);
  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp Cloud API not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN missing)');
  }
  try {
    const res = await http.post(
      `/${phoneNumberId}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
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
    logger.error('WhatsApp send failed (%s): %s | type=%s to=%s', status, err.message, payload.type, payload.to);
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: payload.type || 'unknown',
      content: meta.content || JSON.stringify(payload).slice(0, 1000),
      status: 'failed'
    });
    return { success: false, error: err.message, status };
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
 * Mark an inbound message as read. Pass `meta.typing: true` to also raise the
 * "typing…" indicator on the customer's screen — Meta clears it automatically
 * once we send the next message (or after ~25s, whichever comes first).
 */
async function markAsRead(messageId, meta = {}) {
  if (!messageId) return;
  const { phoneNumberId, accessToken } = await resolveCredentials(meta.businessId);
  if (!phoneNumberId || !accessToken) return;
  try {
    const payload = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
    if (meta.typing) payload.typing_indicator = { type: 'text' };
    await http.post(
      `/${phoneNumberId}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    logger.debug('markAsRead failed: %s', err.message);
  }
}

/**
 * Send a pre-approved Meta template message (required for business-initiated
 * messages outside the 24-hour customer service window).
 *   bodyParams: array of strings substituted into the template body {{1}}..{{n}}.
 *
 * Meta rejects params containing newlines/tabs, so they are flattened here.
 */
async function sendTemplate(to, templateName, { language, bodyParams = [] } = {}, meta = {}) {
  const params = (bodyParams || []).map(p =>
    String(p == null ? '' : p).replace(/\s+/g, ' ').trim().slice(0, 1024)
  );
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaRecipient(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || process.env.WA_TEMPLATE_LANG || 'en' },
      components: params.length
        ? [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }]
        : undefined
    }
  };
  return sendRaw(payload, { ...meta, content: `[template:${templateName}] ${params.join(' | ')}` });
}

/**
 * Business-initiated notice: use the approved template named by env var
 * `templateEnv` when configured (survives the 24h window), otherwise fall back
 * to free-form text (only deliverable inside the window).
 */
async function sendBusinessNotice({ to, templateEnv, bodyParams, fallbackText, meta = {} }) {
  const templateName = templateEnv ? process.env[templateEnv] : null;
  if (templateName) {
    const result = await sendTemplate(to, templateName, { bodyParams }, meta);
    if (result.success) return result;
    logger.warn('Template %s (%s) send failed — falling back to free-form text', templateName, templateEnv);
  }
  return sendText(to, fallbackText, meta);
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

Reply with the order number (e.g. ${orderNumber}) to update its status.`;
  const itemsFlat = (items || [])
    .map(i => `${i.quantity || 1}x ${i.name}`)
    .join('; ') || 'no items';
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_NEW_ORDER',
    bodyParams: [orderNumber, customerName || 'Customer', itemsFlat, formatGhs(total), address || '-'],
    fallbackText: body,
    meta
  });
}

async function sendSubscriptionReceipt(to, { planName, amountGhs, expiresAt }, meta = {}) {
  const body =
`✅ Subscription Active

Plan: *${planName}*
Amount: ${formatGhs(amountGhs)}
Next billing: ${formatDate(expiresAt)}

Thanks for choosing our SaaS — your WhatsApp commerce is fully active! 🚀`;
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_SUBSCRIPTION_RECEIPT',
    bodyParams: [planName, formatGhs(amountGhs), formatDate(expiresAt)],
    fallbackText: body,
    meta
  });
}

async function sendRenewalReminder(to, { planName, amountGhs, daysLeft }, meta = {}) {
  const body =
`🔔 Renewal reminder

Your *${planName}* plan renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'} for ${formatGhs(amountGhs)}.

Reply *PAY* to renew now, or *STATUS* to see details.`;
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_RENEWAL_REMINDER',
    bodyParams: [planName, String(daysLeft), formatGhs(amountGhs)],
    fallbackText: body,
    meta
  });
}

async function sendSuspensionNotice(to, { businessName }, meta = {}) {
  const body =
`⛔ Service suspended

${businessName ? `Hi ${businessName}, your` : 'Your'} subscription is now suspended after the grace period.

Reply *PAY* to reactivate or *SUPPORT* to talk to our team.`;
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_SUSPENSION',
    bodyParams: [businessName || 'there'],
    fallbackText: body,
    meta
  });
}

async function sendTrialReminder(to, { businessName, endsAt, daysLeft }, meta = {}) {
  const body =
`⏳ Trial ending soon

Hi ${businessName || 'there'} — your free trial ends on *${formatDate(endsAt)}* (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).

Reply *PAY* to activate a plan and keep your shop taking orders without interruption.`;
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_TRIAL_REMINDER',
    bodyParams: [businessName || 'there', formatDate(endsAt), String(daysLeft)],
    fallbackText: body,
    meta
  });
}

async function sendTrialExpiredNotice(to, { businessName }, meta = {}) {
  const body =
`⚠️ Trial ended

Hi ${businessName || 'there'} — your free trial has ended and your shop is no longer taking customer orders.

Reply *PAY* to choose a plan and switch back on instantly.`;
  return sendBusinessNotice({
    to,
    templateEnv: 'WA_TPL_TRIAL_EXPIRED',
    bodyParams: [businessName || 'there'],
    fallbackText: body,
    meta
  });
}

module.exports = {
  sendRaw,
  sendText,
  sendButtons,
  sendList,
  sendTemplate,
  sendBusinessNotice,
  markAsRead,
  sendPaymentConfirmation,
  sendOrderNotification,
  sendSubscriptionReceipt,
  sendRenewalReminder,
  sendSuspensionNotice,
  sendTrialReminder,
  sendTrialExpiredNotice
};
