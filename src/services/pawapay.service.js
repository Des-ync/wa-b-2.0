require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { detectNetwork, normalizeGhanaPhone, toMsisdn } = require('../utils/helpers');

const PAWAPAY_API_TOKEN = process.env.PAWAPAY_API_TOKEN;
// Sandbox by default so a misconfigured deploy can never charge real wallets.
const BASE_URL = process.env.PAWAPAY_BASE_URL || 'https://api.sandbox.pawapay.io';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 25_000,
  headers: { 'Content-Type': 'application/json' }
});

function ensureConfigured() {
  if (!PAWAPAY_API_TOKEN) throw new Error('PAWAPAY_API_TOKEN is not set');
}

function authHeaders() {
  return { Authorization: `Bearer ${PAWAPAY_API_TOKEN}` };
}

/**
 * Map our internal network code to pawaPay's Ghana provider code.
 */
function networkToPawapayProvider(network) {
  switch (network) {
    case 'mtn':        return 'MTN_MOMO_GHA';
    case 'vodafone':   return 'VODAFONE_GHA';
    case 'airteltigo': return 'AIRTELTIGO_GHA';
    default:           return 'MTN_MOMO_GHA';
  }
}

/**
 * pawaPay customerMessage: 4-22 alphanumeric characters and spaces.
 */
function toCustomerMessage(description) {
  const cleaned = String(description || '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 22)
    .trim();
  return cleaned.length >= 4 ? cleaned : 'Subscription';
}

/**
 * Initiate a MoMo deposit (collection) for a SaaS subscription fee.
 * Endpoint: POST /v2/deposits — idempotent on depositId, which MUST be a
 * UUID we generate (we use it as billing_transactions.reference so callbacks
 * correlate directly).
 *
 * Returns: { success, status: 'pending'|'failed', depositId, raw }
 */
async function chargeSubscription({ phoneNumber, amountGhs, depositId, description, clientReferenceId }) {
  ensureConfigured();
  const normalized = normalizeGhanaPhone(phoneNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };

  const provider = networkToPawapayProvider(detectNetwork(normalized));

  const body = {
    depositId,
    payer: {
      type: 'MMO',
      accountDetails: {
        phoneNumber: toMsisdn(normalized),
        provider
      }
    },
    amount: Number(amountGhs).toFixed(2),
    currency: 'GHS',
    clientReferenceId: clientReferenceId || undefined,
    customerMessage: toCustomerMessage(description)
  };

  try {
    const res = await http.post('/v2/deposits', body, { headers: authHeaders() });
    const data = res.data || {};

    if (data.status === 'REJECTED') {
      const reason = data.failureReason?.failureMessage || data.failureReason?.failureCode || 'rejected';
      logger.warn('pawaPay deposit rejected depositId=%s: %s', depositId, reason);
      return { success: false, error: reason, raw: data };
    }

    // ACCEPTED → in flight; DUPLICATE_IGNORED → an identical deposit is
    // already in flight (idempotent retry), which is equally "pending".
    return {
      success: true,
      status: 'pending',
      depositId: data.depositId || depositId,
      raw: data
    };
  } catch (err) {
    logger.error('pawaPay deposit failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.failureReason?.failureMessage
        || err.response?.data?.message
        || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Authoritative status check: GET /v2/deposits/{depositId}.
 * This is our callback verification — pawaPay callbacks are only a trigger;
 * the processor always confirms against this endpoint before applying money.
 *
 * Returns: { success, found, status, finalized, completed, failed,
 *            amount, currency, providerTransactionId, failureReason, raw }
 */
async function checkDepositStatus(depositId) {
  ensureConfigured();
  try {
    const res = await http.get(`/v2/deposits/${encodeURIComponent(depositId)}`, {
      headers: authHeaders()
    });
    const found = res.data?.status === 'FOUND';
    const data = res.data?.data || {};
    const status = data.status || 'UNKNOWN';
    return {
      success: true,
      found,
      status,
      finalized: status === 'COMPLETED' || status === 'FAILED',
      completed: status === 'COMPLETED',
      failed: status === 'FAILED',
      amount: data.amount != null ? Number(data.amount) : null,
      currency: data.currency || null,
      providerTransactionId: data.providerTransactionId || null,
      failureReason: data.failureReason || null,
      raw: res.data
    };
  } catch (err) {
    logger.error('pawaPay status check failed for %s: %s | %j', depositId, err.message, err.response?.data);
    return { success: false, error: err.message };
  }
}

/**
 * Extract a normalized result from a pawaPay deposit callback payload.
 * NOTE: never trust this alone — the processor re-verifies via
 * checkDepositStatus() before touching any billing state.
 */
function parseCallback(payload) {
  const depositId = payload?.depositId;
  const status = payload?.status;
  return {
    depositId,
    status,
    completed: status === 'COMPLETED',
    failed: status === 'FAILED',
    amount: payload?.amount != null ? Number(payload.amount) : null,
    currency: payload?.currency || null,
    providerTransactionId: payload?.providerTransactionId || null,
    failureReason: payload?.failureReason || null
  };
}

module.exports = {
  chargeSubscription,
  checkDepositStatus,
  parseCallback,
  networkToPawapayProvider
};
