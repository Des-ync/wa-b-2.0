require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { paystackMomoProvider, detectNetwork, normalizeGhanaPhone, syntheticEmail } = require('../utils/helpers');
const metrics = require('../utils/metrics');

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
 * A transport-level failure (timeout, connection reset, 5xx) does NOT mean
 * the charge didn't happen — Paystack may have accepted it and just failed to
 * answer us. Callers that can leave a charge 'pending' for reconciliation
 * (rather than immediately marking it failed) should check this first.
 */
function isTransientError(err) {
  const status = err.response?.status;
  return !err.response
    || err.code === 'ECONNABORTED'
    || err.code === 'ETIMEDOUT'
    || (typeof status === 'number' && status >= 500);
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
 *   - on failure: { success: false, transient, error, raw } — transient=true means
 *     a transport/5xx error, NOT a confirmed decline; callers should not treat it
 *     as a final failure (see isTransientError).
 */
async function initializeMoMoCharge({ email, amountGhs, phoneNumber, reference, metadata = {} }) {
  ensureConfigured();
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };

  const network = detectNetwork(normalized);
  const provider = paystackMomoProvider(network);

  try {
    const res = await http.post('/charge', {
      email: email || syntheticEmail('customer', reference),
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
      transient: isTransientError(err),
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
      email: email || syntheticEmail('customer', reference),
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
  const start = Date.now();
  try {
    const res = await http.get(`/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: authHeaders()
    });
    metrics.recordTiming('payment_verification_ms', Date.now() - start);
    const data = res.data?.data || {};
    return {
      success: true,
      status: data.status,
      amount_ghs: (data.amount || 0) / 100,
      currency: data.currency || null,
      reference: data.reference,
      gateway_ref: data.id ? String(data.id) : null,
      raw: res.data
    };
  } catch (err) {
    metrics.recordTiming('payment_verification_ms', Date.now() - start);
    logger.error('Paystack verify failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message
    };
  }
}

/**
 * Refund a transaction (fully or partially) by its reference.
 * amountGhs omitted = full refund of whatever Paystack recorded as paid.
 */
async function refundTransaction(reference, amountGhs) {
  ensureConfigured();
  try {
    const body = { transaction: reference };
    if (amountGhs != null) body.amount = toPesewas(amountGhs);
    const res = await http.post('/refund', body, { headers: authHeaders() });
    const data = res.data?.data || {};
    return {
      success: true,
      status: data.status || 'pending',
      gateway_ref: data.id ? String(data.id) : null,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack refund failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Verify x-paystack-signature header (HMAC-SHA512 of raw body).
 *   rawBody MUST be the raw request body (Buffer or string), not the parsed JSON.
 *
 * Fails closed: missing secret, missing signature, malformed signature, or
 * length mismatch all return false. Comparison is timing-safe.
 */
function verifyPaystackWebhook(rawBody, signature, secret = PAYSTACK_SECRET_KEY) {
  if (!secret) {
    logger.error('Paystack webhook verification skipped: PAYSTACK_SECRET_KEY not configured');
    return false;
  }
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) {
    return false;
  }
  if (rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expectedHex = crypto.createHmac('sha512', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  let providedBuf;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch (_e) {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (_e) {
    return false;
  }
}

module.exports = {
  initializeMoMoCharge,
  createPaymentLink,
  verifyTransaction,
  refundTransaction,
  verifyPaystackWebhook
};
