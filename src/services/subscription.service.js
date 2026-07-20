const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { addDays, slugify } = require('../utils/helpers');
const pawapay = require('./pawapay.service');

const SUSPENSION_GRACE_DAYS = parseInt(process.env.SUSPENSION_GRACE_DAYS || '3', 10);
const DEFAULT_TRIAL_DAYS = parseInt(process.env.DEFAULT_TRIAL_DAYS || '14', 10);

/* =================================================================
   Lookups
   ================================================================= */

async function getBusinessByWhatsApp(whatsappNumber) {
  const res = await query('SELECT * FROM businesses WHERE whatsapp_number = $1', [whatsappNumber]);
  return res.rows[0] || null;
}

async function getBusinessById(id) {
  const res = await query('SELECT * FROM businesses WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function listPlans() {
  const res = await query('SELECT * FROM plans WHERE is_active = TRUE ORDER BY price_ghs ASC');
  return res.rows;
}

async function getPlanById(id) {
  const res = await query('SELECT * FROM plans WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getPlanByName(name) {
  const res = await query('SELECT * FROM plans WHERE name = $1', [name]);
  return res.rows[0] || null;
}

async function getActiveSubscription(businessId) {
  const res = await query(
    `SELECT s.*, p.name AS plan_name, p.display_name AS plan_display_name,
            p.price_ghs AS plan_price_ghs, p.max_msgs_month
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [businessId]
  );
  return res.rows[0] || null;
}

async function getSubscriptionById(id) {
  const res = await query(
    `SELECT s.*, p.name AS plan_name, p.display_name AS plan_display_name,
            p.price_ghs AS plan_price_ghs
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

/* =================================================================
   Lifecycle
   ================================================================= */

async function ensureBusiness({ name, ownerName, whatsappNumber, industry }) {
  const existing = await getBusinessByWhatsApp(whatsappNumber);
  if (existing) return existing;
  const inserted = await query(
    `INSERT INTO businesses (name, owner_name, whatsapp_number, industry, status, trial_ends_at)
     VALUES ($1,$2,$3,$4,'trial', NOW() + ($5 || ' days')::interval) RETURNING *`,
    [name || 'Unnamed Business', ownerName || null, whatsappNumber, industry || 'retail',
     String(DEFAULT_TRIAL_DAYS)]
  );
  const business = inserted.rows[0];

  // Storefront handle: name-derived + a short id suffix, so it's unique on
  // the first try without a collision-retry loop (same approach the
  // migration's backfill uses for pre-existing rows).
  const slug = `${slugify(business.name)}-${business.id.slice(0, 6)}`;
  const withSlug = await query(
    `UPDATE businesses SET slug = $2 WHERE id = $1 RETURNING *`,
    [business.id, slug]
  );
  return withSlug.rows[0] || business;
}

async function createPendingSubscription({ businessId, planId }) {
  const res = await query(
    `INSERT INTO subscriptions (business_id, plan_id, status)
     VALUES ($1,$2,'pending')
     RETURNING *`,
    [businessId, planId]
  );
  return res.rows[0];
}

/**
 * Initiate a pawaPay MoMo deposit for a SaaS subscription. Creates a
 * billing_transactions row (status='pending') + subscription (if missing),
 * all in a single transaction.
 *
 * The billing reference IS the pawaPay depositId (a UUID we generate), so
 * deposit callbacks map straight back to the billing row. The callback URL
 * is configured once in the pawaPay dashboard, not per-request.
 *
 * Idempotency: at most ONE pending billing_transaction per subscription is
 * allowed (enforced by uq_billing_pending_per_subscription). If a pending
 * charge already exists we return it instead of starting a second one.
 *
 *   { success, reference, subscriptionId, status, alreadyPending? }
 */
async function initiateRenewal({ business, plan }) {
  if (!business || !plan) throw new Error('business and plan required');

  let alreadyPending = false;
  const billingRow = await transaction(async client => {
    let subRes = await client.query(
      'SELECT * FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [business.id]
    );
    let subscription = subRes.rows[0];
    if (!subscription) {
      const ins = await client.query(
        `INSERT INTO subscriptions (business_id, plan_id, status)
         VALUES ($1,$2,'pending') RETURNING *`,
        [business.id, plan.id]
      );
      subscription = ins.rows[0];
    }

    // Guard: is there already a pending charge for this subscription? Checked
    // BEFORE recording any plan change, so an unpaid earlier charge keeps its
    // original plan/amount pairing.
    const existingPending = await client.query(
      `SELECT * FROM billing_transactions
        WHERE subscription_id = $1 AND status = 'pending'
        LIMIT 1`,
      [subscription.id]
    );
    if (existingPending.rows[0]) {
      alreadyPending = true;
      return { billing: existingPending.rows[0], subscription };
    }

    // A different plan is only a REQUEST until its charge succeeds: park it in
    // pending_plan_id. plan_id switches when the payment confirms.
    if (subscription.plan_id !== plan.id) {
      const upd = await client.query(
        `UPDATE subscriptions SET pending_plan_id = $2 WHERE id = $1 RETURNING *`,
        [subscription.id, plan.id]
      );
      subscription = upd.rows[0];
    } else if (subscription.pending_plan_id) {
      // Re-charging the current plan supersedes any stale unpaid change request.
      const upd = await client.query(
        `UPDATE subscriptions SET pending_plan_id = NULL WHERE id = $1 RETURNING *`,
        [subscription.id]
      );
      subscription = upd.rows[0];
    }

    // The reference doubles as the pawaPay depositId, which must be a UUID.
    const reference = uuidv4();
    const ins = await client.query(
      `INSERT INTO billing_transactions
         (business_id, subscription_id, amount_ghs, gateway, reference, status)
       VALUES ($1,$2,$3,'pawapay',$4,'pending')
       RETURNING *`,
      [business.id, subscription.id, plan.price_ghs, reference]
    );
    return { billing: ins.rows[0], subscription };
  });

  const reference = billingRow.billing.reference;

  if (alreadyPending) {
    logger.info('initiateRenewal: pending charge already exists ref=%s — returning existing', reference);
    return {
      success: true,
      alreadyPending: true,
      reference,
      subscriptionId: billingRow.subscription.id,
      status: 'pending'
    };
  }

  const charge = await pawapay.chargeSubscription({
    phoneNumber: business.whatsapp_number,
    amountGhs: plan.price_ghs,
    depositId: reference,
    description: `${plan.display_name} renewal`,
    clientReferenceId: billingRow.subscription.id
  });

  if (!charge.success) {
    await query(
      `UPDATE billing_transactions
          SET status = 'failed',
              gateway_response = $2::jsonb,
              completed_at = NOW()
        WHERE reference = $1`,
      [reference, JSON.stringify(charge.raw || { error: charge.error })]
    );
    return { success: false, error: charge.error, reference };
  }

  await query(
    `UPDATE billing_transactions
        SET gateway_response = $2::jsonb
      WHERE reference = $1`,
    [reference, JSON.stringify(charge.raw || {})]
  );

  return {
    success: true,
    reference,
    subscriptionId: billingRow.subscription.id,
    status: charge.status,
    raw: charge.raw
  };
}

/**
 * Apply a successful payment to the subscription: extend the period by one
 * billing cycle. Idempotent + amount-validated:
 *
 *   - Locks the billing row (FOR UPDATE) — concurrent webhook deliveries serialize.
 *   - Refuses to apply twice (status='success' returns already_applied).
 *   - Refuses to apply a previously failed/cancelled charge.
 *   - Verifies the gateway-reported amount matches the row's amount_ghs
 *     within 1 pesewa. Mismatches mark the row as failed and do NOT extend
 *     the subscription — this blocks "$0.01 paid, full month granted" attacks.
 */
async function applySuccessfulPayment({ reference, transactionId, amount }) {
  return transaction(async client => {
    const billingRes = await client.query(
      `SELECT bt.*, s.business_id AS sub_business_id, s.plan_id, p.billing_cycle,
              s.current_period_end AS sub_period_end,
              p.display_name AS plan_display_name, p.price_ghs AS plan_price_ghs
         FROM billing_transactions bt
         JOIN subscriptions s ON s.id = bt.subscription_id
         -- The charge was created for the pending plan when a change is in
         -- flight, so cycle/name must come from that plan, not the current one.
         JOIN plans p ON p.id = COALESCE(s.pending_plan_id, s.plan_id)
        WHERE bt.reference = $1
        FOR UPDATE`,
      [reference]
    );
    const billing = billingRes.rows[0];
    if (!billing) {
      logger.warn('applySuccessfulPayment: no billing row for reference %s', reference);
      return { applied: false, reason: 'unknown_reference' };
    }

    if (billing.status === 'success') {
      return { applied: false, reason: 'already_applied', billing };
    }
    if (billing.status === 'failed' || billing.status === 'cancelled') {
      logger.warn(
        'applySuccessfulPayment: refusing to apply success to %s billing row ref=%s',
        billing.status, reference
      );
      return { applied: false, reason: `billing_${billing.status}`, billing };
    }

    // Amount check: gateway must have collected at least the row's amount
    // (within 1 pesewa). Overpayments are accepted as-is — the gateway is the
    // source of truth for what was actually collected.
    const expected = Number(billing.amount_ghs);
    const collected = amount != null ? Number(amount) : expected;
    if (!Number.isFinite(collected) || collected < expected - 0.01) {
      logger.warn(
        'applySuccessfulPayment: amount mismatch ref=%s expected=%s got=%s — marking failed',
        reference, expected, collected
      );
      await client.query(
        `UPDATE billing_transactions
            SET status = 'failed',
                completed_at = NOW(),
                gateway_response = COALESCE(gateway_response, '{}'::jsonb) ||
                                   jsonb_build_object('amount_mismatch', true,
                                                      'expected', $2::numeric,
                                                      'received', $3::numeric)
          WHERE id = $1`,
        [billing.id, expected, collected]
      );
      return { applied: false, reason: 'amount_mismatch', expected, received: collected };
    }

    await client.query(
      `UPDATE billing_transactions
          SET status = 'success',
              gateway_ref = COALESCE($2, gateway_ref),
              completed_at = NOW(),
              gateway_response = COALESCE(gateway_response, '{}'::jsonb) ||
                                 jsonb_build_object('amount', $3::numeric)
        WHERE id = $1`,
      [billing.id, transactionId || null, collected]
    );

    const now = new Date();
    const cycleDays = billing.billing_cycle === 'yearly' ? 365
      : billing.billing_cycle === 'quarterly' ? 90
      : 30;
    // Paying early must not forfeit already-paid days: extend from the current
    // period end when it is still in the future, otherwise from now.
    const base = billing.sub_period_end && new Date(billing.sub_period_end) > now
      ? new Date(billing.sub_period_end)
      : now;
    const periodEnd = addDays(base, cycleDays);

    const subRes = await client.query(
      `UPDATE subscriptions
          SET status = 'active',
              plan_id              = COALESCE(pending_plan_id, plan_id),
              pending_plan_id      = NULL,
              current_period_start = $2,
              current_period_end   = $3,
              next_billing_date    = $3,
              retry_count          = 0,
              cancel_at_period_end = FALSE,
              cancelled_at         = NULL,
              last_payment_ref     = $4
        WHERE id = $1
        RETURNING *`,
      [billing.subscription_id, now, periodEnd, reference]
    );

    await client.query(
      `UPDATE businesses SET status = 'active' WHERE id = $1`,
      [billing.sub_business_id]
    );

    return {
      applied: true,
      billing,
      subscription: subRes.rows[0],
      planName: billing.plan_display_name,
      periodEnd
    };
  });
}

async function markPaymentFailed({ reference, errorPayload }) {
  return transaction(async client => {
    const lockRes = await client.query(
      `SELECT id, status, subscription_id FROM billing_transactions
        WHERE reference = $1 FOR UPDATE`,
      [reference]
    );
    const existing = lockRes.rows[0];
    if (!existing) return { applied: false, reason: 'unknown_reference' };

    if (existing.status === 'success') {
      logger.warn('markPaymentFailed: ignoring failure for already-successful billing ref=%s', reference);
      return { applied: false, reason: 'already_succeeded' };
    }

    const billingRes = await client.query(
      `UPDATE billing_transactions
          SET status = 'failed',
              completed_at = NOW(),
              gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
        RETURNING *`,
      [existing.id, JSON.stringify(errorPayload || {})]
    );
    const billing = billingRes.rows[0];

    // Only demote to grace when the PAID period has actually lapsed. A failed
    // mid-period charge (e.g. a declined upgrade attempt) must not push an
    // otherwise fully paid subscription into the grace→suspension pipeline.
    await client.query(
      `UPDATE subscriptions
          SET retry_count = retry_count + 1,
              pending_plan_id = NULL,
              status = CASE
                         WHEN status = 'active'
                          AND (current_period_end IS NULL OR current_period_end <= NOW())
                         THEN 'grace'
                         ELSE status
                       END
        WHERE id = $1`,
      [billing.subscription_id]
    );

    return { applied: true, billing };
  });
}

/**
 * Cancel a subscription with cancel-at-period-end semantics.
 *  - If the subscription has an active period, mark cancel_at_period_end=TRUE
 *    and move to status='pending_cancel'. The business retains access until
 *    current_period_end; the daily cron will finalize the cancellation.
 *  - If no active period exists yet (pending/grace/etc. with no period_end in
 *    the future), the cancellation takes effect immediately.
 *
 * Returns: { mode: 'period_end' | 'immediate', endsAt, subscriptions }
 */
async function cancelSubscription(businessId) {
  return transaction(async client => {
    const subs = await client.query(
      `SELECT * FROM subscriptions WHERE business_id = $1 FOR UPDATE`,
      [businessId]
    );

    const now = new Date();
    let mode = 'immediate';
    let endsAt = null;
    const updated = [];

    for (const sub of subs.rows) {
      if (sub.current_period_end && new Date(sub.current_period_end) > now && sub.status !== 'cancelled') {
        const r = await client.query(
          `UPDATE subscriptions
              SET status = 'pending_cancel',
                  cancel_at_period_end = TRUE,
                  cancelled_at = NOW(),
                  next_billing_date = NULL
            WHERE id = $1
            RETURNING *`,
          [sub.id]
        );
        updated.push(r.rows[0]);
        mode = 'period_end';
        endsAt = sub.current_period_end;
      } else {
        const r = await client.query(
          `UPDATE subscriptions
              SET status = 'cancelled',
                  cancel_at_period_end = TRUE,
                  cancelled_at = NOW(),
                  next_billing_date = NULL
            WHERE id = $1
            RETURNING *`,
          [sub.id]
        );
        updated.push(r.rows[0]);
      }
    }

    // If everything is hard-cancelled, demote the business as well.
    const stillActive = updated.some(s => s.status === 'pending_cancel');
    if (!stillActive) {
      await client.query(
        `UPDATE businesses SET status = 'cancelled' WHERE id = $1 AND status NOT IN ('suspended')`,
        [businessId]
      );
    }

    return { mode, endsAt, subscriptions: updated };
  });
}

/**
 * Finalize cancellations whose period has elapsed. Called by the daily cron.
 */
async function finalizeExpiredCancellations() {
  return transaction(async client => {
    const subRes = await client.query(
      `UPDATE subscriptions
          SET status = 'cancelled'
        WHERE status = 'pending_cancel'
          AND (current_period_end IS NULL OR current_period_end <= NOW())
        RETURNING business_id, id`
    );
    for (const row of subRes.rows) {
      await client.query(
        `UPDATE businesses
            SET status = 'cancelled'
          WHERE id = $1
            AND status NOT IN ('suspended','cancelled')
            AND NOT EXISTS (
              SELECT 1 FROM subscriptions
               WHERE business_id = $1 AND status NOT IN ('cancelled','suspended')
            )`,
        [row.business_id]
      );
    }
    return subRes.rowCount;
  });
}

async function suspendBusiness(businessId) {
  await transaction(async client => {
    await client.query(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [businessId]);
    await client.query(
      `UPDATE subscriptions SET status = 'suspended'
        WHERE business_id = $1 AND status IN ('grace','pending','active')`,
      [businessId]
    );
  });
}

/* =================================================================
   Cron job helpers
   ================================================================= */

/** Subscriptions due to renew today (or earlier) and still active/grace. */
async function getDueRenewals() {
  const res = await query(
    `SELECT s.id          AS subscription_id,
            s.business_id,
            s.plan_id,
            s.next_billing_date,
            s.retry_count,
            b.whatsapp_number,
            b.name        AS business_name,
            p.price_ghs,
            p.display_name AS plan_display_name,
            p.name        AS plan_name
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       JOIN plans p      ON p.id = s.plan_id
      WHERE s.status IN ('active','grace')
        AND s.cancel_at_period_end = FALSE
        AND s.next_billing_date IS NOT NULL
        AND s.next_billing_date <= NOW()
        AND b.status NOT IN ('cancelled','suspended')
        AND NOT EXISTS (
          SELECT 1 FROM billing_transactions bt
           WHERE bt.subscription_id = s.id AND bt.status = 'pending'
        )`
  );
  return res.rows;
}

/**
 * Subscriptions whose next_billing_date falls in (now+2d, now+3d] — the ~3-day
 * reminder. The half-open 1-day window means a once-daily job matches each
 * subscription exactly once per cycle instead of reminding on consecutive days.
 */
async function getUpcomingRenewalsForReminder() {
  const res = await query(
    `SELECT s.id          AS subscription_id,
            s.business_id,
            s.next_billing_date,
            b.whatsapp_number,
            b.name        AS business_name,
            p.price_ghs,
            p.display_name AS plan_display_name
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       JOIN plans p      ON p.id = s.plan_id
      WHERE s.status = 'active'
        AND s.next_billing_date >  NOW() + INTERVAL '2 days'
        AND s.next_billing_date <= NOW() + INTERVAL '3 days'
        AND b.status = 'active'`
  );
  return res.rows;
}

/** Subscriptions that have been in grace > SUSPENSION_GRACE_DAYS — to be suspended. */
async function getOverdueForSuspension() {
  const res = await query(
    `SELECT s.id          AS subscription_id,
            s.business_id,
            b.whatsapp_number,
            b.name        AS business_name
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
      WHERE s.status = 'grace'
        AND s.next_billing_date < NOW() - ($1 || ' days')::interval
        AND b.status NOT IN ('suspended','cancelled')`,
    [String(SUSPENSION_GRACE_DAYS)]
  );
  return res.rows;
}

async function clearStaleConversationStates() {
  const res = await query(`DELETE FROM conversation_state WHERE expires_at < NOW() RETURNING id`);
  return res.rowCount || 0;
}

/**
 * Trial businesses whose trial ends within the next 3 days and who haven't
 * been reminded yet.
 */
async function getTrialsEndingSoon() {
  const res = await query(
    `SELECT id, name, whatsapp_number, trial_ends_at
       FROM businesses
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at > NOW()
        AND trial_ends_at <= NOW() + INTERVAL '3 days'
        AND trial_reminder_sent_at IS NULL`
  );
  return res.rows;
}

async function markTrialReminderSent(businessId) {
  await query(`UPDATE businesses SET trial_reminder_sent_at = NOW() WHERE id = $1`, [businessId]);
}

/**
 * Trial businesses whose trial has already ended and who were never told.
 */
async function getExpiredTrialsToNotify() {
  const res = await query(
    `SELECT id, name, whatsapp_number, trial_ends_at
       FROM businesses
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= NOW()
        AND trial_expired_notified_at IS NULL`
  );
  return res.rows;
}

async function markTrialExpiredNotified(businessId) {
  await query(`UPDATE businesses SET trial_expired_notified_at = NOW() WHERE id = $1`, [businessId]);
}

module.exports = {
  getBusinessByWhatsApp,
  getBusinessById,
  ensureBusiness,
  listPlans,
  getPlanById,
  getPlanByName,
  getActiveSubscription,
  getSubscriptionById,
  createPendingSubscription,
  initiateRenewal,
  applySuccessfulPayment,
  markPaymentFailed,
  cancelSubscription,
  finalizeExpiredCancellations,
  suspendBusiness,
  getDueRenewals,
  getUpcomingRenewalsForReminder,
  getOverdueForSuspension,
  clearStaleConversationStates,
  getTrialsEndingSoon,
  markTrialReminderSent,
  getExpiredTrialsToNotify,
  markTrialExpiredNotified,
  SUSPENSION_GRACE_DAYS
};
