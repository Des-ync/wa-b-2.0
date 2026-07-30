const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { SEGMENTS } = require('../utils/audience');
const respond = require('../utils/response');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

router.use(requireAuth('any'));

const PROMO_COLUMNS =
  'id, code, type, value, expires_at, max_uses, used_count, active, created_at, ' +
  'min_order_ghs, first_order_only, customer_tag, customer_segment, product_id, category';

/** GET /api/promos?business_id= */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const r = await query(
      `SELECT ${PROMO_COLUMNS} FROM promos WHERE business_id = $1 ORDER BY created_at DESC`,
      [business_id]
    );
    return respond.ok(req, res, { promos: r.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /promos', err);
  }
});

/**
 * POST /api/promos
 * Body: { business_id, code, type: 'percent'|'fixed', value, expires_at?, max_uses?,
 *         min_order_ghs?, first_order_only?, customer_tag?, customer_segment?,
 *         product_id?, category? }
 */
router.post('/', requirePermission('promos'), async (req, res) => {
  try {
    const { business_id, type, expires_at } = req.body || {};
    const code = String(req.body?.code || '').trim().toUpperCase();
    const value = Number(req.body?.value);
    const maxUses = req.body?.max_uses != null && req.body.max_uses !== ''
      ? parseInt(req.body.max_uses, 10) : null;

    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    if (!code || !/^[A-Z0-9_-]{2,32}$/.test(code)) {
      return respond.invalid(req, res, 'code must be 2-32 chars: letters, numbers, - or _', { code: 'is invalid' });
    }
    if (!['percent', 'fixed'].includes(type)) {
      return respond.invalid(req, res, "type must be 'percent' or 'fixed'", { type: 'is invalid' });
    }
    if (!(value > 0) || !Number.isFinite(value)) {
      return respond.invalid(req, res, 'value must be a positive number', { value: 'is invalid' });
    }
    if (type === 'percent' && value > 100) {
      return respond.invalid(req, res, 'percent value cannot exceed 100', { percent: 'is invalid' });
    }
    if (maxUses !== null && !(maxUses > 0)) {
      return respond.invalid(req, res, 'max_uses must be a positive integer', { max_uses: 'is invalid' });
    }
    // Validate the date here rather than letting an unparseable string reach
    // Postgres and surface as a generic 500.
    let expiresAt = null;
    if (expires_at != null && expires_at !== '') {
      const d = new Date(expires_at);
      if (Number.isNaN(d.getTime())) {
        return respond.invalid(req, res, 'expires_at must be a valid date', { expires_at: 'is invalid' });
      }
      expiresAt = d.toISOString();
    }

    let minOrderGhs = null;
    if (req.body?.min_order_ghs != null && req.body.min_order_ghs !== '') {
      minOrderGhs = Number(req.body.min_order_ghs);
      if (!Number.isFinite(minOrderGhs) || minOrderGhs < 0) {
        return respond.invalid(req, res, 'min_order_ghs must be a non-negative number', { min_order_ghs: 'is invalid' });
      }
    }
    const firstOrderOnly = !!req.body?.first_order_only;
    const customerTag = req.body?.customer_tag ? String(req.body.customer_tag).trim().toLowerCase().slice(0, 40) : null;
    const customerSegment = req.body?.customer_segment || null;
    if (customerSegment && !SEGMENTS[customerSegment]) {
      return respond.invalid(req, res, `customer_segment must be one of ${Object.keys(SEGMENTS).join(', ')}`, { customer_segment: 'is invalid' });
    }
    let productId = req.body?.product_id || null;
    if (productId) {
      const p = await query('SELECT id FROM products WHERE id = $1 AND business_id = $2', [productId, business_id]);
      if (!p.rowCount) return respond.invalid(req, res, 'product_id does not belong to this business', { product_id: 'is invalid' });
    }
    const category = req.body?.category ? String(req.body.category).trim().toLowerCase().slice(0, 60) : null;

    const r = await query(
      `INSERT INTO promos (
         business_id, code, type, value, expires_at, max_uses,
         min_order_ghs, first_order_only, customer_tag, customer_segment, product_id, category
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${PROMO_COLUMNS}`,
      [business_id, code, type, value, expiresAt, maxUses,
        minOrderGhs, firstOrderOnly, customerTag, customerSegment, productId, category]
    );
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId: business_id, action: 'promo.create', detail: { code, type, value }
    });
    return respond.ok(req, res, { promo: r.rows[0] }, { status: 201 });
  } catch (err) {
    if (err.code === '23505') {
      return respond.fail(req, res, { code: respond.CODES.CONFLICT, message: 'A promo with this code already exists' });
    }
    return respond.failInternal(req, res, logger, 'POST /promos', err);
  }
});

/** PATCH /api/promos/:id — toggle active, e.g. { business_id, active: false } */
router.patch('/:id', requirePermission('promos'), async (req, res) => {
  try {
    const { business_id } = req.body || {};
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    if (typeof req.body?.active !== 'boolean') {
      return respond.invalid(req, res, 'active (boolean) is required', { active: 'is invalid' });
    }
    const r = await query(
      `UPDATE promos SET active = $3 WHERE id = $1 AND business_id = $2
       RETURNING ${PROMO_COLUMNS}`,
      [req.params.id, business_id, req.body.active]
    );
    if (!r.rowCount) return respond.notFound(req, res, 'Promo');
    return respond.ok(req, res, { promo: r.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /promos/:id', err);
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
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const promoRes = await query(`SELECT ${PROMO_COLUMNS} FROM promos WHERE id = $1 AND business_id = $2`, [req.params.id, business_id]);
    const promo = promoRes.rows[0];
    if (!promo) return respond.notFound(req, res, 'Promo');

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
    return respond.ok(req, res, {
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
    return respond.failInternal(req, res, logger, 'GET /promos/:id/performance', err);
  }
});

module.exports = router;
