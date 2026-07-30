const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { resolveBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/audit-log?business_id=&limit= — the existing audit_log table
 * (settings changes, promo/key/inventory actions, payouts, ...) was
 * admin-only until now. Gated on the 'staff' capability, same as key
 * management, since it surfaces exactly what a business's other staff keys
 * have been doing — owner-only in the default role matrix.
 *
 * resolveBusinessId already pins a tenant key to its own business_id
 * regardless of what's in the query string — same pattern business.routes.js
 * and onboarding.routes.js use, no separate tenant-mismatch check needed.
 */
router.get('/', requirePermission('staff', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const r = await query(
      `SELECT al.id, al.actor_type, al.actor_id, al.action, al.detail, al.created_at,
              ak.name AS actor_key_name, ak.role AS actor_key_role
         FROM audit_log al
         LEFT JOIN api_keys ak ON al.actor_type = 'merchant' AND ak.id::text = al.actor_id
        WHERE al.business_id = $1
        ORDER BY al.created_at DESC
        LIMIT $2`,
      [businessId, limit]
    );
    return respond.ok(req, res, { entries: r.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /audit-log', err);
  }
});

module.exports = router;
