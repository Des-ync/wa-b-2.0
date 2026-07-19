const logger = require('../utils/logger');
const wa = require('./whatsapp.service');

// How rarely we're willing to text ops. A crash loop that throws every
// request must not turn into hundreds of WhatsApp messages — one alert
// per window is enough to say "go look at the logs."
const MIN_GAP_MS = 5 * 60 * 1000;

let lastSentAt = 0;
let suppressedSinceLastSend = 0;

/**
 * Fire-and-forget: text the platform's own ops phone when something
 * unhandled blows up. No-op if OPS_ALERT_PHONE isn't configured, so
 * this is safe to call from every deployment without extra setup.
 *
 * Uses the platform's own WhatsApp Cloud API credentials (no businessId
 * passed to sendText → falls back to WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN),
 * not any tenant's number.
 */
function alertOps(title, detail) {
  const to = process.env.OPS_ALERT_PHONE;
  if (!to) return;

  const now = Date.now();
  if (now - lastSentAt < MIN_GAP_MS) {
    suppressedSinceLastSend++;
    return;
  }

  const suppressedNote = suppressedSinceLastSend > 0
    ? `\n(${suppressedSinceLastSend} more error(s) suppressed since the last alert)`
    : '';
  lastSentAt = now;
  suppressedSinceLastSend = 0;

  const body = `🚨 WA-B error: ${title}\n\n${String(detail || '').slice(0, 800)}${suppressedNote}`;
  wa.sendText(to, body).catch(err => {
    logger.error('alertOps: failed to send ops alert: %s', err.message);
  });
}

module.exports = { alertOps };
