require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { formatGhs, truncate } = require('../utils/helpers');
const { t } = require('../utils/i18n');

/**
 * Facebook Messenger channel — mirrors the structure of instagram.service.js
 * (which itself mirrors whatsapp.service.js): resolveCredentials (per-tenant
 * with env fallback), sendRaw, logOutbound into message_log, sendText, and
 * sendQuickReplies (the analogue of sendButtons).
 *
 * Wire format implemented from Meta's Messenger Platform Send API docs
 * (developers.facebook.com/docs/messenger-platform/send-messages):
 *   POST https://graph.facebook.com/<v>/me/messages
 *   Authorization: Bearer <PAGE_ACCESS_TOKEN>
 *   text:          { recipient: {id}, message: { text } }               (≤2000 chars)
 *   quick replies: message.quick_replies [{content_type:'text',
 *                  title (≤20 chars), payload}], max 13 per message
 *   image:         message.attachment { type:'image', payload:{url} }
 *   response:      { recipient_id, message_id }
 * The webhook receives the tapped quick reply's title in `text` and its
 * payload in `quick_reply.payload` — same shape as Instagram's, since both
 * ride on the same underlying Send/webhook API.
 * Permissions required: pages_messaging.
 */

const FB_API_VERSION = process.env.FB_API_VERSION || 'v21.0';
const MESSENGER_ACCESS_TOKEN = process.env.MESSENGER_ACCESS_TOKEN;
const MESSENGER_PAGE_ID = process.env.MESSENGER_PAGE_ID;

const BASE_URL = `https://graph.facebook.com/${FB_API_VERSION}`;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * Resolve per-tenant Messenger credentials, falling back to global env vars.
 * Tenant credentials live in businesses.messenger_page_id /
 * messenger_page_access_token.
 *
 * Safety (same rule as WhatsApp/Instagram): a tenant routed on its OWN Page
 * id but missing its access token must fail loudly — silently falling back
 * to the platform credentials would send its replies from the platform's
 * Page, leaking messages across tenants.
 */
async function resolveCredentials(businessId) {
  if (businessId) {
    try {
      const res = await query(
        `SELECT messenger_page_id, messenger_page_access_token FROM businesses WHERE id = $1`,
        [businessId]
      );
      const biz = res.rows[0];
      if (biz && biz.messenger_page_id && biz.messenger_page_access_token) {
        return { pageId: biz.messenger_page_id, accessToken: biz.messenger_page_access_token };
      }
      if (
        biz && biz.messenger_page_id && !biz.messenger_page_access_token &&
        biz.messenger_page_id !== MESSENGER_PAGE_ID
      ) {
        throw new Error(
          `Business ${businessId} has its own messenger_page_id but no messenger_page_access_token — refusing to send from the platform Page`
        );
      }
    } catch (err) {
      if (/refusing to send/.test(err.message)) throw err;
      logger.warn('Messenger resolveCredentials: DB lookup failed for businessId=%s, falling back to global: %s', businessId, err.message);
    }
  }
  return { pageId: MESSENGER_PAGE_ID, accessToken: MESSENGER_ACCESS_TOKEN };
}

async function logOutbound({ businessId, customerId, type, content, fbMessageId, status }) {
  try {
    // message_log.wa_message_id doubles as the channel-native message id; FB
    // mids and WA/IG mids never collide, so the unique dedupe index still holds.
    await query(
      `INSERT INTO message_log
        (business_id, customer_id, direction, message_type, content, wa_message_id, status)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6)`,
      [businessId || null, customerId || null, type, content || '', fbMessageId || null, status || 'sent']
    );
  } catch (err) {
    logger.warn('Failed to log outbound Messenger message: %s', err.message);
  }
}

/**
 * Map our channel-agnostic descriptor onto Meta's Messenger Send API request.
 *   { type: 'text',          text }
 *   { type: 'quick_replies', text, options: [{ id, title }] }
 *   { type: 'image',         url }
 * Returns { url, body, headers, extractMessageId(responseData) }.
 */
function buildSendRequest({ accessToken, recipientId, message }) {
  let msg;
  if (message.type === 'quick_replies') {
    msg = {
      text: String(message.text || '').slice(0, 2000),
      quick_replies: (message.options || []).slice(0, 13).map(o => ({
        content_type: 'text',
        title: truncate(o.title || '', 20),
        payload: String(o.id || '').slice(0, 1000)
      }))
    };
  } else if (message.type === 'image') {
    msg = { attachment: { type: 'image', payload: { url: String(message.url || '') } } };
  } else {
    msg = { text: String(message.text || '').slice(0, 2000) };
  }
  return {
    // Token travels in the Authorization header, never the query string —
    // URLs leak into proxy logs, axios error objects, and APM traces.
    url: '/me/messages',
    body: { recipient: { id: String(recipientId) }, message: msg, messaging_type: 'RESPONSE' },
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    extractMessageId: data => data?.message_id || null
  };
}

/**
 * Low-level send. Same contract as whatsapp.service/instagram.service
 * sendRaw: logs the attempt to message_log either way and returns
 * { success, messageId } / { success:false, error }.
 */
async function sendRaw({ recipientId, message }, meta = {}) {
  const { pageId, accessToken } = await resolveCredentials(meta.businessId);
  if (!pageId || !accessToken) {
    throw new Error('Messenger not configured (MESSENGER_PAGE_ID / MESSENGER_ACCESS_TOKEN missing)');
  }
  try {
    const reqSpec = buildSendRequest({ accessToken, recipientId, message });
    const res = await http.post(reqSpec.url, reqSpec.body, { headers: reqSpec.headers });
    const fbMessageId = reqSpec.extractMessageId ? reqSpec.extractMessageId(res.data) : null;
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: message.type || 'unknown',
      content: meta.content || JSON.stringify(message).slice(0, 1000),
      fbMessageId,
      status: 'sent'
    });
    return { success: true, messageId: fbMessageId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    logger.error('Messenger send failed (%s): %s | type=%s to=%s', status || '-', err.message, message.type, recipientId);
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: message.type || 'unknown',
      content: meta.content || JSON.stringify(message).slice(0, 1000),
      status: 'failed'
    });
    return { success: false, error: err.message, status };
  }
}

/**
 * Send a plain text DM.
 */
async function sendText(to, body, meta = {}) {
  const message = { type: 'text', text: String(body || '').slice(0, 2000) };
  return sendRaw({ recipientId: to, message }, { ...meta, content: body });
}

/**
 * Adapter parity with whatsapp.service.sendImage. Messenger image attachments
 * have no caption field, so a caption goes out as a follow-up text message.
 */
async function sendImage(to, imageUrl, caption, meta = {}) {
  const result = await sendRaw(
    { recipientId: to, message: { type: 'image', url: String(imageUrl || '') } },
    { ...meta, content: `[image] ${imageUrl}` }
  );
  if (result.success && caption) {
    await sendText(to, caption, meta);
  }
  return result;
}

/**
 * Send text with quick-reply chips — the Messenger analogue of WhatsApp
 * reply buttons. options = [{ id: 'BTN_1', title: 'Yes' }, ...]
 *
 * Meta allows up to 13 quick replies with 20-char titles; this button-parity
 * wrapper keeps WhatsApp's 3-button cap so all three channels look identical.
 */
async function sendQuickReplies(to, body, options = [], meta = {}) {
  const trimmed = options.slice(0, 3).map((o, i) => ({
    id: String(o.id || `btn_${i}`).slice(0, 256),
    title: truncate(o.title || `Option ${i + 1}`, 20)
  }));
  const message = { type: 'quick_replies', text: String(body || '').slice(0, 2000), options: trimmed };
  return sendRaw({ recipientId: to, message }, { ...meta, content: body });
}

/**
 * Adapter parity with whatsapp.service.sendButtons — same signature, mapped
 * onto quick replies.
 */
async function sendButtons(to, body, buttons = [], meta = {}) {
  return sendQuickReplies(to, body, buttons, meta);
}

/**
 * Adapter parity with whatsapp.service.sendList. Messenger has no list
 * message; sections are flattened into quick-reply chips under the combined
 * header + body text, same as Instagram. Meta's cap is 13 quick replies; we
 * keep 10 to match the WhatsApp list-row cap the conversation flow already
 * paginates for.
 */
async function sendList(to, header, body, sections = [], meta = {}) {
  const rows = sections.flatMap(s => s.rows || []).slice(0, 10).map((r, i) => ({
    id: String(r.id || `row_${i}`).slice(0, 200),
    title: truncate(r.title || `Item ${i + 1}`, 20)
  }));
  const text = [header, body].filter(Boolean).join('\n\n');
  const message = { type: 'quick_replies', text: String(text || '').slice(0, 2000), options: rows };
  return sendRaw({ recipientId: to, message }, { ...meta, content: text });
}

/**
 * Adapter parity with whatsapp.service.markAsRead. Messenger's sender
 * actions API only documents mark_seen/typing_on/typing_off — no read
 * receipt distinct from "seen" — so this stays a deliberate no-op like the
 * Instagram adapter (avoids a second untested API surface for Epic 17).
 */
async function markAsRead(_messageId, _meta = {}) {
  return;
}

/* ================================================================
   High-level templated messages (adapter parity with whatsapp.service)
   ================================================================ */

async function sendPaymentConfirmation(to, { orderNumber, total, businessName, lang, receiptUrl }, meta = {}) {
  const body = t(lang === 'tw' ? 'tw' : 'en', 'payment_received', {
    n: orderNumber,
    total: formatGhs(total),
    shop: businessName || 'your vendor',
    receiptUrl
  });
  return sendText(to, body, meta);
}

module.exports = {
  resolveCredentials,
  sendRaw,
  sendText,
  sendImage,
  sendQuickReplies,
  sendButtons,
  sendList,
  markAsRead,
  sendPaymentConfirmation
};
