require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { detectNetwork, normalizeGhanaPhone } = require('../utils/helpers');

const BASE_URL = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
// TODO(LIVE): MTN assigns the production X-Target-Environment value (and
// production BASE_URL) as part of Go-Live approval — do not guess it. Sandbox
// always uses the literal string 'sandbox'.
const TARGET_ENVIRONMENT = process.env.MOMO_TARGET_ENVIRONMENT || 'sandbox';

const COLLECTION_SUBSCRIPTION_KEY = process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY;
const COLLECTION_API_USER = process.env.MOMO_COLLECTION_API_USER;
const COLLECTION_API_KEY = process.env.MOMO_COLLECTION_API_KEY;

const DISBURSEMENT_SUBSCRIPTION_KEY = process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY;
const DISBURSEMENT_API_USER = process.env.MOMO_DISBURSEMENT_API_USER;
const DISBURSEMENT_API_KEY = process.env.MOMO_DISBURSEMENT_API_KEY;

const http = axios.create({ baseURL: BASE_URL, timeout: 20_000 });

function ensureConfigured(product) {
  const [key, user, secret] = product === 'collection'
    ? [COLLECTION_SUBSCRIPTION_KEY, COLLECTION_API_USER, COLLECTION_API_KEY]
    : [DISBURSEMENT_SUBSCRIPTION_KEY, DISBURSEMENT_API_USER, DISBURSEMENT_API_KEY];
  if (!key || !user || !secret) {
    const prefix = product === 'collection' ? 'MOMO_COLLECTION' : 'MOMO_DISBURSEMENT';
    throw new Error(`MTN MoMo ${product} credentials are not set (${prefix}_SUBSCRIPTION_KEY / ${prefix}_API_USER / ${prefix}_API_KEY)`);
  }
}

function isConfigured(product = 'collection') {
  try {
    ensureConfigured(product);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * A transport-level failure (timeout, connection reset, 5xx) does NOT mean
 * the charge/payout didn't happen — MTN may have accepted it and just failed
 * to answer us. Callers that can leave a payment 'pending' for reconciliation
 * (rather than immediately marking it failed) should check this first.
 */
function isTransientError(err) {
  const status = err.response?.status;
  return !err.response
    || err.code === 'ECONNABORTED'
    || err.code === 'ETIMEDOUT'
    || (typeof status === 'number' && status >= 500);
}

// One cached bearer token per product — Collections and Disbursements are
// separate MTN subscriptions with their own API user/key and their own token.
const tokenCache = { collection: null, disbursement: null };

async function getAccessToken(product) {
  const cached = tokenCache[product];
  // Refresh 30s early so a request never races token expiry mid-flight.
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  ensureConfigured(product);
  const isCollection = product === 'collection';
  const apiUser = isCollection ? COLLECTION_API_USER : DISBURSEMENT_API_USER;
  const apiKey = isCollection ? COLLECTION_API_KEY : DISBURSEMENT_API_KEY;
  const subscriptionKey = isCollection ? COLLECTION_SUBSCRIPTION_KEY : DISBURSEMENT_SUBSCRIPTION_KEY;
  const basic = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');

  const res = await http.post(`/${product}/token/`, null, {
    headers: {
      Authorization: `Basic ${basic}`,
      'Ocp-Apim-Subscription-Key': subscriptionKey
    }
  });
  const { access_token, expires_in } = res.data || {};
  tokenCache[product] = {
    token: access_token,
    expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000
  };
  return access_token;
}

async function authHeaders(product) {
  const token = await getAccessToken(product);
  const subscriptionKey = product === 'collection' ? COLLECTION_SUBSCRIPTION_KEY : DISBURSEMENT_SUBSCRIPTION_KEY;
  return {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'X-Target-Environment': TARGET_ENVIRONMENT,
    'Content-Type': 'application/json'
  };
}

/**
 * Initiate a Collections RequestToPay — pushes a MoMo approval prompt to the
 * payer's phone. ONLY works for MTN MoMo numbers: this is a wallet-platform
 * limitation (MTN's Collections API cannot reach Vodafone/AirtelTigo
 * wallets), not a config choice — callers must route those networks to a
 * different gateway.
 *
 * MTN requires X-Reference-Id to be a fresh UUID v4, distinct from our own
 * human-readable order reference — we mint one here (`momoRef`) purely for
 * talking to MTN. `callbackBaseUrl`, if given, gets `/${momoRef}` appended so
 * the callback route can identify the transaction from the URL path alone —
 * MTN's callbacks aren't signed, so we never trust the callback body itself,
 * only use it as a trigger to re-poll getPaymentStatus.
 *
 * amount is a decimal GHS string (major units) — NOT pesewas. MTN's API is
 * unlike Paystack's minor-unit convention; do not multiply by 100 here.
 *
 * Returns: { success, momoRef, raw } on success (202 Accepted — async, no
 * final status yet), or { success:false, wrongNetwork?, transient?, error }.
 */
async function requestToPay({ amountGhs, phoneNumber, reference, payerMessage, payeeNote, callbackBaseUrl }) {
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };
  if (detectNetwork(normalized) !== 'mtn') {
    return { success: false, wrongNetwork: true, error: 'Not an MTN MoMo number' };
  }

  const momoRef = crypto.randomUUID();
  try {
    const headers = await authHeaders('collection');
    headers['X-Reference-Id'] = momoRef;
    if (callbackBaseUrl) headers['X-Callback-Url'] = `${callbackBaseUrl.replace(/\/$/, '')}/${momoRef}`;

    await http.post('/collection/v1_0/requesttopay', {
      amount: Number(amountGhs).toFixed(2),
      currency: 'GHS',
      externalId: reference,
      payer: { partyIdType: 'MSISDN', partyId: normalized.replace(/^\+/, '') },
      payerMessage: payerMessage || 'Payment',
      payeeNote: payeeNote || reference
    }, { headers });

    return { success: true, momoRef };
  } catch (err) {
    logger.error('MTN MoMo requestToPay failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      transient: isTransientError(err),
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Poll the authoritative status of a RequestToPay by MTN's own reference id.
 * This is the ONLY source of truth for whether a payment succeeded — a
 * delivered callback is just a doorbell telling us to call this.
 *
 * Returns: { success, status: 'PENDING'|'SUCCESSFUL'|'FAILED', amountGhs,
 *            currency, financialTransactionId, externalId, reason, raw }
 *       or { success:false, error }
 */
async function getPaymentStatus(momoRef) {
  try {
    const headers = await authHeaders('collection');
    const res = await http.get(`/collection/v1_0/requesttopay/${encodeURIComponent(momoRef)}`, { headers });
    const data = res.data || {};
    return {
      success: true,
      status: data.status,
      amountGhs: data.amount != null ? Number(data.amount) : null,
      currency: data.currency || null,
      financialTransactionId: data.financialTransactionId || null,
      externalId: data.externalId || null,
      reason: data.reason || null,
      raw: data
    };
  } catch (err) {
    logger.error('MTN MoMo getPaymentStatus failed for %s: %s | %j', momoRef, err.message, err.response?.data);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Disbursements: Transfer — push money OUT to a payee's MoMo wallet (merchant
 * payout). Same UUID-reference-id / per-transaction-callback-URL pattern as
 * requestToPay, against the separate Disbursement product subscription
 * (its own subscription key + API user/key — Collections credentials do not
 * work here).
 */
async function transfer({ amountGhs, phoneNumber, reference, payerMessage, payeeNote, callbackBaseUrl }) {
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };
  if (detectNetwork(normalized) !== 'mtn') {
    return { success: false, wrongNetwork: true, error: 'Not an MTN MoMo number' };
  }

  const momoRef = crypto.randomUUID();
  try {
    const headers = await authHeaders('disbursement');
    headers['X-Reference-Id'] = momoRef;
    if (callbackBaseUrl) headers['X-Callback-Url'] = `${callbackBaseUrl.replace(/\/$/, '')}/${momoRef}`;

    await http.post('/disbursement/v1_0/transfer', {
      amount: Number(amountGhs).toFixed(2),
      currency: 'GHS',
      externalId: reference,
      payee: { partyIdType: 'MSISDN', partyId: normalized.replace(/^\+/, '') },
      payerMessage: payerMessage || 'Payout',
      payeeNote: payeeNote || reference
    }, { headers });

    return { success: true, momoRef };
  } catch (err) {
    logger.error('MTN MoMo transfer failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      transient: isTransientError(err),
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/** Poll the authoritative status of a Transfer (payout) by MTN's reference id. */
async function getTransferStatus(momoRef) {
  try {
    const headers = await authHeaders('disbursement');
    const res = await http.get(`/disbursement/v1_0/transfer/${encodeURIComponent(momoRef)}`, { headers });
    const data = res.data || {};
    return {
      success: true,
      status: data.status,
      amountGhs: data.amount != null ? Number(data.amount) : null,
      currency: data.currency || null,
      financialTransactionId: data.financialTransactionId || null,
      externalId: data.externalId || null,
      reason: data.reason || null,
      raw: data
    };
  } catch (err) {
    logger.error('MTN MoMo getTransferStatus failed for %s: %s | %j', momoRef, err.message, err.response?.data);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = {
  requestToPay,
  getPaymentStatus,
  transfer,
  getTransferStatus,
  isConfigured
};
