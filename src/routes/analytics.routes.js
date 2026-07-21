const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');

const router = express.Router();

router.use(requireAuth('any'));

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

/**
 * GET /api/analytics/delivery-sla?business_id=&days=7|30
 * Time-to-deliver computed from the order_status_history events assignDelivery
 * and updateDeliveryStatus already write ('delivery:assigned' → 'delivery:delivered')
 * — no new tracking table needed. "Late" means delivered after the
 * merchant's own estimated_delivery_at; orders with no ETA set are excluded
 * from the late count (nothing to be late against) but still count toward
 * the average delivery time.
 */
router.get('/delivery-sla', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;

    const deliveries = await query(
      `WITH assign_evt AS (
         SELECT order_id, MIN(created_at) AS assigned_at
           FROM order_status_history WHERE event = 'delivery:assigned' GROUP BY order_id
       ),
       delivered_evt AS (
         SELECT order_id, MIN(created_at) AS delivered_at
           FROM order_status_history WHERE event = 'delivery:delivered' GROUP BY order_id
       )
       SELECT o.id, o.order_number, o.rider_name, o.estimated_delivery_at,
              a.assigned_at, d.delivered_at,
              EXTRACT(EPOCH FROM (d.delivered_at - a.assigned_at)) / 60 AS minutes_to_deliver,
              (o.estimated_delivery_at IS NOT NULL AND d.delivered_at > o.estimated_delivery_at) AS late
         FROM orders o
         JOIN assign_evt a ON a.order_id = o.id
         JOIN delivered_evt d ON d.order_id = o.id
        WHERE o.business_id = $1 AND o.created_at >= NOW() - ($2 || ' days')::interval
        ORDER BY d.delivered_at DESC`,
      [business_id, days]
    );

    const rows = deliveries.rows;
    const withEta = rows.filter(r => r.estimated_delivery_at !== null);
    const lateCount = withEta.filter(r => r.late).length;
    const avgMinutes = rows.length
      ? rows.reduce((sum, r) => sum + Number(r.minutes_to_deliver), 0) / rows.length
      : null;

    const byRiderMap = new Map();
    for (const r of rows) {
      const key = r.rider_name || '(unassigned)';
      if (!byRiderMap.has(key)) byRiderMap.set(key, { rider_name: key, deliveries: 0, total_minutes: 0, late: 0, with_eta: 0 });
      const bucket = byRiderMap.get(key);
      bucket.deliveries++;
      bucket.total_minutes += Number(r.minutes_to_deliver);
      if (r.estimated_delivery_at !== null) {
        bucket.with_eta++;
        if (r.late) bucket.late++;
      }
    }
    const byRider = [...byRiderMap.values()].map(b => ({
      rider_name: b.rider_name,
      deliveries: b.deliveries,
      avg_minutes: Math.round(b.total_minutes / b.deliveries),
      late_count: b.late,
      late_rate_pct: b.with_eta > 0 ? Math.round((b.late / b.with_eta) * 100) : null
    })).sort((a, b) => b.deliveries - a.deliveries);

    res.json({
      success: true,
      delivery_sla: {
        completed_deliveries: rows.length,
        avg_minutes_to_deliver: avgMinutes !== null ? Math.round(avgMinutes) : null,
        late_count: lateCount,
        late_rate_pct: withEta.length > 0 ? Math.round((lateCount / withEta.length) * 100) : null,
        by_rider: byRider,
        recent: rows.slice(0, 20).map(r => ({
          order_number: r.order_number,
          rider_name: r.rider_name,
          minutes_to_deliver: Math.round(Number(r.minutes_to_deliver)),
          late: r.late
        }))
      }
    });
  } catch (err) {
    logger.error('GET /analytics/delivery-sla failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/analytics/profit?business_id=&days=7|30|90
 * Gross margin computed from ACTUAL paid-order line items × each product's
 * cost_price_ghs — not the static catalog margin /api/inventory/margins
 * shows (which is just price-cost per listing, unweighted by what actually
 * sold). Items whose product no longer resolves (deleted product, or a
 * storefront bundle line with no product_id) are counted in revenue but
 * excluded from margin — margin_known_pct tells the merchant how much of
 * their revenue this profit picture actually covers, rather than silently
 * treating an unknown cost as zero.
 */
router.get('/profit', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;

    const [byProduct, byDay] = await Promise.all([
      query(
        `WITH paid_items AS (
           SELECT item->>'product_id' AS product_id,
                  item->>'name' AS name,
                  COALESCE((item->>'quantity')::numeric, 1) AS qty,
                  COALESCE((item->>'price_ghs')::numeric, 0) AS price_ghs
             FROM orders o, jsonb_array_elements(o.items) AS item
            WHERE o.business_id = $1 AND o.payment_status = 'paid'
              AND o.created_at >= NOW() - ($2 || ' days')::interval
         )
         SELECT pi.product_id, MAX(pi.name) AS name, MAX(p.cost_price_ghs) AS cost_price_ghs,
                SUM(pi.qty)::numeric AS units_sold,
                SUM(pi.qty * pi.price_ghs) AS revenue_ghs
           FROM paid_items pi
           LEFT JOIN products p ON pi.product_id IS NOT NULL AND p.id::text = pi.product_id
          GROUP BY pi.product_id
          ORDER BY revenue_ghs DESC`,
        [business_id, days]
      ),
      query(
        `WITH paid_items AS (
           SELECT (o.created_at AT TIME ZONE 'Africa/Accra')::date AS day,
                  item->>'product_id' AS product_id,
                  COALESCE((item->>'quantity')::numeric, 1) AS qty,
                  COALESCE((item->>'price_ghs')::numeric, 0) AS price_ghs
             FROM orders o, jsonb_array_elements(o.items) AS item
            WHERE o.business_id = $1 AND o.payment_status = 'paid'
              AND o.created_at >= NOW() - ($2 || ' days')::interval
         )
         SELECT pi.day,
                SUM(pi.qty * pi.price_ghs) AS revenue_ghs,
                SUM(pi.qty * pi.price_ghs) FILTER (WHERE p.cost_price_ghs IS NOT NULL) AS revenue_with_known_cost_ghs,
                SUM(pi.qty * p.cost_price_ghs) FILTER (WHERE p.cost_price_ghs IS NOT NULL) AS cost_ghs
           FROM paid_items pi
           LEFT JOIN products p ON pi.product_id IS NOT NULL AND p.id::text = pi.product_id
          GROUP BY pi.day
          ORDER BY pi.day ASC`,
        [business_id, days]
      )
    ]);

    let totalRevenue = 0;
    let revenueWithKnownCost = 0;
    const products = byProduct.rows.map(r => {
      const revenue = Number(r.revenue_ghs);
      totalRevenue += revenue;
      const costKnown = r.cost_price_ghs != null;
      const cost = costKnown ? Number(r.units_sold) * Number(r.cost_price_ghs) : null;
      const margin = costKnown ? revenue - cost : null;
      if (costKnown) revenueWithKnownCost += revenue;
      return {
        product_id: r.product_id,
        name: r.name,
        units_sold: Number(r.units_sold),
        revenue_ghs: Number(revenue.toFixed(2)),
        cost_ghs: costKnown ? Number(cost.toFixed(2)) : null,
        margin_ghs: costKnown ? Number(margin.toFixed(2)) : null,
        margin_pct: costKnown && revenue > 0 ? Math.round((margin / revenue) * 100) : null,
        cost_known: costKnown
      };
    });
    const bestMargin = products
      .filter(p => p.cost_known)
      .sort((a, b) => b.margin_ghs - a.margin_ghs)[0] || null;

    const byDayOut = byDay.rows.map(r => ({
      date: r.day,
      revenue_ghs: Number(Number(r.revenue_ghs).toFixed(2)),
      cost_ghs: r.cost_ghs != null ? Number(Number(r.cost_ghs).toFixed(2)) : 0,
      margin_ghs: r.cost_ghs != null ? Number((Number(r.revenue_with_known_cost_ghs) - Number(r.cost_ghs)).toFixed(2)) : null
    }));

    res.json({
      success: true,
      profit: {
        days,
        by_product: products,
        by_day: byDayOut,
        best_margin_product: bestMargin,
        margin_known_pct: totalRevenue > 0 ? Math.round((revenueWithKnownCost / totalRevenue) * 100) : null,
        note: 'Margin is only computed for products with a cost_price_ghs set (Inventory > cost price). ' +
              'margin_known_pct shows how much of total revenue that actually covers.'
      }
    });
  } catch (err) {
    logger.error('GET /analytics/profit failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/analytics/cohorts?business_id=&days=7|30
 * New vs. returning customers within the window (by each customer's
 * all-time first paid order), plus the classic N-day repeat-purchase rate:
 * of customers whose FIRST paid order happened at least N days ago (long
 * enough to fairly judge), what % placed a SECOND paid order within N days
 * of that first one. Computed for both N=7 and N=30 regardless of the
 * `days` window, since that comparison is the point of the metric.
 */
router.get('/cohorts', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const days = [7, 30].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;

    const repeatRateFor = async n => {
      const r = await query(
        `WITH first_orders AS (
           SELECT customer_id, MIN(created_at) AS first_paid_at
             FROM orders WHERE business_id = $1 AND payment_status = 'paid'
             GROUP BY customer_id
         ),
         eligible AS (
           SELECT customer_id, first_paid_at FROM first_orders
            WHERE first_paid_at <= NOW() - ($2 || ' days')::interval
         )
         SELECT
           (SELECT COUNT(*) FROM eligible)::int AS eligible_count,
           (SELECT COUNT(*) FROM eligible e WHERE EXISTS (
              SELECT 1 FROM orders o2
               WHERE o2.customer_id = e.customer_id AND o2.business_id = $1
                 AND o2.payment_status = 'paid'
                 AND o2.created_at > e.first_paid_at
                 AND o2.created_at <= e.first_paid_at + ($2 || ' days')::interval
            ))::int AS repeated_count`,
        [business_id, n]
      );
      const row = r.rows[0];
      return {
        window_days: n,
        eligible_customers: row.eligible_count,
        repeated_customers: row.repeated_count,
        repeat_rate_pct: row.eligible_count > 0 ? Math.round((row.repeated_count / row.eligible_count) * 100) : null
      };
    };

    const [newVsReturning, repeat7, repeat30] = await Promise.all([
      query(
        `WITH first_orders AS (
           SELECT customer_id, MIN(created_at) AS first_paid_at
             FROM orders WHERE business_id = $1 AND payment_status = 'paid'
             GROUP BY customer_id
         )
         SELECT (fo.first_paid_at >= NOW() - ($2 || ' days')::interval) AS is_new_customer,
                COUNT(DISTINCT o.customer_id)::int AS customers,
                COUNT(*)::int AS orders,
                COALESCE(SUM(o.total_ghs), 0) AS revenue_ghs
           FROM orders o JOIN first_orders fo ON fo.customer_id = o.customer_id
          WHERE o.business_id = $1 AND o.payment_status = 'paid'
            AND o.created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY is_new_customer`,
        [business_id, days]
      ),
      repeatRateFor(7),
      repeatRateFor(30)
    ]);

    const nv = { new: null, returning: null };
    for (const row of newVsReturning.rows) {
      const bucket = row.is_new_customer ? 'new' : 'returning';
      nv[bucket] = {
        customers: row.customers,
        orders: row.orders,
        revenue_ghs: Number(Number(row.revenue_ghs).toFixed(2))
      };
    }

    res.json({
      success: true,
      cohorts: {
        days,
        new_customers: nv.new || { customers: 0, orders: 0, revenue_ghs: 0 },
        returning_customers: nv.returning || { customers: 0, orders: 0, revenue_ghs: 0 },
        repeat_rate_7d: repeat7,
        repeat_rate_30d: repeat30
      }
    });
  } catch (err) {
    logger.error('GET /analytics/cohorts failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/analytics/channels?business_id=&days=7|30|90
 * Orders/revenue split by acquisition channel (orders.channel). A storefront
 * guest checkout is tagged 'storefront' even though it resolves to the same
 * WhatsApp customer identity (see storefront.routes.js checkout) — this is
 * "where did the ORDER start", not "what channel is this customer's identity."
 */
router.get('/channels', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;

    const result = await query(
      `SELECT channel,
              COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders,
              COALESCE(SUM(total_ghs) FILTER (WHERE payment_status = 'paid'), 0) AS revenue_ghs,
              COUNT(DISTINCT customer_id)::int AS unique_customers
         FROM orders
        WHERE business_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY channel
        ORDER BY revenue_ghs DESC`,
      [business_id, days]
    );
    const channels = result.rows.map(r => ({
      channel: r.channel,
      orders: r.orders,
      paid_orders: r.paid_orders,
      revenue_ghs: Number(Number(r.revenue_ghs).toFixed(2)),
      unique_customers: r.unique_customers
    }));
    res.json({ success: true, days, channels });
  } catch (err) {
    logger.error('GET /analytics/channels failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
