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
      // Cart-nudge recovery: of customers nudged in the window, how many went
      // on to complete a paid order afterward. Uses the nudge_sent_at column
      // the cart-abandonment cron already writes — no new tracking needed.
      query(
        `WITH nudged AS (
           SELECT cs.customer_id, cs.nudge_sent_at
             FROM conversation_state cs
             JOIN customers c ON c.id = cs.customer_id
            WHERE c.business_id = $1
              AND cs.nudge_sent_at IS NOT NULL
              AND cs.nudge_sent_at >= NOW() - ($2 || ' days')::interval
         )
         SELECT
           COUNT(*)::int AS nudged_count,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM orders o
                WHERE o.customer_id = nudged.customer_id
                  AND o.business_id = $1
                  AND o.payment_status = 'paid'
                  AND o.created_at >= nudged.nudge_sent_at
                  AND o.created_at <= nudged.nudge_sent_at + INTERVAL '48 hours'
             )
           )::int AS recovered_count
         FROM nudged`,
        [business_id, days]
      )
    ]);

    const rep = repeat.rows[0];
    const ab = abandonment.rows[0];
    const nu = nudges.rows[0];

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
          recovery_rate_pct: nu.nudged_count > 0
            ? Math.round((nu.recovered_count / nu.nudged_count) * 100) : null
        }
      }
    });
  } catch (err) {
    logger.error('GET /analytics failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
