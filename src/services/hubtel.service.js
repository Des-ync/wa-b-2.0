require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { detectNetwork, normalizeGhanaPhone, toMsisdn, syntheticEmail } = require('../utils/helpers');

const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID;
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET;
const HUBTEL_MERCHANT_ACCOUNT_NUMBER = process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER;
const HUBTEL_WEBHOOK_SECRET = process.env.HUBTEL_WEBHOOK_SECRET;

const BASE_URL = 'https://api.hubtel.com';

function ensureConfigured() {
  if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET || !HUBTEL_MERCHANT_ACCOUNT_NUMBER) {
    throw new Error('Hubtel credentials missing (CLIENT_ID / CLIENT_SECRET / MERCHANT_ACCOUNT_NUMBER)');
  }
}

function basicAuth() {
  const token = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function networkToHubtelChannel(network) {
  switch (network) {
    case 'mtn':        return 'mtn-gh';
    case 'vodafone':   return 'vodafone-gh';
    case 'airteltigo': return 'tigo-gh';
    default:           return 'mtn-gh';
  }
}

/**
 * Charge a customer's MoMo wallet for a SaaS subscription fee.
 * Endpoint: POST /v1/merchantaccount/merchants/{merchantId}/receive/mobilemoney
 *
 * Returns: { success, status, token, responseCode, transactionId, raw }
 */
async function chargeSubscription({ phoneNumber, amountGhs, reference, description, callbackUrl, primaryCallbackUrl, secondaryCallbackUrl }) {
  ensureConfigured();
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };

  const channel = networkToHubtelChannel(detectNetwork(normalized));
  const msisdn = toMsisdn(normalized);

  const body = {
    CustomerName: 'SaaS Subscriber',
    CustomerMsisdn: msisdn,
    CustomerEmail: `subscriber+${reference}@whatsapp-saas.local`,
    Channel: channel,
    Amount: Number(amountGhs),
    PrimaryCallbackUrl: primaryCallbackUrl || callbackUrl,
    SecondaryCallbackUrl: secondaryCallbackUrl || callbackUrl,
    Description: description || `SaaS subscription ${reference}`,
    ClientReference: reference
  };

  const url = `${BASE_URL}/v1/merchantaccount/merchants/${encodeURIComponent(HUBTEL_MERCHANT_ACCOUNT_NUMBER)}/receive/mobilemoney`;

  try {
    const res = await axios.post(url, body, {
      headers: { ...basicAuth(), 'Content-Type': 'application/json' },
      timeout: 25_000
    });
    const data = res.data?.Data || res.data?.data || res.data || {};
    const responseCode = res.data?.ResponseCode || res.data?.responseCode || data.ResponseCode;
    return {
      success: true,
      status: data.Status || data.status || (responseCode === '0001' ? 'pending' : 'unknown'),
      token: data.Token || data.token || null,
      transactionId: data.TransactionId || data.transactionId || null,
      responseCode,
      raw: res.data
    };
  } catch (err) {
    logger.error('Hubtel MoMo charge failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.Message || err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Query the status of a previously initiated Hubtel transaction.
 */
async function checkTransactionStatus(clientReference) {
  ensureConfigured();
  try {
    const url = `${BASE_URL}/v1/merchantaccount/merchants/${encodeURIComponent(HUBTEL_MERCHANT_ACCOUNT_NUMBER)}/transactions/status?clientReference=${encodeURIComponent(clientReference)}`;
    const res = await axios.get(url, { headers: basicAuth(), timeout: 15_000 });
    const data = res.data?.Data || res.data?.data || res.data || {};
    return {
      success: true,
      status: data.TransactionStatus || data.transactionStatus || data.Status || 'unknown',
      raw: res.data
    };
  } catch (err) {
    logger.error('Hubtel status check failed: %s | %j', err.message, err.response?.data);
    return { success: false, error: err.message };
  }
}

/**
 * Verify Hubtel webhook signature using HMAC-SHA256 of raw body.
 * Hubtel sends the signature in `x-hubtel-signature` (configurable per merchant).
 *
 * Fails closed in all environments — including missing secret. Operators MUST
 * set HUBTEL_WEBHOOK_SECRET. The previous "skip when secret missing" behavior
 * has been removed because it was a footgun in production.
 *
 *   rawBody MUST be the raw request body (Buffer or string), not the parsed JSON.
 */
function verifyHubtelWebhook(rawBody, signature, secret = HUBTEL_WEBHOOK_SECRET) {
  if (!secret) {
    logger.error('Hubtel webhook verification skipped: HUBTEL_WEBHOOK_SECRET not configured');
    return false;
  }
  if (typeof signature !== 'string' || !signature) return false;
  if (rawBody == null) return false;

  const provided = signature.replace(/^sha256=/i, '').trim();
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expectedHex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  let providedBuf;
  try {
    providedBuf = Buffer.from(provided, 'hex');
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

/**
 * Extract a normalized result from a Hubtel webhook payload.
 * Hubtel sends fields like ResponseCode, Status, ClientReference, Data.TransactionId, etc.
 */
function parseHubtelCallback(payload) {
  const responseCode = payload?.ResponseCode || payload?.responseCode || payload?.Data?.ResponseCode;
  const status = payload?.Status || payload?.status || payload?.Data?.Status;
  const clientReference = payload?.Data?.ClientReference || payload?.ClientReference || payload?.clientReference;
  const transactionId = payload?.Data?.TransactionId || payload?.TransactionId || payload?.transactionId;
  const amount = payload?.Data?.Amount || payload?.Amount;

  const isSuccess =
    responseCode === '0000' ||
    responseCode === 0 ||
    String(status).toLowerCase() === 'success' ||
    String(status).toLowerCase() === 'paid';

  return {
    success: !!isSuccess,
    responseCode,
    status,
    reference: clientReference,
    transactionId,
    amount: amount ? Number(amount) : null
  };
}

module.exports = {
  chargeSubscription,
  checkTransactionStatus,
  verifyHubtelWebhook,
  parseHubtelCallback
};
