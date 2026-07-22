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

// ---------------------------------------------------------------------------
// Transfers (automated merchant payouts) — see accounting.routes.js
// POST /payouts/auto. Replaces the dormant MTN Disbursement path for ALL
// three networks (MTN/Vodafone/AirtelTigo), not just MTN.
// ---------------------------------------------------------------------------

// Ghana mobile money bank_code values are Paystack-assigned and NOT the same
// as the `provider` slugs the /charge momo channel uses above — resolved
// from Paystack's own /bank list rather than hardcoded, since a wrong code
// here would misdirect a real-money transfer. Cached for the process
// lifetime: this is static reference data, not something that changes
// mid-run.
let _momoBankListCache = null;

async function listMobileMoneyBanks() {
  if (_momoBankListCache) return _momoBankListCache;
  ensureConfigured();
  const res = await http.get('/bank', {
    params: { currency: 'GHS', type: 'mobile_money' },
    headers: authHeaders()
  });
  _momoBankListCache = res.data?.data || [];
  return _momoBankListCache;
}

const MOMO_BANK_NAME_HINTS = {
  mtn: ['mtn'],
  // Vodafone Cash was rebranded to Telecel Cash in Ghana in 2024 — match both
  // so this keeps working regardless of which name Paystack's list uses.
  vodafone: ['vodafone', 'telecel'],
  airteltigo: ['airteltigo', 'airtel', 'tigo']
};

/**
 * Pure matching step, split out from resolveMomoBankCode below purely so it's
 * unit-testable without a live network call (same "test the part that
 * doesn't touch the wire" convention mtnmomo.service.test.js already uses).
 * Throws rather than guessing if no match is found — an unrecognized network
 * or an empty/unexpected bank list here would misroute a real payout.
 */
function matchMomoBankCode(banks, network) {
  const hints = MOMO_BANK_NAME_HINTS[network];
  if (!hints) throw new Error(`Unsupported mobile money network for transfers: ${network}`);
  const match = (banks || []).find(b => {
    const name = String(b.name || '').toLowerCase();
    return hints.some(h => name.includes(h));
  });
  if (!match) throw new Error(`No Paystack mobile money bank found matching network "${network}"`);
  return match.code;
}

/**
 * Resolve our internal network code ('mtn'|'vodafone'|'airteltigo') to the
 * bank_code Paystack expects when creating a mobile_money transfer recipient.
 */
async function resolveMomoBankCode(network) {
  const banks = await listMobileMoneyBanks();
  return matchMomoBankCode(banks, network);
}

/**
 * Create a Transfer Recipient for a mobile money payout.
 * Deliberately NOT cached/reused across calls — a stale recipient tied to a
 * merchant's old payout number would misdirect real money, and recipient
 * creation is cheap on Paystack's side, so a fresh one per payout sidesteps
 * that whole class of drift bug for what is an infrequent, manually-
 * triggered action (not a hot path).
 */
async function createTransferRecipient({ name, accountNumber, network }) {
  ensureConfigured();
  const normalized = normalizeGhanaPhone(accountNumber);
  if (!normalized) return { success: false, error: 'Invalid Ghana phone number' };
  try {
    const bankCode = await resolveMomoBankCode(network);
    const res = await http.post('/transferrecipient', {
      type: 'mobile_money',
      name: name || normalized,
      account_number: normalized.replace(/^\+/, ''),
      bank_code: bankCode,
      currency: 'GHS'
    }, { headers: authHeaders() });
    const data = res.data?.data || {};
    return { success: true, recipientCode: data.recipient_code, raw: res.data };
  } catch (err) {
    logger.error('Paystack transfer recipient creation failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Initiate a Transfer (payout) to an already-created recipient.
 *
 * Paystack accounts can have "Approve transfers with OTP" enabled (the
 * account owner gets an SMS OTP that must be submitted to
 * /transfer/finalize_transfer before the money actually moves) — this is a
 * platform-account dashboard security setting, not something this
 * integration can complete on anyone's behalf, since the OTP goes to the
 * PLATFORM's Paystack account owner, not the merchant. When Paystack reports
 * status:'otp', that's surfaced as `requiresOtp: true` rather than treated
 * as an ordinary pending/failure — callers should tell an admin to disable
 * OTP for Transfers in Paystack Dashboard > Settings > Preferences for
 * unattended automated payouts to work at all.
 */
async function initiateTransfer({ amountGhs, recipientCode, reference, reason }) {
  ensureConfigured();
  try {
    const res = await http.post('/transfer', {
      source: 'balance',
      amount: toPesewas(amountGhs),
      recipient: recipientCode,
      reference,
      reason: reason || 'Payout'
    }, { headers: authHeaders() });

    const data = res.data?.data || {};
    if (data.status === 'otp') {
      return {
        success: false,
        requiresOtp: true,
        transferCode: data.transfer_code || null,
        error: 'Transfer requires OTP finalization — disable "Approve transfers with OTP" in Paystack Dashboard > Settings > Preferences for automated payouts',
        raw: res.data
      };
    }

    return {
      success: true,
      status: data.status || 'pending',
      transferCode: data.transfer_code || null,
      reference: data.reference || reference,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack transfer failed: %s | %j', err.message, err.response?.data);
    return {
      success: false,
      transient: isTransientError(err),
      error: err.response?.data?.message || err.message,
      raw: err.response?.data
    };
  }
}

/**
 * Verify a transfer's true status by our own reference — same "the webhook
 * might never arrive" reconciliation role verifyTransaction plays for charges.
 */
async function verifyTransfer(reference) {
  ensureConfigured();
  try {
    const res = await http.get(`/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: authHeaders()
    });
    const data = res.data?.data || {};
    return {
      success: true,
      status: data.status,
      transferCode: data.transfer_code || null,
      reference: data.reference,
      raw: res.data
    };
  } catch (err) {
    logger.error('Paystack transfer verify failed: %s | %j', err.message, err.response?.data);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = {
  initializeMoMoCharge,
  createPaymentLink,
  verifyTransaction,
  refundTransaction,
  verifyPaystackWebhook,
  listMobileMoneyBanks,
  matchMomoBankCode,
  resolveMomoBankCode,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer
};
