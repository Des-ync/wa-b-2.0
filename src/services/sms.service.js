require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../config/database');

/**
 * SMS — a FALLBACK channel only, not a primary one. It exists for the moment
 * a WhatsApp/Instagram/Messenger send fails (customer blocked the number,
 * 24h session window closed, account restricted, etc.) but we still owe them
 * a receipt or a reminder. Callers decide when to fall back; this service
 * never runs on its own.
 *
 * Provider: Africa's Talking Bulk SMS (api.africastalking.com), the standard
 * choice for GH-market sending — implemented from their public docs
 * (developers.africastalking.com/docs/sms/sending/bulk):
 *   POST https://api.africastalking.com/version1/messaging
 *   Headers: apiKey: <key>, Content-Type: application/x-www-form-urlencoded, Accept: application/json
 *   Body:    username, to (E.164), message, from (optional registered sender id)
 *   Response: { SMSMessageData: { Recipients: [{ status, statusCode, messageId, cost, number }] } }
 *
 * SMS_PROVIDER=console (default, no credentials required) logs the message
 * instead of sending — the same "print instead of deliver" fallback other
 * unconfigured integrations in this codebase use, so local/dev never needs
 * live SMS credentials to exercise the fallback path.
 */

const SMS_PROVIDER = process.env.SMS_PROVIDER || 'console';
const AT_API_KEY = process.env.AT_API_KEY;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_SENDER_ID = process.env.AT_SENDER_ID || undefined;
const AT_BASE_URL = process.env.AT_BASE_URL || 'https://api.africastalking.com';

const http = axios.create({ timeout: 15_000 });

async function logOutbound({ businessId, customerId, content, providerMessageId, status }) {
  try {
    await query(
      `INSERT INTO message_log
        (business_id, customer_id, direction, message_type, content, wa_message_id, status)
       VALUES ($1,$2,'outbound','sms',$3,$4,$5)`,
      [businessId || null, customerId || null, content || '', providerMessageId || null, status || 'sent']
    );
  } catch (err) {
    logger.warn('Failed to log outbound SMS: %s', err.message);
  }
}

async function sendViaAfricasTalking(to, body) {
  if (!AT_API_KEY || !AT_USERNAME) {
    throw new Error('SMS not configured (AT_API_KEY / AT_USERNAME missing)');
  }
  const params = new URLSearchParams({ username: AT_USERNAME, to, message: body });
  if (AT_SENDER_ID) params.set('from', AT_SENDER_ID);

  const res = await http.post(`${AT_BASE_URL}/version1/messaging`, params, {
    headers: {
      apiKey: AT_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
  });
  const recipient = res.data?.SMSMessageData?.Recipients?.[0];
  if (!recipient || !['Success', 'Sent', 'Queued'].includes(recipient.status)) {
    throw new Error(`Africa's Talking rejected the message: ${recipient?.status || 'unknown status'}`);
  }
  return { messageId: recipient.messageId || null };
}

/**
 * Send a plain-text SMS. Returns { success, messageId } / { success:false, error }
 * — never throws, so a fallback send can never itself break the caller's
 * primary flow (e.g. an order-paid notification that also tries SMS).
 */
async function sendSms(to, body, meta = {}) {
  const text = String(body || '').slice(0, 640); // ~4 GSM-7 concat segments
  if (!to) return { success: false, error: 'Missing recipient phone number' };

  if (SMS_PROVIDER === 'console') {
    logger.info('📱 SMS (console mode, set SMS_PROVIDER=africastalking to send for real) → %s: %s', to, text);
    await logOutbound({ ...meta, content: text, status: 'sent' });
    return { success: true, messageId: null };
  }

  try {
    const { messageId } = await sendViaAfricasTalking(to, text);
    await logOutbound({ ...meta, content: text, providerMessageId: messageId, status: 'sent' });
    return { success: true, messageId };
  } catch (err) {
    logger.error('SMS send failed to %s: %s', to, err.message);
    await logOutbound({ ...meta, content: text, status: 'failed' });
    return { success: false, error: err.message };
  }
}

module.exports = { sendSms };
