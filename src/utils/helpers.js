const crypto = require('crypto');

/**
 * Normalize a Ghanaian phone number to E.164 format (+233XXXXXXXXX).
 * Accepts: 0241234567, 233241234567, +233241234567, 24 123 4567, etc.
 * Returns null when the input is not recognizably Ghanaian.
 */
function normalizeGhanaPhone(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/[\s\-().]/g, '');

  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+$/.test(s)) return null;

  if (s.startsWith('00233')) s = s.slice(5);
  else if (s.startsWith('233')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);

  if (s.length !== 9) return null;
  if (!/^[2-9]/.test(s)) return null;

  return `+233${s}`;
}

/**
 * Detect Ghanaian mobile network from an E.164 number using NCA prefix allocations.
 *  MTN:        024, 025, 053, 054, 055, 059
 *  Vodafone:   020, 050
 *  AirtelTigo: 026, 027, 056, 057
 */
function detectNetwork(e164) {
  const normalized = normalizeGhanaPhone(e164);
  if (!normalized) return 'other';
  const prefix = normalized.slice(4, 6); // two digits after +233

  const mtn = ['24', '25', '53', '54', '55', '59'];
  const vodafone = ['20', '50'];
  const airteltigo = ['26', '27', '56', '57'];

  if (mtn.includes(prefix)) return 'mtn';
  if (vodafone.includes(prefix)) return 'vodafone';
  if (airteltigo.includes(prefix)) return 'airteltigo';
  return 'other';
}

/**
 * Map our internal network code to Paystack's mobile_money provider code.
 */
function paystackMomoProvider(network) {
  switch (network) {
    case 'mtn': return 'mtn';
    case 'vodafone': return 'vod';
    case 'airteltigo': return 'atl';
    default: return 'mtn';
  }
}

/**
 * Format a numeric amount as "GHS 1,234.56".
 */
function formatGhs(amount) {
  const n = Number(amount || 0);
  return `GHS ${n.toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/**
 * Generate a human-friendly order number: ORD-YYYY-NNNN (random 4-digit suffix).
 */
function generateOrderNumber() {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(1000, 9999);
  return `ORD-${year}-${random}`;
}

/**
 * Generate a unique payment / billing reference.
 */
function generateReference(prefix = 'PAY') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Strip the leading + from an E.164 number (WhatsApp Cloud API expects no +).
 */
function toWaRecipient(e164) {
  if (!e164) return e164;
  return String(e164).replace(/^\+/, '');
}

/**
 * Convert an arbitrary phone (potentially +) to a digits-only MSISDN suitable for Hubtel.
 */
function toMsisdn(e164) {
  const normalized = normalizeGhanaPhone(e164) || e164;
  return String(normalized).replace(/[^\d]/g, '');
}

/**
 * Add days to a Date.
 */
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Format a date as YYYY-MM-DD.
 */
function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

/**
 * Truncate a string to N chars with ellipsis (used for WhatsApp interactive limits).
 */
function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * Sleep helper for retry/backoff loops.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe JSON parse — returns fallback on error.
 */
function safeJsonParse(value, fallback = null) {
  try {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

module.exports = {
  normalizeGhanaPhone,
  detectNetwork,
  paystackMomoProvider,
  formatGhs,
  generateOrderNumber,
  generateReference,
  toWaRecipient,
  toMsisdn,
  addDays,
  formatDate,
  truncate,
  sleep,
  safeJsonParse
};
