const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

/**
 * GET /api/analytics?business_id=&days=7|30
 * Everything computed from tables the app already writes to — no new
 * tracking tables needed. All windows are Africa/Accra calendar days.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const days = [7, 30].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 7;

    const [revenue, topProducts, repeat, hours, abandonment, nudges] = await Promise.all([
      // Daily paid GMV + order count, Africa/Accra calendar days, zero-filled.
      query(
        `WITH days AS (
           SELECT generate_series(0, $2 - 1) AS n
         ),
         daily AS (
           SELECT (date_trunc('day', created_at AT TIME ZONE 'Africa/Accra'))::date AS d,
                  COUNT(*)::int AS orders,
                  COALESCE(SUM(total_ghs) FILTER (WHERE payment_status = 'paid'), 0) AS gmv_ghs,
                  COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders
             FROM orders
            WHERE business_id = $1
              AND created_at >= NOW() - ($2 || ' days')::interval
            GROUP BY 1
         )
         SELECT
           (date_trunc('day', NOW() AT TIME ZONE 'Africa/Accra')::date - n) AS date,
           COALESCE(daily.gmv_ghs, 0) AS gmv_ghs,
           COALESCE(daily.orders, 0) AS orders,
           COALESCE(daily.paid_orders, 0) AS paid_orders
         FROM days
         LEFT JOIN daily ON daily.d = (date_trunc('day', NOW() AT TIME ZONE 'Africa/Accra')::date - n)
         ORDER BY date ASC`,
        [business_id, days]
      ),
      // Top products by revenue, unpacked from paid orders' items JSONB.
      query(
        `SELECT item->>'name' AS name,
                SUM((item->>'quantity')::numeric)::int AS qty,
                SUM((item->>'quantity')::numeric * (item->>'price_ghs')::numeric) AS revenue_ghs
           FROM orders o, jsonb_array_elements(o.items) AS item
          WHERE o.business_id = $1
            AND o.payment_status = 'paid'
            AND o.created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY 1
          ORDER BY revenue_ghs DESC
          LIMIT 8`,
        [business_id, days]
      ),
      // Repeat-customer rate among customers active in the window.
      query(
        `WITH active_customers AS (
           SELECT DISTINCT customer_id FROM orders
            WHERE business_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
         )
         SELECT
           COUNT(*)::int AS active_count,
           COUNT(*) FILTER (WHERE c.total_orders > 1)::int AS repeat_count
         FROM active_customers ac
         JOIN customers c ON c.id = ac.customer_id`,
        [business_id, days]
      ),
      // Busiest hours (Africa/Accra), by order count.
      query(
        `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Africa/Accra')::int AS hour,
                COUNT(*)::int AS orders
           FROM orders
          WHERE business_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY 1
          ORDER BY orders DESC`,
        [business_id, days]
      ),
      // Checkout abandonment: orders started but never paid, vs. total started.
      query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COUNT(*) FILTER (WHERE payment_status <> 'paid')::int AS unpaid_orders
         FROM orders
        WHERE business_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
        [business_id, days]
      ),
      // Cart-nudge recovery: of nudges sent in the window (from the cart_nudges
      // log, one row per actual send), how many were followed by a paid order
      // within 48h — with revenue and an A/B breakdown by variant.
      query(
        `SELECT
           cn.variant,
           COUNT(*)::int AS nudged_count,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM orders o
                WHERE o.customer_id = cn.customer_id
                  AND o.business_id = $1
                  AND o.payment_status = 'paid'
                  AND o.created_at >= cn.sent_at
                  AND o.created_at <= cn.sent_at + INTERVAL '48 hours'
             )
           )::int AS recovered_count,
           COALESCE(SUM(
             (SELECT SUM(o.total_ghs) FROM orders o
               WHERE o.customer_id = cn.customer_id
                 AND o.business_id = $1
                 AND o.payment_status = 'paid'
                 AND o.created_at >= cn.sent_at
                 AND o.created_at <= cn.sent_at + INTERVAL '48 hours')
           ), 0) AS recovered_revenue_ghs
         FROM cart_nudges cn
        WHERE cn.business_id = $1
          AND cn.sent_at >= NOW() - ($2 || ' days')::interval
        GROUP BY cn.variant`,
        [business_id, days]
      )
    ]);

    const rep = repeat.rows[0];
    const ab = abandonment.rows[0];
    const byVariant = nudges.rows;
    const nu = byVariant.reduce((acc, r) => ({
      nudged_count: acc.nudged_count + r.nudged_count,
      recovered_count: acc.recovered_count + r.recovered_count,
      recovered_revenue_ghs: acc.recovered_revenue_ghs + Number(r.recovered_revenue_ghs)
    }), { nudged_count: 0, recovered_count: 0, recovered_revenue_ghs: 0 });

    res.json({
      success: true,
      analytics: {
        days,
        revenue_trend: revenue.rows,
        top_products: topProducts.rows,
        repeat_customer_rate_pct: rep.active_count > 0
          ? Math.round((rep.repeat_count / rep.active_count) * 100) : null,
        active_customers: rep.active_count,
        busiest_hours: hours.rows,
        cart_abandonment: {
          total_orders: ab.total_orders,
          unpaid_orders: ab.unpaid_orders,
          abandonment_rate_pct: ab.total_orders > 0
            ? Math.round((ab.unpaid_orders / ab.total_orders) * 100) : null
        },
        nudge_recovery: {
          nudges_sent: nu.nudged_count,
          recovered: nu.recovered_count,
          recovered_revenue_ghs: Number(nu.recovered_revenue_ghs.toFixed(2)),
          recovery_rate_pct: nu.nudged_count > 0
            ? Math.round((nu.recovered_count / nu.nudged_count) * 100) : null,
          by_variant: byVariant.map(r => ({
            variant: r.variant,
            nudges_sent: r.nudged_count,
            recovered: r.recovered_count,
            recovered_revenue_ghs: Number(Number(r.recovered_revenue_ghs).toFixed(2)),
            recovery_rate_pct: r.nudged_count > 0
              ? Math.round((r.recovered_count / r.nudged_count) * 100) : null
          }))
        }
      }
    });
  } catch (err) {
    logger.error('GET /analytics failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
