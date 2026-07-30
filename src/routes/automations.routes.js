const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { resolveBusinessId } = require('../middleware/tenantAccess');
const { AUTOMATION_DEFS, resolveConfig } = require('../services/automations');
const respond = require('../utils/response');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/automations?business_id= — every automation template merged with
 * this business's stored enabled/config, defaulting to off with the
 * template's default config for anything never configured. One list, same
 * shape, whether or not a row exists yet — mirrors categories.routes.js's
 * virtual-row merge for the same "not customized yet" reason.
 */
router.get('/', async (req, res) => {
  try {
    // resolveBusinessId already pins a tenant key to its own business_id
    // regardless of what's in the query string — same pattern
    // business.routes.js and onboarding.routes.js use, no separate
    // tenantBlocksBusinessId check needed on top of it.
    const businessId = resolveBusinessId(req);
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    const result = await query('SELECT * FROM automations WHERE business_id = $1', [businessId]);
    const byKey = new Map(result.rows.map(r => [r.key, r]));

    const automations = Object.entries(AUTOMATION_DEFS).map(([key, def]) => {
      const row = byKey.get(key);
      return {
        key,
        label: def.label,
        description: def.description,
        enabled: row ? row.enabled : false,
        config: resolveConfig(key, row?.config)
      };
    });
    return respond.ok(req, res, { automations });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /automations', err);
  }
});

/**
 * PATCH /api/automations/:key — body: { business_id?, enabled?, config? }
 * Upserts (a merchant flipping a template on for the first time has no row
 * yet). config is merged shallowly over whatever's already stored, not
 * replaced — flipping enabled shouldn't require re-sending the whole config.
 */
router.patch('/:key', requirePermission('broadcasts', 'write'), async (req, res) => {
  try {
    const key = req.params.key;
    if (!AUTOMATION_DEFS[key]) {
      return respond.invalid(req, res, `Unknown automation key: ${key}`, { key: 'is not a known automation' });
    }
    const businessId = resolveBusinessId(req);
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }

    const body = req.body || {};
    const enabled = body.enabled !== undefined ? !!body.enabled : undefined;
    let configPatch = null;
    if (body.config !== undefined) {
      if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
        return respond.invalid(req, res, 'config must be an object', { config: 'must be an object' });
      }
      configPatch = body.config;
    }

    const existingRes = await query(
      'SELECT config FROM automations WHERE business_id = $1 AND key = $2',
      [businessId, key]
    );
    const mergedConfig = { ...(existingRes.rows[0]?.config || {}), ...(configPatch || {}) };

    const result = await query(
      `INSERT INTO automations (business_id, key, enabled, config)
       VALUES ($1, $2, COALESCE($3, FALSE), $4)
       ON CONFLICT (business_id, key) DO UPDATE SET
         enabled = COALESCE($3, automations.enabled),
         config = $4,
         updated_at = NOW()
       RETURNING *`,
      [businessId, key, enabled, JSON.stringify(mergedConfig)]
    );
    const row = result.rows[0];
    return respond.ok(req, res, {
      automation: {
        key,
        label: AUTOMATION_DEFS[key].label,
        description: AUTOMATION_DEFS[key].description,
        enabled: row.enabled,
        config: resolveConfig(key, row.config)
      }
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /automations/:key', err);
  }
});

module.exports = router;
