const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { resolveBusinessId } = require('../middleware/tenantAccess');
const { AUTOMATION_DEFS, resolveConfig } = require('../services/automations');

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
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
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
    res.json({ success: true, automations });
  } catch (err) {
    logger.error('GET /automations failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
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
      return res.status(400).json({ success: false, error: `Unknown automation key: ${key}` });
    }
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });

    const body = req.body || {};
    const enabled = body.enabled !== undefined ? !!body.enabled : undefined;
    let configPatch = null;
    if (body.config !== undefined) {
      if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
        return res.status(400).json({ success: false, error: 'config must be an object' });
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
    res.json({
      success: true,
      automation: {
        key,
        label: AUTOMATION_DEFS[key].label,
        description: AUTOMATION_DEFS[key].description,
        enabled: row.enabled,
        config: resolveConfig(key, row.config)
      }
    });
  } catch (err) {
    logger.error('PATCH /automations/:key failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
