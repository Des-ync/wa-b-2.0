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
 * Format a numeric amount as "GH₵1,234.56".
 */
function formatGhs(amount) {
  const n = Number(amount || 0);
  return `GH₵${n.toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/**
 * Generate a human-friendly order number: ORD-YYYY-XXXXXX.
 * Suffix alphabet omits 0/O/1/I/L so numbers survive being read aloud or
 * retyped from a chat. 31^6 ≈ 887M combinations per year — the old 4-digit
 * suffix (9,000/year, globally unique) started colliding at a few thousand
 * orders and would have hard-failed order creation once exhausted.
 */
const ORDER_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateOrderNumber() {
  const year = new Date().getFullYear();
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += ORDER_SUFFIX_ALPHABET[crypto.randomInt(ORDER_SUFFIX_ALPHABET.length)];
  }
  return `ORD-${year}-${suffix}`;
}

/**
 * Generate a 6-digit numeric OTP (zero-padded, e.g. "042817").
 */
function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
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
 * Strip EVERY credential column from a business row before it leaves the API.
 * Add new secret columns here, not at call sites — this is the single place
 * that decides what a business row may expose.
 */
function sanitizeBusiness(business) {
  if (!business || typeof business !== 'object') return business;
  const {
    wa_access_token: _wa,
    ig_page_access_token: _ig,
    ...safe
  } = business;
  return safe;
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

/**
 * Matches order numbers anywhere in a message — both the legacy 4-digit
 * suffix (ORD-2026-4821) and the current 6-char alphanumeric suffix
 * (ORD-2026-K7M2XQ).
 */
const ORDER_NUMBER_RE = /\bORD-\d{4}-[A-Z0-9]{4,8}\b/i;

/**
 * Typing-indicator delay that decays per conversation: the first reply waits
 * the full base delay, each subsequent reply gets ~35% shorter, down to a floor.
 * `count` is how many replies this conversation has already received recently.
 */
function decayedTypingDelay(count, base = 750, floor = 150) {
  const n = Math.max(0, Number(count) || 0);
  return Math.max(floor, Math.round(base * Math.pow(0.65, n)));
}

/**
 * Build one page of WhatsApp list rows from a product array.
 * WhatsApp allows at most 10 rows per list message TOTAL, so we show
 * `pageSize` products plus prev/next navigation rows when needed.
 *
 * Returns { rows, page, totalPages, hasPrev, hasNext }.
 */
function buildMenuPage(products, page = 0, pageSize = 8) {
  const all = Array.isArray(products) ? products : [];
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), totalPages - 1);
  const slice = all.slice(p * pageSize, (p + 1) * pageSize);

  const rows = slice.map(prod => ({
    id: `prod_${prod.id}`,
    title: truncate(prod.name, 24),
    description: truncate(
      `${formatGhs(prod.price_ghs)}${prod.description ? ' · ' + prod.description : ''}`, 72)
  }));

  const hasPrev = p > 0;
  const hasNext = p < totalPages - 1;
  if (hasPrev) {
    rows.unshift({ id: `menu_page_${p - 1}`, title: '⬅️ Previous items', description: `Back to page ${p}` });
  }
  if (hasNext) {
    rows.push({ id: `menu_page_${p + 1}`, title: '➡️ More items', description: `Page ${p + 2} of ${totalPages}` });
  }

  return { rows, page: p, totalPages, hasPrev, hasNext };
}

/**
 * Parse a "2x Jollof" / "Jollof x2" / "2 × Jollof" style message into
 * { quantity, name }. Returns null when the text isn't a quantity expression.
 * Quantity is clamped to 1–99.
 */
function parseQuantityExpression(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s*[x×*]\s*(.{2,})$/i);
  if (!m) {
    const tail = s.match(/^(.{2,}?)\s*[x×*]\s*(\d{1,2})$/i);
    if (tail) m = [tail[0], tail[2], tail[1]];
  }
  if (!m) return null;
  const quantity = Math.min(99, Math.max(1, parseInt(m[1], 10)));
  const name = m[2].trim();
  if (!name) return null;
  return { quantity, name };
}

/**
 * Is the business open right now in Africa/Accra?
 * open_time/close_time are 'HH:MM' strings; missing/invalid → always open.
 * Supports overnight windows (e.g. 18:00–02:00).
 */
function isWithinBusinessHours(openTime, closeTime, now = new Date()) {
  const parse = t => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const open = parse(openTime);
  const close = parse(closeTime);
  if (open == null || close == null || open === close) return true;

  const accra = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(now);
  const [h, m] = accra.split(':').map(Number);
  const cur = h * 60 + m;

  if (open < close) return cur >= open && cur < close;
  return cur >= open || cur < close; // overnight window
}

module.exports = {
  normalizeGhanaPhone,
  detectNetwork,
  paystackMomoProvider,
  formatGhs,
  generateOrderNumber,
  generateOtp,
  generateReference,
  toWaRecipient,
  toMsisdn,
  addDays,
  formatDate,
  truncate,
  sanitizeBusiness,
  sleep,
  safeJsonParse,
  ORDER_NUMBER_RE,
  decayedTypingDelay,
  buildMenuPage,
  parseQuantityExpression,
  isWithinBusinessHours
};
