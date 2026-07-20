const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission, issueKey, revokeKey, rotateKey, VALID_ROLES } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

router.use(requireAuth('any'));

const KEY_COLUMNS = 'id, business_id, name, scope, role, expires_at, last_used_at, last_used_ip, revoked_at, rotated_from, created_at';

/**
 * GET /api/keys?business_id= — every key for a business, oldest revoked
 * ones included so a rotation trail is visible. Never returns the hash.
 */
router.get('/', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const r = await query(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE business_id = $1 ORDER BY created_at DESC`,
      [businessId]
    );
    res.json({ success: true, keys: r.rows });
  } catch (err) {
    logger.error('GET /keys failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/keys — issue a new role-scoped key for the business's own
 * staff. Owner-only: this IS the staff-access surface (see permissions.js).
 * Body: { business_id?, name, role, expires_at? }
 */
router.post('/', requirePermission('staff'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const role = req.body?.role || 'manager';
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `role must be one of ${VALID_ROLES.join(', ')}` });
    }
    let expiresAt = null;
    if (req.body?.expires_at) {
      expiresAt = new Date(req.body.expires_at);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
        return res.status(400).json({ success: false, error: 'expires_at must be a valid future date' });
      }
    }

    const key = await issueKey({ name, businessId, scope: 'tenant', role, expiresAt });
    recordAudit({
      actorType: 'merchant', actorId: req.auth?.clerkUserId || req.auth?.keyId, businessId,
      action: 'api_key.issue', detail: { key_id: key.id, name, role }
    });
    res.status(201).json({ success: true, key });
  } catch (err) {
    logger.error('POST /keys failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/** POST /api/keys/:id/revoke */
router.post('/:id/revoke', requirePermission('staff'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM api_keys WHERE id = $1', [req.params.id]);
    const key = existing.rows[0];
    if (!key) return res.status(404).json({ success: false, error: 'Key not found' });
    if (tenantBlocksBusinessId(req, key.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const ok = await revokeKey(req.params.id);
    if (!ok) return res.status(409).json({ success: false, error: 'Key already revoked' });
    recordAudit({
      actorType: 'merchant', actorId: req.auth?.clerkUserId || req.auth?.keyId, businessId: key.business_id,
      action: 'api_key.revoke', detail: { key_id: key.id, name: key.name }
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /keys/:id/revoke failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/keys/:id/rotate — revoke this key and issue a fresh one with
 * the same name/role/expiry. New plaintext is returned exactly once.
 */
router.post('/:id/rotate', requirePermission('staff'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM api_keys WHERE id = $1', [req.params.id]);
    const key = existing.rows[0];
    if (!key) return res.status(404).json({ success: false, error: 'Key not found' });
    if (tenantBlocksBusinessId(req, key.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const fresh = await rotateKey(req.params.id);
    recordAudit({
      actorType: 'merchant', actorId: req.auth?.clerkUserId || req.auth?.keyId, businessId: key.business_id,
      action: 'api_key.rotate', detail: { old_key_id: key.id, new_key_id: fresh.id, name: key.name }
    });
    res.json({ success: true, key: fresh });
  } catch (err) {
    logger.error('POST /keys/:id/rotate failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
