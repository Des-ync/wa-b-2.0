const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Record an account/settings-level action for the audit trail. Best-effort
 * and fire-and-forget by convention (callers don't await unless they need
 * to) — an audit-log write must never block or fail the action it's
 * recording.
 */
async function recordAudit({ actorType, actorId, businessId, action, detail }) {
  try {
    await query(
      `INSERT INTO audit_log (actor_type, actor_id, business_id, action, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [actorType, actorId != null ? String(actorId) : null, businessId || null, action, JSON.stringify(detail || {})]
    );
  } catch (err) {
    logger.warn('recordAudit failed (action=%s): %s', action, err.message);
  }
}

module.exports = { recordAudit };
