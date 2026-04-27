require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { paystackMomoProvider, detectNetwork, normalizeGhanaPhone } = require('../utils/helpers');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const BASE_URL = 'https://api.paystack.co';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' }
});

function authHeaders() {
  return { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` };
}

function ensureConfigured() {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not set');
}

/**
 * Convert GHS to pesewas (Paystack expects integer minor units).
 */
function toPesewas(ghs) {
  return Math.round(Number(ghs) * 100);
}

/**
 * Initialize a mobile money charge.
 * Uses Paystack /charge with channel=mobile_money. Provider is auto-detected from the phone.
 *
 * Returns: { success, status, reference, display_text, raw }
 *   - status: pending | send_otp | success | failed
 */
async function initializeMoMoCharge({ email, amountGhs, phoneNumber, reference, metadata = {} }) {
  ensureConfigured();
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };

  const network = detectNetwork(normalized);
  const provider = paystackMomoProvider(network);

  try {
    const res = await http.post('/charge', {
      email: email || `customer+${reference}@whatsapp-saas.local`,
      amount: toPesewas(amountGhs),
      currency: 'GHS',
      reference,
      mobile_money: {
        phone: normalized.replace(/^\+/, ''),
        provider
      },
      metadata
    }, { headers: authHeaders() });

    const data = res.data?.data || {};
    return {
      success: true,
      status: data.status || 'pending',
      reference: data.reference || reference,
      display_text: data.display_text || null,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack MoMo charge failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Create a hosted card payment link via /transaction/initialize.
 * Returns: { success, authorization_url, reference, raw }
 */
async function createPaymentLink({ email, amountGhs, reference, callbackUrl, metadata = {} }) {
  ensureConfigured();
  try {
    const res = await http.post('/transaction/initialize', {
      email: email || `customer+${reference}@whatsapp-saas.local`,
      amount: toPesewas(amountGhs),
      currency: 'GHS',
      reference,
      callback_url: callbackUrl,
      channels: ['card', 'mobile_money', 'bank', 'ussd'],
      metadata
    }, { headers: authHeaders() });

    const data = res.data?.data || {};
    return {
      success: true,
      authorization_url: data.authorization_url,
      reference: data.reference || reference,
      access_code: data.access_code,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack init failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Verify a transaction by reference.
 */
async function verifyTransaction(reference) {
  ensureConfigured();
  try {
    const res = await http.get(`/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: authHeaders()
    });
    const data = res.data?.data || {};
    return {
      success: true,
      status: data.status,
      amount_ghs: (data.amount || 0) / 100,
      reference: data.reference,
      gateway_ref: data.id ? String(data.id) : null,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack verify failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message
    };
  }
}

/**
 * Verify x-paystack-signature header (HMAC-SHA512 of raw body).
 *   rawBody MUST be the raw request body (Buffer or string), not the parsed JSON.
 */
function verifyPaystackWebhook(rawBody, signature, secret = PAYSTACK_SECRET_KEY) {
  if (!signature || !secret) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha512', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch (_e) {
    return false;
  }
}

module.exports = {
  initializeMoMoCharge,
  createPaymentLink,
  verifyTransaction,
  verifyPaystackWebhook
};
