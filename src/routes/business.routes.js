const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { normalizeGhanaPhone } = require('../utils/helpers');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

router.use(requireAuth('any'));

const SETTINGS_COLUMNS =
  'id, name, owner_name, welcome_message, support_phone, delivery_fee_ghs, delivery_zones, open_time, close_time, ' +
  'bot_language, payout_momo_number, payout_momo_network, ' +
  'cart_nudge_enabled, cart_nudge_delay_minutes, cart_nudge_max_per_cart, ' +
  'cart_nudge_message_template, cart_nudge_template_b, cart_nudge_coupon_code, ' +
  'loyalty_enabled, loyalty_points_per_ghs, loyalty_points_redemption_rate_ghs, ' +
  'loyalty_stamps_target, loyalty_free_item_value_ghs, loyalty_referral_reward_ghs, ' +
  'loyalty_birthday_discount_type, loyalty_birthday_discount_value, loyalty_vip_tiers';

const MOMO_NETWORKS = ['mtn', 'vodafone', 'airteltigo'];

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
    if ('bot_language' in body) {
      const v = String(body.bot_language || 'en').trim();
      if (!['en', 'tw'].includes(v)) {
        return res.status(400).json({ success: false, error: "bot_language must be 'en' or 'tw'" });
      }
      set('bot_language', v);
    }
    if ('name' in body) {
      const v = String(body.name || '').trim();
      if (!v || v.length > 200) return res.status(400).json({ success: false, error: 'name is required (max 200 chars)' });
      set('name', v);
    }
    if ('owner_name' in body) {
      const v = String(body.owner_name || '').trim();
      if (v.length > 200) return res.status(400).json({ success: false, error: 'owner_name too long (max 200 chars)' });
      set('owner_name', v || null);
    }
    if ('payout_momo_number' in body) {
      const raw = String(body.payout_momo_number || '').trim();
      if (!raw) {
        set('payout_momo_number', null);
      } else {
        const normalized = normalizeGhanaPhone(raw);
        if (!normalized) return res.status(400).json({ success: false, error: 'payout_momo_number is not a valid Ghana number' });
        set('payout_momo_number', normalized);
      }
    }
    if ('payout_momo_network' in body) {
      const v = String(body.payout_momo_network || '').trim().toLowerCase();
      if (!v) {
        set('payout_momo_network', null);
      } else if (!MOMO_NETWORKS.includes(v)) {
        return res.status(400).json({ success: false, error: `payout_momo_network must be one of ${MOMO_NETWORKS.join(', ')}` });
      } else {
        set('payout_momo_network', v);
      }
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
    if ('cart_nudge_enabled' in body) {
      set('cart_nudge_enabled', !!body.cart_nudge_enabled);
    }
    if ('cart_nudge_delay_minutes' in body) {
      const n = Number(body.cart_nudge_delay_minutes);
      if (!Number.isInteger(n) || n < 5 || n > 1440) {
        return res.status(400).json({ success: false, error: 'cart_nudge_delay_minutes must be an integer between 5 and 1440' });
      }
      set('cart_nudge_delay_minutes', n);
    }
    if ('cart_nudge_max_per_cart' in body) {
      const n = Number(body.cart_nudge_max_per_cart);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return res.status(400).json({ success: false, error: 'cart_nudge_max_per_cart must be an integer between 1 and 5' });
      }
      set('cart_nudge_max_per_cart', n);
    }
    for (const col of ['cart_nudge_message_template', 'cart_nudge_template_b']) {
      if (col in body) {
        const v = body[col] == null ? null : String(body[col]).trim().slice(0, 900);
        set(col, v || null);
      }
    }
    if ('cart_nudge_coupon_code' in body) {
      const v = body.cart_nudge_coupon_code == null ? null : String(body.cart_nudge_coupon_code).trim().toUpperCase().slice(0, 40);
      set('cart_nudge_coupon_code', v || null);
    }
    if ('loyalty_enabled' in body) set('loyalty_enabled', !!body.loyalty_enabled);
    for (const [col, min, max] of [
      ['loyalty_points_per_ghs', 0, 100],
      ['loyalty_points_redemption_rate_ghs', 0, 10],
      ['loyalty_free_item_value_ghs', 0, 10000],
      ['loyalty_referral_reward_ghs', 0, 10000],
      ['loyalty_birthday_discount_value', 0, 10000]
    ]) {
      if (col in body) {
        const n = Number(body[col]);
        if (!Number.isFinite(n) || n < min || n > max) {
          return res.status(400).json({ success: false, error: `${col} must be a number between ${min} and ${max}` });
        }
        set(col, n);
      }
    }
    if ('loyalty_stamps_target' in body) {
      const n = Number(body.loyalty_stamps_target);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        return res.status(400).json({ success: false, error: 'loyalty_stamps_target must be an integer between 0 and 100 (0 disables it)' });
      }
      set('loyalty_stamps_target', n);
    }
    if ('loyalty_birthday_discount_type' in body) {
      const v = String(body.loyalty_birthday_discount_type || '');
      if (!['percent', 'fixed'].includes(v)) {
        return res.status(400).json({ success: false, error: "loyalty_birthday_discount_type must be 'percent' or 'fixed'" });
      }
      set('loyalty_birthday_discount_type', v);
    }
    if ('loyalty_vip_tiers' in body) {
      const tiers = body.loyalty_vip_tiers;
      if (!Array.isArray(tiers) || tiers.length > 10) {
        return res.status(400).json({ success: false, error: 'loyalty_vip_tiers must be an array of at most 10 tiers' });
      }
      const clean = [];
      for (const tier of tiers) {
        const name = String(tier?.name || '').trim().slice(0, 40);
        const minSpend = Number(tier?.min_spend_ghs);
        if (!name || !Number.isFinite(minSpend) || minSpend < 0) {
          return res.status(400).json({ success: false, error: 'Each VIP tier needs a name and a non-negative min_spend_ghs' });
        }
        clean.push({ name, min_spend_ghs: minSpend });
      }
      set('loyalty_vip_tiers', JSON.stringify(clean));
    }

    if (!sets.length) return res.status(400).json({ success: false, error: 'No recognized settings in body' });

    const r = await query(
      `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING ${SETTINGS_COLUMNS}`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId, action: 'settings.update',
      detail: { fields: sets.map(s => s.split(' ')[0]) }
    });
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    logger.error('PATCH /business/settings failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
