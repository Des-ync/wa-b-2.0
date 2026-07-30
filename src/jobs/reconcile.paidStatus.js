const logger = require('../utils/logger');
const { query, transaction, close } = require('../config/database');

/**
 * One-off remediation for the historical "mark paid" bug.
 *
 * Before POST /api/orders/:id/mark-paid existed, the mobile app recorded a
 * cash sale by PATCHing the order's fulfillment `status` to 'paid'. That path
 * (orderService.updateOrderStatus) only ever wrote `orders.status` — it never
 * touched `payment_status`, which is what GMV, every analytics metric, the
 * accounting endpoints and loyalty all gate on. So those sales look paid to
 * the merchant and do not exist to the books.
 *
 * The code path is fixed (PATCH /status now refuses 'paid' outright), but
 * rows written before the fix are still wrong. This script finds them and,
 * only when explicitly asked, corrects them.
 *
 *   node src/jobs/reconcile.paidStatus.js              # report only
 *   node src/jobs/reconcile.paidStatus.js --apply      # correct them
 *   node src/jobs/reconcile.paidStatus.js --apply --business <uuid>
 *
 * DELIBERATELY NOT BACKFILLED: loyalty points, stamps and referral rewards.
 * Those are customer-visible balances. Granting a stamp months after the
 * purchase, with no message explaining it, generates support load and can
 * push a customer past a free-item threshold they were never told about.
 * Correcting the books is silent and safe; correcting loyalty is a customer
 * communication, and that is a product decision, not a migration. See
 * docs/decisions-needed.md #8.
 *
 * Stock is likewise not decremented retroactively — the merchant has long
 * since recounted physical stock, and rewriting quantities from months-old
 * orders would fight whatever they have since entered by hand.
 */

const SUSPECT_SQL = `
  SELECT o.id, o.business_id, o.order_number, o.total_ghs, o.status,
         o.payment_status, o.created_at, o.updated_at, b.name AS business_name
    FROM orders o
    JOIN businesses b ON b.id = o.business_id
   WHERE o.status = 'paid'
     AND o.payment_status NOT IN ('paid', 'refunded')
     -- A gateway payment that genuinely failed is NOT this bug: it has a
     -- reference and a recorded failure. The broken path never wrote either.
     AND o.payment_ref IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM order_status_history h
        WHERE h.order_id = o.id AND h.event = 'payment:paid'
     )
`;

/** Find every order that the broken path left in the inconsistent state. */
async function findAffected(businessId) {
  const params = [];
  let sql = SUSPECT_SQL;
  if (businessId) {
    params.push(businessId);
    sql += ` AND o.business_id = $1`;
  }
  sql += ' ORDER BY b.name, o.created_at';
  const res = await query(sql, params);
  return res.rows;
}

function summarize(rows) {
  const byBusiness = new Map();
  for (const r of rows) {
    const cur = byBusiness.get(r.business_id) || {
      name: r.business_name, count: 0, gmv: 0, earliest: r.created_at, latest: r.created_at
    };
    cur.count += 1;
    cur.gmv += Number(r.total_ghs) || 0;
    if (r.created_at < cur.earliest) cur.earliest = r.created_at;
    if (r.created_at > cur.latest) cur.latest = r.created_at;
    byBusiness.set(r.business_id, cur);
  }
  return byBusiness;
}

function report(rows) {
  if (!rows.length) {
    logger.info('[reconcile] No affected orders. Nothing to correct.');
    return;
  }
  const byBusiness = summarize(rows);
  const totalGhs = rows.reduce((sum, r) => sum + (Number(r.total_ghs) || 0), 0);

  logger.warn('[reconcile] %d order(s) across %d business(es) are marked paid but excluded from GMV.',
    rows.length, byBusiness.size);
  logger.warn('[reconcile] Unrecorded revenue total: GH₵%s', totalGhs.toFixed(2));

  for (const [businessId, s] of byBusiness) {
    logger.warn('[reconcile]   %s (%s): %d order(s), GH₵%s, %s → %s',
      s.name, businessId, s.count, s.gmv.toFixed(2),
      new Date(s.earliest).toISOString().slice(0, 10),
      new Date(s.latest).toISOString().slice(0, 10));
  }
  for (const r of rows) {
    logger.info('[reconcile]     #%s  GH₵%s  payment_status=%s  %s',
      r.order_number, Number(r.total_ghs).toFixed(2), r.payment_status,
      new Date(r.created_at).toISOString());
  }
}

/**
 * Correct one order: set payment_status, credit the customer's lifetime spend,
 * and leave an audited history row saying exactly what happened and why.
 * Idempotent — the WHERE clause re-checks the precondition inside the
 * transaction, so a re-run (or two operators running it at once) is a no-op
 * on anything already corrected.
 */
async function correctOrder(row) {
  return transaction(async client => {
    const upd = await client.query(
      `UPDATE orders
          SET payment_status = 'paid',
              payment_method = COALESCE(payment_method, 'cash')
        WHERE id = $1
          AND status = 'paid'
          AND payment_status NOT IN ('paid', 'refunded')
        RETURNING *`,
      [row.id]
    );
    const order = upd.rows[0];
    if (!order) return false;

    if (order.customer_id) {
      await client.query(
        `UPDATE customers SET total_spent_ghs = total_spent_ghs + $2 WHERE id = $1`,
        [order.customer_id, order.total_ghs]
      );
    }

    // changed_by is constrained to system/merchant/customer, so the
    // provenance lives in the note rather than in a fourth actor value —
    // widening that CHECK for a one-off script would be the tail wagging
    // the dog.
    await client.query(
      `INSERT INTO order_status_history (order_id, event, note, changed_by)
       VALUES ($1, 'payment:paid', $2, 'system')`,
      [order.id,
        'Backfilled by reconcile.paidStatus.js — recorded as paid via the pre-fix ' +
        'PATCH /status path, which never wrote payment_status. Loyalty and stock ' +
        'were deliberately not backfilled.']
    );
    return true;
  });
}

async function run({ apply = false, businessId = null } = {}) {
  const rows = await findAffected(businessId);
  report(rows);

  if (!rows.length) return { affected: 0, corrected: 0 };
  if (!apply) {
    logger.warn('[reconcile] DRY RUN — nothing was changed. Re-run with --apply to correct these.');
    return { affected: rows.length, corrected: 0 };
  }

  let corrected = 0;
  for (const row of rows) {
    try {
      if (await correctOrder(row)) corrected++;
    } catch (err) {
      logger.error('[reconcile] order %s failed: %s', row.order_number, err.message);
    }
  }
  logger.info('[reconcile] Corrected %d/%d order(s). Loyalty and stock left untouched by design.',
    corrected, rows.length);
  return { affected: rows.length, corrected };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const bizIdx = args.indexOf('--business');
  const businessId = bizIdx >= 0 ? args[bizIdx + 1] : null;

  run({ apply, businessId })
    .then(() => close())
    .then(() => process.exit(0))
    .catch(err => {
      logger.error('[reconcile] failed: %s', err.message, { stack: err.stack });
      process.exit(1);
    });
}

module.exports = { run, findAffected, correctOrder };
