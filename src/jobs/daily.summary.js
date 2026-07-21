const logger = require('../utils/logger');
const { query } = require('../config/database');
const wa = require('../services/whatsapp.service');
const push = require('../services/push.service');
const lock = require('../services/worker.lock');
const { formatGhs } = require('../utils/helpers');

/**
 * Cron: end-of-day business summary, WhatsApp'd to every active merchant
 * (plus mirrored as a mobile push) — orders today, revenue, top product,
 * low-stock items, and failed payments. Single-leader via worker_locks,
 * same pattern as every other scheduled job in notification.service.js.
 *
 * Deliberately skips a business with ZERO signal today (no orders, nothing
 * low on stock) — a daily "nothing happened" text to an idle shop is noise,
 * not insight. A shop with a slow day still gets the (honest, GH¢0.00) digest
 * once at least one thing is worth reporting.
 */
async function runDailySummaryJob() {
  await lock.withLock('daily_summary_job', 600, async () => {
    logger.info('[cron] runDailySummaryJob starting');

    const businesses = await query(
      `SELECT id, name, whatsapp_number, bot_language
         FROM businesses
        WHERE status IN ('trial','active','grace') AND closed_at IS NULL`
    );

    let sent = 0;
    for (const business of businesses.rows) {
      try {
        const didSend = await sendSummaryForBusiness(business);
        if (didSend) sent++;
      } catch (err) {
        logger.error('[cron] daily summary failed for business %s: %s', business.id, err.message);
      }
    }
    logger.info('[cron] runDailySummaryJob done — sent %d/%d', sent, businesses.rows.length);
  });
}

async function sendSummaryForBusiness(business) {
  const [ordersRes, topProductRes, lowStockRes, failedRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS orders_today,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders_today,
         COALESCE(SUM(total_ghs) FILTER (WHERE payment_status = 'paid'), 0) AS revenue_today
       FROM orders
      WHERE business_id = $1
        AND (created_at AT TIME ZONE 'Africa/Accra')::date = (NOW() AT TIME ZONE 'Africa/Accra')::date`,
      [business.id]
    ),
    query(
      `SELECT item->>'name' AS name,
              SUM((item->>'quantity')::numeric) AS qty
         FROM orders o, jsonb_array_elements(o.items) AS item
        WHERE o.business_id = $1 AND o.payment_status = 'paid'
          AND (o.created_at AT TIME ZONE 'Africa/Accra')::date = (NOW() AT TIME ZONE 'Africa/Accra')::date
        GROUP BY 1 ORDER BY qty DESC LIMIT 1`,
      [business.id]
    ),
    query(
      `SELECT name, stock_qty FROM products
        WHERE business_id = $1 AND hidden = FALSE AND stock_qty IS NOT NULL
          AND stock_qty <= low_stock_threshold
        ORDER BY stock_qty ASC LIMIT 5`,
      [business.id]
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM orders
        WHERE business_id = $1 AND payment_status = 'failed'
          AND (updated_at AT TIME ZONE 'Africa/Accra')::date = (NOW() AT TIME ZONE 'Africa/Accra')::date`,
      [business.id]
    )
  ]);

  const stats = ordersRes.rows[0];
  const topProduct = topProductRes.rows[0] || null;
  const lowStock = lowStockRes.rows;
  const failedCount = failedRes.rows[0].n;

  const hasSignal = stats.orders_today > 0 || lowStock.length > 0 || failedCount > 0;
  if (!hasSignal) return false;

  const lines = [
    `📊 *${business.name} — today's summary*`,
    `Orders: ${stats.orders_today} (${stats.paid_orders_today} paid)`,
    `Revenue: ${formatGhs(stats.revenue_today)}`
  ];
  if (topProduct) lines.push(`Top product: ${topProduct.name} (${Number(topProduct.qty)} sold)`);
  if (failedCount > 0) lines.push(`⚠️ Failed payments: ${failedCount}`);
  if (lowStock.length) {
    lines.push(`⚠️ Low stock: ${lowStock.map(p => `${p.name} (${p.stock_qty})`).join(', ')}`);
  }

  const body = lines.join('\n');
  const sent = await wa.sendText(business.whatsapp_number, body, { businessId: business.id });
  if (!sent.success) {
    logger.warn('[cron] daily summary WhatsApp send failed for %s: %s', business.id, sent.error);
  }
  push.pushToBusiness(business.id, {
    title: '📊 Today’s summary',
    body: `${stats.orders_today} orders · ${formatGhs(stats.revenue_today)}${failedCount ? ` · ${failedCount} failed payment(s)` : ''}`,
    data: { type: 'digest' }
  });
  return true;
}

module.exports = { runDailySummaryJob, sendSummaryForBusiness };
