const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { buildAudienceClauses, SEGMENTS } = require('../utils/audience');
const { computeVipTier, computePointsRedemptionValue, generateRewardCode } = require('../utils/loyalty');
const { getAdapter, destOf } = require('../services/channel.adapter');
const respond = require('../utils/response');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/customers?business_id=&limit=&sort=spent|recent&tag=&segment=&min_spend_ghs=
 * Ranked customer list for the merchant dashboard ("best customers"),
 * optionally filtered to a tag/segment/spend-threshold audience.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id, sort } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const orderBy = sort === 'recent'
      ? 'c.last_seen_at DESC'
      : 'c.total_spent_ghs DESC, c.total_orders DESC';

    const params = [business_id];
    const extra = buildAudienceClauses(req.query, params);
    params.push(limit);

    const r = await query(
      `SELECT c.id, c.whatsapp_number, c.display_name, c.channel, c.phone_network,
              c.total_orders, c.total_spent_ghs, c.last_seen_at, c.created_at, c.tags
         FROM customers c
        WHERE c.business_id = $1 ${extra.map(cl => `AND ${cl}`).join(' ')}
        ORDER BY ${orderBy}
        LIMIT $${params.length}`,
      params
    );
    return respond.ok(req, res, { customers: r.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /customers', err);
  }
});

/**
 * GET /api/customers/segments/summary?business_id= — counts per predefined
 * segment plus the top tags in use, to power a segments overview panel.
 */
router.get('/segments/summary', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
    }
    const segmentEntries = Object.entries(SEGMENTS);
    const segmentCounts = await Promise.all(segmentEntries.map(([key, def]) =>
      query(`SELECT COUNT(*)::int AS n FROM customers c WHERE c.business_id = $1 AND (${def.sql})`, [business_id])
        .then(r => ({ key, label: def.label, count: r.rows[0].n }))
    ));
    const tagsRes = await query(
      `SELECT tag, COUNT(*)::int AS n
         FROM customers c, unnest(c.tags) AS tag
        WHERE c.business_id = $1
        GROUP BY tag
        ORDER BY n DESC
        LIMIT 20`,
      [business_id]
    );
    return respond.ok(req, res, { segments: segmentCounts, tags: tagsRes.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /customers/segments/summary', err);
  }
});

/**
 * GET /api/customers/:id/profile — everything the dashboard's customer
 * profile panel needs: lifetime spend, order frequency, last products
 * ordered, preferred payment method, and recent conversation history.
 */
router.get('/:id/profile', async (req, res) => {
  try {
    const custRes = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = custRes.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }

    const [recentOrders, paymentMethods, recentMessages] = await Promise.all([
      query(
        `SELECT id, order_number, items, total_ghs, status, payment_status, created_at
           FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [customer.id]
      ),
      query(
        `SELECT payment_method, COUNT(*)::int AS n
           FROM orders WHERE customer_id = $1 AND payment_status = 'paid' AND payment_method IS NOT NULL
           GROUP BY payment_method ORDER BY n DESC LIMIT 1`,
        [customer.id]
      ),
      query(
        `SELECT direction, content, created_at FROM message_log
          WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [customer.id]
      )
    ]);

    const lastProducts = [];
    for (const o of recentOrders.rows) {
      for (const item of (Array.isArray(o.items) ? o.items : [])) {
        if (!lastProducts.find(p => p.name === item.name)) lastProducts.push({ name: item.name, ordered_at: o.created_at });
      }
      if (lastProducts.length >= 10) break;
    }

    const tenureDays = Math.max(1, Math.round((Date.now() - new Date(customer.created_at).getTime()) / 86400000));
    const orderFrequencyPerMonth = Number(((customer.total_orders / tenureDays) * 30).toFixed(2));

    return respond.ok(req, res, {
      customer,
      last_products_ordered: lastProducts.slice(0, 10),
      recent_orders: recentOrders.rows,
      conversation_history: recentMessages.rows
    }, {
      meta: {
        lifetime_spend_ghs: Number(customer.total_spent_ghs),
        total_orders: customer.total_orders,
        order_frequency_per_month: orderFrequencyPerMonth,
        preferred_payment_method: paymentMethods.rows[0]?.payment_method || null
      }
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /customers/:id/profile', err);
  }
});

/** PATCH /api/customers/:id/tags — body: { tags: string[] } — replaces the full tag set. */
router.patch('/:id/tags', requirePermission('customers', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = existing.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const raw = req.body?.tags;
    if (!Array.isArray(raw)) return respond.invalid(req, res, 'tags must be an array of strings', { tags: 'is invalid' });
    const tags = [...new Set(raw.map(t => String(t || '').trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
    const result = await query('UPDATE customers SET tags = $2 WHERE id = $1 RETURNING *', [req.params.id, tags]);
    return respond.ok(req, res, { customer: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /customers/:id/tags', err);
  }
});

/**
 * PATCH /api/customers/:id/address-note — body: { address_note }
 * Standing delivery directions for this customer, written by the merchant
 * (typically after a rider struggled to find the place). Distinct from the
 * customer's own `address`, which checkout maintains automatically and this
 * route deliberately cannot touch — a merchant note must never silently
 * rewrite where the customer said to deliver.
 */
router.patch('/:id/address-note', requirePermission('customers', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = existing.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const raw = req.body?.address_note;
    if (raw != null && typeof raw !== 'string') {
      return respond.invalid(req, res, 'address_note must be a string or null', { address_note: 'is invalid' });
    }
    // Capped: this is pasted verbatim into the rider's WhatsApp message, and
    // an unbounded note would blow past the text-message limit.
    const note = raw == null ? null : (raw.trim().slice(0, 300) || null);
    const result = await query(
      'UPDATE customers SET address_note = $2 WHERE id = $1 RETURNING *',
      [req.params.id, note]
    );
    return respond.ok(req, res, { customer: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /customers/:id/address-note', err);
  }
});

/**
 * GET /api/customers/:id/loyalty — points, stamps progress, VIP tier,
 * referral code, and reward history for the customer profile panel.
 */
router.get('/:id/loyalty', async (req, res) => {
  try {
    const custRes = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = custRes.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const bizRes = await query(
      `SELECT loyalty_stamps_target, loyalty_points_redemption_rate_ghs, loyalty_vip_tiers
         FROM businesses WHERE id = $1`,
      [customer.business_id]
    );
    const biz = bizRes.rows[0];
    const rewardsRes = await query(
      'SELECT * FROM customer_rewards WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20',
      [customer.id]
    );
    return respond.ok(req, res, {
      loyalty: {
        points: customer.loyalty_points,
        points_value_ghs: computePointsRedemptionValue(customer.loyalty_points, biz?.loyalty_points_redemption_rate_ghs || 0),
        stamps: customer.loyalty_stamps,
        stamps_target: biz?.loyalty_stamps_target || 0,
        vip_tier: computeVipTier(customer.total_spent_ghs, biz?.loyalty_vip_tiers || []),
        referral_code: customer.referral_code,
        date_of_birth: customer.date_of_birth,
        rewards: rewardsRes.rows
      }
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /customers/:id/loyalty', err);
  }
});

/**
 * POST /api/customers/:id/loyalty/redeem-points — body: { points }
 * Merchant-triggered: converts points into a one-time reward code, texted
 * to the customer. Kept merchant-initiated (not a customer chat command) so
 * the points-to-cash math is always confirmed by a human before it fires.
 */
router.post('/:id/loyalty/redeem-points', requirePermission('financial'), async (req, res) => {
  try {
    const custRes = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = custRes.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const points = parseInt(req.body?.points, 10);
    if (!Number.isInteger(points) || points <= 0) {
      return respond.invalid(req, res, 'points must be a positive integer', { points: 'is invalid' });
    }
    if (points > customer.loyalty_points) {
      return respond.invalid(req, res, `Customer only has ${customer.loyalty_points} points`);
    }
    const bizRes = await query('SELECT name, loyalty_points_redemption_rate_ghs FROM businesses WHERE id = $1', [customer.business_id]);
    const biz = bizRes.rows[0];
    const valueGhs = computePointsRedemptionValue(points, biz.loyalty_points_redemption_rate_ghs);
    if (valueGhs <= 0) {
      return respond.invalid(req, res, 'Redemption rate is not configured for this business');
    }

    const code = generateRewardCode('POINTS');
    await query(
      `UPDATE customers SET loyalty_points = loyalty_points - $2 WHERE id = $1`,
      [customer.id, points]
    );
    const inserted = await query(
      `INSERT INTO customer_rewards (business_id, customer_id, type, code, description, discount_type, discount_value)
       VALUES ($1,$2,'points_redemption',$3,$4,'fixed',$5) RETURNING *`,
      [customer.business_id, customer.id, code, `${points} points redeemed`, valueGhs]
    );

    getAdapter(customer.channel).sendText(destOf(customer),
      `⭐ You redeemed ${points} points for a GH₵${valueGhs.toFixed(2)} reward! Use code *${code}* on your next order.`,
      { businessId: customer.business_id, customerId: customer.id }
    ).catch(err => logger.warn('points redemption notify failed: %s', err.message));

    return respond.ok(req, res, { reward: inserted.rows[0] }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /customers/:id/loyalty/redeem-points', err);
  }
});

/** PATCH /api/customers/:id/birthday — body: { date_of_birth: 'YYYY-MM-DD' | null } */
router.patch('/:id/birthday', requirePermission('customers', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = existing.rows[0];
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const raw = req.body?.date_of_birth;
    if (raw != null && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return respond.invalid(req, res, 'date_of_birth must be YYYY-MM-DD or null', { date_of_birth: 'is invalid' });
    }
    const result = await query('UPDATE customers SET date_of_birth = $2 WHERE id = $1 RETURNING *', [req.params.id, raw || null]);
    return respond.ok(req, res, { customer: result.rows[0] });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'PATCH /customers/:id/birthday', err);
  }
});

module.exports = router;
