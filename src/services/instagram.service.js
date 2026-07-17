require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { formatGhs, truncate } = require('../utils/helpers');

/**
 * Instagram DM channel — mirrors the structure of whatsapp.service.js:
 * resolveCredentials (per-tenant with env fallback), sendRaw, logOutbound into
 * message_log, sendText, and sendQuickReplies (the analogue of sendButtons).
 *
 * IMPORTANT — wire format is NOT implemented yet. Every place that needs a
 * real Instagram Messaging API detail (endpoint path, auth placement, payload
 * field names) is a clearly marked TODO(IG-API) stub. Until those stubs are
 * filled in from Meta's docs, sends fail loudly with a descriptive error
 * instead of guessing Meta's wire format. All surrounding plumbing (credential
 * resolution, tenant isolation, message_log audit) is real and final.
 */

const IG_API_VERSION = process.env.IG_API_VERSION || 'v19.0';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID;

// TODO(IG-API): verify against Meta's Instagram Messaging API docs — confirm
// the correct Graph host + version prefix for Instagram Messaging sends.
const BASE_URL = `https://graph.facebook.com/${IG_API_VERSION}`;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * Resolve per-tenant Instagram credentials, falling back to global env vars.
 * Tenant credentials live in businesses.ig_business_account_id /
 * ig_page_access_token.
 *
 * Safety (same rule as WhatsApp): a tenant routed on its OWN IG account id
 * but missing its page access token must fail loudly — silently falling back
 * to the platform credentials would send its replies from the platform's IG
 * account, leaking messages across tenants.
 */
async function resolveCredentials(businessId) {
  if (businessId) {
    try {
      const res = await query(
        `SELECT ig_business_account_id, ig_page_access_token FROM businesses WHERE id = $1`,
        [businessId]
      );
      const biz = res.rows[0];
      if (biz && biz.ig_business_account_id && biz.ig_page_access_token) {
        return { igAccountId: biz.ig_business_account_id, accessToken: biz.ig_page_access_token };
      }
      if (
        biz && biz.ig_business_account_id && !biz.ig_page_access_token &&
        biz.ig_business_account_id !== IG_BUSINESS_ACCOUNT_ID
      ) {
        throw new Error(
          `Business ${businessId} has its own ig_business_account_id but no ig_page_access_token — refusing to send from the platform account`
        );
      }
    } catch (err) {
      if (/refusing to send/.test(err.message)) throw err;
      logger.warn('IG resolveCredentials: DB lookup failed for businessId=%s, falling back to global: %s', businessId, err.message);
    }
  }
  return { igAccountId: IG_BUSINESS_ACCOUNT_ID, accessToken: IG_ACCESS_TOKEN };
}

async function logOutbound({ businessId, customerId, type, content, igMessageId, status }) {
  try {
    // message_log.wa_message_id doubles as the channel-native message id; IG
    // mids and WA mids never collide, and the unique dedupe index still holds.
    await query(
      `INSERT INTO message_log
        (business_id, customer_id, direction, message_type, content, wa_message_id, status)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6)`,
      [businessId || null, customerId || null, type, content || '', igMessageId || null, status || 'sent']
    );
  } catch (err) {
    logger.warn('Failed to log outbound IG message: %s', err.message);
  }
}

/**
 * TODO(IG-API): verify against Meta's Instagram Messaging API docs — endpoint
 * path, whether the access token goes in a query param or Authorization
 * header, the exact request body field names for text and quick-reply sends,
 * and the response field carrying the sent message id. Do not guess.
 *
 * `message` is our channel-agnostic descriptor:
 *   { type: 'text',          text }
 *   { type: 'quick_replies', text, options: [{ id, title }] }
 *
 * Must return: { url, body, headers, extractMessageId(responseData) }
 */
function buildSendRequest({ igAccountId, accessToken, recipientId, message }) { // eslint-disable-line no-unused-vars
  throw new Error(
    'Instagram send not implemented — fill buildSendRequest() from Meta\'s Instagram Messaging API docs (TODO(IG-API))'
  );
}

/**
 * Low-level send. Same contract as whatsapp.service sendRaw: logs the attempt
 * to message_log either way and returns { success, messageId } / { success:false, error }.
 */
async function sendRaw({ recipientId, message }, meta = {}) {
  const { igAccountId, accessToken } = await resolveCredentials(meta.businessId);
  if (!igAccountId || !accessToken) {
    throw new Error('Instagram Messaging not configured (IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN missing)');
  }
  try {
    const reqSpec = buildSendRequest({ igAccountId, accessToken, recipientId, message });
    const res = await http.post(reqSpec.url, reqSpec.body, { headers: reqSpec.headers });
    const igMessageId = reqSpec.extractMessageId ? reqSpec.extractMessageId(res.data) : null;
    await logOutbound({
      businessId: meta.businessId,
      customerId: meta.customerId,
      type: message.type || 'unknown',
      content: meta.content || JSON.stringify(message).slice(0, 1000),
      igMessageId,
      status: 'sent'
    });
    return { success: true, messageId: igMessageId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    logger.error('Instagram send failed (%s): %s | type=%s to=%s', status || '-', err.message, message.type, recipientId);
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
  const message = { type: 'text', text: String(body || '').slice(0, 1000) };
  return sendRaw({ recipientId: to, message }, { ...meta, content: body });
}

/**
 * Send text with quick-reply chips — the Instagram analogue of WhatsApp reply
 * buttons. options = [{ id: 'BTN_1', title: 'Yes' }, ...]
 *
 * TODO(IG-API): verify against Meta's Instagram Messaging API docs — the
 * maximum number of quick replies and title length limits. The caps below are
 * conservative placeholders, not confirmed values.
 */
async function sendQuickReplies(to, body, options = [], meta = {}) {
  const trimmed = options.slice(0, 3).map((o, i) => ({
    id: String(o.id || `btn_${i}`).slice(0, 256),
    title: truncate(o.title || `Option ${i + 1}`, 20)
  }));
  const message = { type: 'quick_replies', text: String(body || '').slice(0, 1000), options: trimmed };
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
 * Adapter parity with whatsapp.service.sendList. Instagram has no list
 * message; sections are flattened into quick-reply chips under the combined
 * header + body text.
 *
 * TODO(IG-API): verify against Meta's Instagram Messaging API docs — confirm
 * the quick-reply count cap so long menus paginate correctly. Capped at 10
 * here as a conservative placeholder (matches the WhatsApp list-row cap the
 * conversation flow already paginates for).
 */
async function sendList(to, header, body, sections = [], meta = {}) {
  const rows = sections.flatMap(s => s.rows || []).slice(0, 10).map((r, i) => ({
    id: String(r.id || `row_${i}`).slice(0, 200),
    title: truncate(r.title || `Item ${i + 1}`, 20)
  }));
  const text = [header, body].filter(Boolean).join('\n\n');
  const message = { type: 'quick_replies', text: String(text || '').slice(0, 1000), options: rows };
  return sendRaw({ recipientId: to, message }, { ...meta, content: text });
}

/**
 * Adapter parity with whatsapp.service.markAsRead.
 *
 * TODO(IG-API): verify against Meta's Instagram Messaging API docs — whether
 * a read-receipt / typing (sender action) endpoint exists for IG messaging
 * and its request shape. No-op until confirmed.
 */
async function markAsRead(_messageId, _meta = {}) {
  return;
}

/* ================================================================
   High-level templated messages (adapter parity with whatsapp.service)
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

module.exports = {
  resolveCredentials,
  sendRaw,
  sendText,
  sendQuickReplies,
  sendButtons,
  sendList,
  markAsRead,
  sendPaymentConfirmation
};
