const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId, resolveBusinessId } = require('../middleware/tenantAccess');
const { toCsv } = require('../utils/csv');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

// Admin keys see everything, tenant keys are pinned to their own business —
// same auth model as every other tenant-scoped route. Reads use the
// 'financial' capability at 'read' (owner/manager full, accountant read-only,
// support/others blocked); writes (recording a payout/expense) require write
// access, which the accountant role deliberately does not have — they can
// see the books, not touch them.
router.use(requireAuth('any'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MOMO_NETWORKS = ['mtn', 'vodafone', 'airteltigo'];

function csvResponse(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(header, rows));
}

/* =================================================================
   Daily sales report
   ================================================================= */

/**
 * GET /api/accounting/daily-sales?business_id=&date=YYYY-MM-DD
 * Defaults to today (Africa/Accra). Gross revenue, discounts, delivery fees,
 * and a breakdown by payment method for orders that were PAID that day —
 * paid_at isn't tracked separately from updated_at, so this uses
 * order_status_history's 'status:paid' event as the authoritative paid
 * timestamp (falls back to updated_at for older rows written before that
 * history existed).
 */
router.get('/daily-sales', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : null;

    const result = await query(
      `WITH paid_orders AS (
         SELECT o.*, COALESCE(
           (SELECT MIN(h.created_at) FROM order_status_history h
             WHERE h.order_id = o.id AND h.event = 'status:paid'),
           o.updated_at
         ) AS paid_at
         FROM orders o
         WHERE o.business_id = $1 AND o.payment_status = 'paid'
       )
       SELECT
         COUNT(*)::int AS order_count,
         COALESCE(SUM(subtotal_ghs), 0) AS subtotal_ghs,
         COALESCE(SUM(delivery_fee), 0) AS delivery_fee_ghs,
         COALESCE(SUM(discount_ghs), 0) AS discount_ghs,
         COALESCE(SUM(total_ghs), 0) AS total_ghs,
         COALESCE(SUM(total_ghs) FILTER (WHERE payment_method = 'momo'), 0) AS momo_ghs,
         COALESCE(SUM(total_ghs) FILTER (WHERE payment_method = 'card'), 0) AS card_ghs,
         COALESCE(SUM(total_ghs) FILTER (WHERE payment_method = 'cash'), 0) AS cash_ghs
       FROM paid_orders
       WHERE (paid_at AT TIME ZONE 'Africa/Accra')::date = COALESCE($2::date, (NOW() AT TIME ZONE 'Africa/Accra')::date)`,
      [businessId, date]
    );
    res.json({ success: true, date: date || null, report: result.rows[0] });
  } catch (err) {
    logger.error('GET /accounting/daily-sales failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Monthly VAT export
   ================================================================= */

/**
 * GET /api/accounting/vat-export?business_id=&month=YYYY-MM
 * CSV of every paid order that month with a tax breakdown, computed from the
 * business's own vat_rate_pct (0 by default — a merchant not VAT-registered
 * gets an export with a 0.00 VAT column, not a fabricated statutory rate).
 * Prices are treated as tax-inclusive: vat_ghs = total * rate / (100 + rate).
 */
router.get('/vat-export', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (!MONTH_RE.test(req.query.month || '')) {
      return res.status(400).json({ success: false, error: 'month is required as YYYY-MM' });
    }
    const bizRes = await query('SELECT vat_rate_pct FROM businesses WHERE id = $1', [businessId]);
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });
    const rate = Number(business.vat_rate_pct) || 0;

    const result = await query(
      `SELECT order_number, updated_at, total_ghs, payment_method
         FROM orders
        WHERE business_id = $1 AND payment_status = 'paid'
          AND TO_CHAR(updated_at AT TIME ZONE 'Africa/Accra', 'YYYY-MM') = $2
        ORDER BY updated_at ASC`,
      [businessId, req.query.month]
    );

    const rows = result.rows.map(o => {
      const total = Number(o.total_ghs);
      const vat = rate > 0 ? Math.round((total * rate / (100 + rate)) * 100) / 100 : 0;
      const net = Math.round((total - vat) * 100) / 100;
      return [
        o.order_number,
        o.updated_at.toISOString().slice(0, 10),
        o.payment_method || '',
        net.toFixed(2), vat.toFixed(2), total.toFixed(2)
      ];
    });
    const totals = rows.reduce((a, r) => ({
      net: a.net + Number(r[3]), vat: a.vat + Number(r[4]), gross: a.gross + Number(r[5])
    }), { net: 0, vat: 0, gross: 0 });
    rows.push(['TOTAL', '', '', totals.net.toFixed(2), totals.vat.toFixed(2), totals.gross.toFixed(2)]);

    csvResponse(
      res, `vat-export-${req.query.month}.csv`,
      ['order_number', 'date', 'payment_method', 'net_ghs', `vat_ghs_(${rate}%)`, 'gross_ghs'],
      rows
    );
  } catch (err) {
    logger.error('GET /accounting/vat-export failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Gateway reconciliation
   ================================================================= */

/**
 * GET /api/accounting/reconciliation?business_id=&from=&to=
 * Cross-checks orders we believe are PAID against the raw gateway webhook
 * log (webhook_events) for a matching Paystack/pawaPay/Hubtel event with the
 * same reference — surfaces the one failure mode that actually matters for
 * reconciliation: an order marked paid in our DB with no corroborating
 * gateway event (a webhook that never arrived, or a manual/bugged status
 * flip). Does not call out to Paystack/pawaPay directly — reconciliation
 * against what we already logged, not a live API integration.
 */
router.get('/reconciliation', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;

    const result = await query(
      `SELECT o.id, o.order_number, o.payment_ref, o.total_ghs, o.payment_method, o.updated_at,
              EXISTS (
                SELECT 1 FROM webhook_events we
                 WHERE we.source IN ('paystack','hubtel','pawapay')
                   AND (we.external_id = o.payment_ref
                        OR we.external_id LIKE '%' || o.payment_ref || '%')
              ) AS gateway_event_found
         FROM orders o
        WHERE o.business_id = $1 AND o.payment_status = 'paid' AND o.payment_ref IS NOT NULL
          AND ($2::date IS NULL OR (o.updated_at AT TIME ZONE 'Africa/Accra')::date >= $2::date)
          AND ($3::date IS NULL OR (o.updated_at AT TIME ZONE 'Africa/Accra')::date <= $3::date)
        ORDER BY o.updated_at DESC`,
      [businessId, from, to]
    );
    const unmatched = result.rows.filter(r => !r.gateway_event_found);
    res.json({
      success: true,
      total_paid_orders: result.rows.length,
      unmatched_count: unmatched.length,
      unmatched,
      orders: result.rows
    });
  } catch (err) {
    logger.error('GET /accounting/reconciliation failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Payouts (manual disbursement record — see migrate.js note on `payouts`)
   ================================================================= */

/** GET /api/accounting/payouts?business_id= */
router.get('/payouts', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT * FROM payouts WHERE business_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [businessId]
    );
    res.json({ success: true, payouts: result.rows });
  } catch (err) {
    logger.error('GET /accounting/payouts failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/accounting/payout-balance?business_id=
 * Total collected (paid orders, net of platform-visible refunds) minus total
 * recorded payouts — "what we still owe this merchant" per our own books.
 */
router.get('/payout-balance', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const collectedRes = await query(
      `SELECT COALESCE(SUM(total_ghs), 0) AS collected FROM orders WHERE business_id = $1 AND payment_status = 'paid'`,
      [businessId]
    );
    const paidOutRes = await query(
      `SELECT COALESCE(SUM(amount_ghs), 0) AS paid_out FROM payouts WHERE business_id = $1`,
      [businessId]
    );
    const collected = Number(collectedRes.rows[0].collected);
    const paidOut = Number(paidOutRes.rows[0].paid_out);
    res.json({
      success: true,
      collected_ghs: collected.toFixed(2),
      paid_out_ghs: paidOut.toFixed(2),
      balance_ghs: (collected - paidOut).toFixed(2)
    });
  } catch (err) {
    logger.error('GET /accounting/payout-balance failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/accounting/payouts — record a payout that already happened
 * (ops sent the MoMo transfer manually; this is the audit trail, not a
 * trigger to send money).
 */
router.post('/payouts', requirePermission('financial', 'write'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const amount = Number(req.body?.amount_ghs);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount_ghs must be a positive number' });
    }
    let network = null;
    if (req.body?.momo_network) {
      network = String(req.body.momo_network).trim().toLowerCase();
      if (!MOMO_NETWORKS.includes(network)) {
        return res.status(400).json({ success: false, error: `momo_network must be one of ${MOMO_NETWORKS.join(', ')}` });
      }
    }
    const result = await query(
      `INSERT INTO payouts (business_id, amount_ghs, momo_number, momo_network, reference, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        businessId, amount.toFixed(2),
        req.body?.momo_number ? String(req.body.momo_number).trim().slice(0, 40) : null,
        network,
        req.body?.reference ? String(req.body.reference).trim().slice(0, 200) : null,
        req.body?.note ? String(req.body.note).trim().slice(0, 500) : null,
        req.auth?.clerkUserId || req.auth?.keyId || null
      ]
    );
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId, action: 'accounting.payout_recorded',
      detail: { amount_ghs: amount }
    });
    res.status(201).json({ success: true, payout: result.rows[0] });
  } catch (err) {
    logger.error('POST /accounting/payouts failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Expenses
   ================================================================= */

/** GET /api/accounting/expenses?business_id=&from=&to= */
router.get('/expenses', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;
    const result = await query(
      `SELECT * FROM expenses
        WHERE business_id = $1
          AND ($2::date IS NULL OR expense_date >= $2::date)
          AND ($3::date IS NULL OR expense_date <= $3::date)
        ORDER BY expense_date DESC, created_at DESC`,
      [businessId, from, to]
    );
    res.json({ success: true, expenses: result.rows });
  } catch (err) {
    logger.error('GET /accounting/expenses failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/accounting/expenses — { business_id?, category?, amount_ghs, description?, expense_date? } */
router.post('/expenses', requirePermission('financial', 'write'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const amount = Number(req.body?.amount_ghs);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount_ghs must be a positive number' });
    }
    let expenseDate = req.body?.expense_date;
    if (expenseDate && !DATE_RE.test(expenseDate)) {
      return res.status(400).json({ success: false, error: 'expense_date must be YYYY-MM-DD' });
    }
    const result = await query(
      `INSERT INTO expenses (business_id, category, amount_ghs, description, expense_date, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6) RETURNING *`,
      [
        businessId,
        req.body?.category ? String(req.body.category).trim().toLowerCase().slice(0, 60) : 'general',
        amount.toFixed(2),
        req.body?.description ? String(req.body.description).trim().slice(0, 500) : null,
        expenseDate || null,
        req.auth?.clerkUserId || req.auth?.keyId || null
      ]
    );
    res.status(201).json({ success: true, expense: result.rows[0] });
  } catch (err) {
    logger.error('POST /accounting/expenses failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/accounting/expenses/:id */
router.delete('/expenses/:id', requirePermission('financial', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT business_id FROM expenses WHERE id = $1', [req.params.id]);
    const expense = existing.rows[0];
    if (!expense) return res.status(404).json({ success: false, error: 'Expense not found' });
    if (tenantBlocksBusinessId(req, expense.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /accounting/expenses/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Profit & loss summary
   ================================================================= */

/** GET /api/accounting/profit-loss?business_id=&from=&to= — revenue minus expenses. */
router.get('/profit-loss', requirePermission('financial', 'read'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;

    const revenueRes = await query(
      `SELECT COALESCE(SUM(total_ghs), 0) AS revenue FROM orders
        WHERE business_id = $1 AND payment_status = 'paid'
          AND ($2::date IS NULL OR (updated_at AT TIME ZONE 'Africa/Accra')::date >= $2::date)
          AND ($3::date IS NULL OR (updated_at AT TIME ZONE 'Africa/Accra')::date <= $3::date)`,
      [businessId, from, to]
    );
    const expenseRes = await query(
      `SELECT COALESCE(SUM(amount_ghs), 0) AS expenses, category, COUNT(*)::int AS n
         FROM expenses
        WHERE business_id = $1
          AND ($2::date IS NULL OR expense_date >= $2::date)
          AND ($3::date IS NULL OR expense_date <= $3::date)
        GROUP BY category
        ORDER BY expenses DESC`,
      [businessId, from, to]
    );
    const totalExpenses = expenseRes.rows.reduce((sum, r) => sum + Number(r.expenses), 0);
    const revenue = Number(revenueRes.rows[0].revenue);
    res.json({
      success: true,
      revenue_ghs: revenue.toFixed(2),
      expenses_ghs: totalExpenses.toFixed(2),
      expenses_by_category: expenseRes.rows,
      net_ghs: (revenue - totalExpenses).toFixed(2)
    });
  } catch (err) {
    logger.error('GET /accounting/profit-loss failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
