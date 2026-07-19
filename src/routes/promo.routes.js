const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { SEGMENTS } = require('../utils/audience');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

const PROMO_COLUMNS =
  'id, code, type, value, expires_at, max_uses, used_count, active, created_at, ' +
  'min_order_ghs, first_order_only, customer_tag, customer_segment, product_id, category';

/** GET /api/promos?business_id= */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const r = await query(
      `SELECT ${PROMO_COLUMNS} FROM promos WHERE business_id = $1 ORDER BY created_at DESC`,
      [business_id]
    );
    res.json({ success: true, promos: r.rows });
  } catch (err) {
    logger.error('GET /promos failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/promos
 * Body: { business_id, code, type: 'percent'|'fixed', value, expires_at?, max_uses?,
 *         min_order_ghs?, first_order_only?, customer_tag?, customer_segment?,
 *         product_id?, category? }
 */
router.post('/', async (req, res) => {
  try {
    const { business_id, type, expires_at } = req.body || {};
    const code = String(req.body?.code || '').trim().toUpperCase();
    const value = Number(req.body?.value);
    const maxUses = req.body?.max_uses != null && req.body.max_uses !== ''
      ? parseInt(req.body.max_uses, 10) : null;

    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (!code || !/^[A-Z0-9_-]{2,32}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'code must be 2-32 chars: letters, numbers, - or _' });
    }
    if (!['percent', 'fixed'].includes(type)) {
      return res.status(400).json({ success: false, error: "type must be 'percent' or 'fixed'" });
    }
    if (!(value > 0) || !Number.isFinite(value)) {
      return res.status(400).json({ success: false, error: 'value must be a positive number' });
    }
    if (type === 'percent' && value > 100) {
      return res.status(400).json({ success: false, error: 'percent value cannot exceed 100' });
    }
    if (maxUses !== null && !(maxUses > 0)) {
      return res.status(400).json({ success: false, error: 'max_uses must be a positive integer' });
    }

    let minOrderGhs = null;
    if (req.body?.min_order_ghs != null && req.body.min_order_ghs !== '') {
      minOrderGhs = Number(req.body.min_order_ghs);
      if (!Number.isFinite(minOrderGhs) || minOrderGhs < 0) {
        return res.status(400).json({ success: false, error: 'min_order_ghs must be a non-negative number' });
      }
    }
    const firstOrderOnly = !!req.body?.first_order_only;
    const customerTag = req.body?.customer_tag ? String(req.body.customer_tag).trim().toLowerCase().slice(0, 40) : null;
    const customerSegment = req.body?.customer_segment || null;
    if (customerSegment && !SEGMENTS[customerSegment]) {
      return res.status(400).json({ success: false, error: `customer_segment must be one of ${Object.keys(SEGMENTS).join(', ')}` });
    }
    let productId = req.body?.product_id || null;
    if (productId) {
      const p = await query('SELECT id FROM products WHERE id = $1 AND business_id = $2', [productId, business_id]);
      if (!p.rowCount) return res.status(400).json({ success: false, error: 'product_id does not belong to this business' });
    }
    const category = req.body?.category ? String(req.body.category).trim().toLowerCase().slice(0, 60) : null;

    const r = await query(
      `INSERT INTO promos (
         business_id, code, type, value, expires_at, max_uses,
         min_order_ghs, first_order_only, customer_tag, customer_segment, product_id, category
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${PROMO_COLUMNS}`,
      [business_id, code, type, value, expires_at || null, maxUses,
        minOrderGhs, firstOrderOnly, customerTag, customerSegment, productId, category]
    );
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId: business_id, action: 'promo.create', detail: { code, type, value }
    });
    res.status(201).json({ success: true, promo: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'A promo with this code already exists' });
    }
    logger.error('POST /promos failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/promos/:id — toggle active, e.g. { business_id, active: false } */
router.patch('/:id', async (req, res) => {
  try {
    const { business_id } = req.body || {};
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (typeof req.body?.active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'active (boolean) is required' });
    }
    const r = await query(
      `UPDATE promos SET active = $3 WHERE id = $1 AND business_id = $2
       RETURNING ${PROMO_COLUMNS}`,
      [req.params.id, business_id, req.body.active]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Promo not found' });
    res.json({ success: true, promo: r.rows[0] });
  } catch (err) {
    logger.error('PATCH /promos/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/promos/:id/performance?business_id= — campaign analytics: uses,
 * total discount given, revenue from orders that used the code, redemption
 * rate against max_uses (when capped).
 */
router.get('/:id/performance', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const promoRes = await query(`SELECT ${PROMO_COLUMNS} FROM promos WHERE id = $1 AND business_id = $2`, [req.params.id, business_id]);
    const promo = promoRes.rows[0];
    if (!promo) return res.status(404).json({ success: false, error: 'Promo not found' });

    const statsRes = await query(
      `SELECT
         COUNT(*)::int AS orders_count,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders_count,
         COALESCE(SUM(discount_ghs) FILTER (WHERE payment_status = 'paid'), 0) AS total_discount_ghs,
         COALESCE(SUM(total_ghs) FILTER (WHERE payment_status = 'paid'), 0) AS total_revenue_ghs
       FROM orders
      WHERE business_id = $1 AND promo_code = $2`,
      [business_id, promo.code]
    );
    const stats = statsRes.rows[0];
    res.json({
      success: true,
      performance: {
        promo,
        orders_count: stats.orders_count,
        paid_orders_count: stats.paid_orders_count,
        total_discount_ghs: Number(stats.total_discount_ghs),
        total_revenue_ghs: Number(stats.total_revenue_ghs),
        redemption_rate_pct: promo.max_uses ? Math.round((promo.used_count / promo.max_uses) * 100) : null
      }
    });
  } catch (err) {
    logger.error('GET /promos/:id/performance failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
