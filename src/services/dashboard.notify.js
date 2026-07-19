const logger = require('../utils/logger');
const { query } = require('../config/database');

const TYPES = ['new_order', 'failed_payment', 'low_stock', 'support_request'];

/**
 * Write one row to the dashboard's in-app notification feed. Separate from
 * FCM mobile push (push.service.js) — this is what the web dashboard's bell
 * icon polls, so it works even for merchants who never set up the app.
 * Fire-and-forget: a notification-feed failure should never break the
 * order/payment/stock flow that triggered it.
 */
async function notifyDashboard(businessId, { type, title, body, data } = {}) {
  if (!businessId || !TYPES.includes(type) || !title) return;
  try {
    await query(
      `INSERT INTO dashboard_notifications (business_id, type, title, body, data)
       VALUES ($1,$2,$3,$4,$5)`,
      [businessId, type, title, body || null, JSON.stringify(data || {})]
    );
  } catch (err) {
    logger.warn('notifyDashboard insert failed for business %s: %s', businessId, err.message);
  }
}

module.exports = { notifyDashboard, TYPES };
