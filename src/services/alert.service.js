const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
const push = require('./push.service');
const { query } = require('../config/database');

// How rarely we're willing to text ops. A crash loop that throws every
// request must not turn into hundreds of WhatsApp messages — one alert
// per window is enough to say "go look at the logs."
const MIN_GAP_MS = 5 * 60 * 1000;

let lastSentAt = 0;
let suppressedSinceLastSend = 0;

/**
 * Fire-and-forget: text the platform's own ops phone when something
 * unhandled blows up, and always records it to admin_alerts so the ops
 * dashboard has a history even when OPS_ALERT_PHONE isn't configured.
 *
 * Uses the platform's own WhatsApp Cloud API credentials (no businessId
 * passed to sendText → falls back to WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN),
 * not any tenant's number.
 */
function alertOps(title, detail) {
  const now = Date.now();
  if (now - lastSentAt < MIN_GAP_MS) {
    suppressedSinceLastSend++;
    return;
  }

  const suppressedNote = suppressedSinceLastSend > 0
    ? `\n(${suppressedSinceLastSend} more error(s) suppressed since the last alert)`
    : '';
  const suppressedCount = suppressedSinceLastSend;
  lastSentAt = now;
  suppressedSinceLastSend = 0;

  query(
    `INSERT INTO admin_alerts (title, detail, suppressed_count) VALUES ($1,$2,$3)`,
    [String(title || '').slice(0, 300), String(detail || '').slice(0, 2000), suppressedCount]
  ).catch(err => logger.warn('alertOps: failed to persist alert history: %s', err.message));

  const to = process.env.OPS_ALERT_PHONE;
  if (!to) return;

  const body = `🚨 WA-B error: ${title}\n\n${String(detail || '').slice(0, 800)}${suppressedNote}`;
  wa.sendText(to, body).catch(err => {
    logger.error('alertOps: failed to send ops alert: %s', err.message);
  });
  push.pushToAdmins({
    title: `🚨 WA-B error: ${title}`,
    body: String(detail || '').slice(0, 200),
    data: { type: 'ops_alert' }
  });
}

module.exports = { alertOps };
