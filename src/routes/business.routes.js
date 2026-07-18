const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { normalizeGhanaPhone } = require('../utils/helpers');

const router = express.Router();

router.use(requireAuth('any'));

const SETTINGS_COLUMNS =
  'id, name, welcome_message, support_phone, delivery_fee_ghs, delivery_zones, open_time, close_time';

function resolveBusinessId(req) {
  if (req.auth?.scope === 'admin') return req.query.business_id || req.body?.business_id || null;
  return req.auth?.businessId || null;
}

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** GET /api/business/settings — bot settings for the caller's business. */
router.get('/settings', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    const r = await query(`SELECT ${SETTINGS_COLUMNS} FROM businesses WHERE id = $1`, [businessId]);
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    logger.error('GET /business/settings failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PATCH /api/business/settings
 * Body (all optional): welcome_message, support_phone, delivery_fee_ghs,
 * delivery_zones [{name, fee_ghs}], open_time 'HH:MM', close_time 'HH:MM'.
 * Empty string / null clears a field.
 */
router.patch('/settings', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    const body = req.body || {};
    const sets = [];
    const params = [businessId];
    const set = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if ('welcome_message' in body) {
      const v = body.welcome_message == null ? null : String(body.welcome_message).trim().slice(0, 900);
      set('welcome_message', v || null);
    }
    if ('support_phone' in body) {
      const raw = String(body.support_phone || '').trim();
      if (!raw) {
        set('support_phone', null);
      } else {
        const normalized = normalizeGhanaPhone(raw);
        if (!normalized) return res.status(400).json({ success: false, error: 'support_phone is not a valid Ghana number' });
        set('support_phone', normalized);
      }
    }
    if ('delivery_fee_ghs' in body) {
      const fee = Number(body.delivery_fee_ghs);
      if (!Number.isFinite(fee) || fee < 0 || fee > 10000) {
        return res.status(400).json({ success: false, error: 'delivery_fee_ghs must be a non-negative number' });
      }
      set('delivery_fee_ghs', fee.toFixed(2));
    }
    if ('delivery_zones' in body) {
      const zones = body.delivery_zones == null ? [] : body.delivery_zones;
      if (!Array.isArray(zones) || zones.length > 9) {
        return res.status(400).json({ success: false, error: 'delivery_zones must be an array of at most 9 zones' });
      }
      const clean = [];
      for (const z of zones) {
        const name = String(z?.name || '').trim();
        const fee = Number(z?.fee_ghs);
        if (!name || name.length > 40 || !Number.isFinite(fee) || fee < 0 || fee > 10000) {
          return res.status(400).json({
            success: false,
            error: 'Each zone needs a name (≤40 chars) and a non-negative fee_ghs'
          });
        }
        clean.push({ name, fee_ghs: Number(fee.toFixed(2)) });
      }
      set('delivery_zones', JSON.stringify(clean));
    }
    for (const col of ['open_time', 'close_time']) {
      if (col in body) {
        const v = String(body[col] || '').trim();
        if (v && !TIME_RE.test(v)) {
          return res.status(400).json({ success: false, error: `${col} must be HH:MM (24h)` });
        }
        set(col, v || null);
      }
    }

    if (!sets.length) return res.status(400).json({ success: false, error: 'No recognized settings in body' });

    const r = await query(
      `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING ${SETTINGS_COLUMNS}`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    logger.error('PATCH /business/settings failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
