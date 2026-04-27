const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { generateReference, addDays } = require('../utils/helpers');
const hubtel = require('./hubtel.service');

const SUSPENSION_GRACE_DAYS = parseInt(process.env.SUSPENSION_GRACE_DAYS || '3', 10);

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
    `INSERT INTO businesses (name, owner_name, whatsapp_number, industry, status)
     VALUES ($1,$2,$3,$4,'trial') RETURNING *`,
    [name || 'Unnamed Business', ownerName || null, whatsappNumber, industry || 'retail']
  );
  return inserted.rows[0];
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
 * Initiate a Hubtel MoMo charge for a SaaS subscription. Creates a billing_transactions
 * record + subscription (if missing), all in a single transaction.
 */
async function initiateRenewal({ business, plan, callbackUrl }) {
  if (!business || !plan) throw new Error('business and plan required');

  const reference = generateReference('SUB');

  const billingRow = await transaction(async client => {
    let subRes = await client.query(
      'SELECT * FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1',
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
    } else if (subscription.plan_id !== plan.id) {
      const upd = await client.query(
        `UPDATE subscriptions SET plan_id = $2 WHERE id = $1 RETURNING *`,
        [subscription.id, plan.id]
      );
      subscription = upd.rows[0];
    }

    const ins = await client.query(
      `INSERT INTO billing_transactions
         (business_id, subscription_id, amount_ghs, gateway, reference, status)
       VALUES ($1,$2,$3,'hubtel',$4,'pending')
       RETURNING *`,
      [business.id, subscription.id, plan.price_ghs, reference]
    );
    return { billing: ins.rows[0], subscription };
  });

  const charge = await hubtel.chargeSubscription({
    phoneNumber: business.whatsapp_number,
    amountGhs: plan.price_ghs,
    reference,
    description: `${plan.display_name} plan renewal`,
    callbackUrl
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
        SET gateway_response = $2::jsonb,
            gateway_ref = $3
      WHERE reference = $1`,
    [reference, JSON.stringify(charge.raw || {}), charge.transactionId || null]
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
 * Apply a successful payment to the subscription: extend the period by one billing cycle.
 */
async function applySuccessfulPayment({ reference, transactionId, amount }) {
  return transaction(async client => {
    const billingRes = await client.query(
      `SELECT bt.*, s.business_id AS sub_business_id, s.plan_id, p.billing_cycle, p.display_name AS plan_display_name
         FROM billing_transactions bt
         JOIN subscriptions s ON s.id = bt.subscription_id
         JOIN plans p ON p.id = s.plan_id
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

    await client.query(
      `UPDATE billing_transactions
          SET status = 'success',
              gateway_ref = COALESCE($2, gateway_ref),
              completed_at = NOW(),
              gateway_response = COALESCE(gateway_response, '{}'::jsonb) ||
                                 jsonb_build_object('amount', $3::numeric)
        WHERE id = $1`,
      [billing.id, transactionId || null, amount || billing.amount_ghs]
    );

    const now = new Date();
    const periodEnd = addDays(now, billing.billing_cycle === 'monthly' ? 30 : 30);

    const subRes = await client.query(
      `UPDATE subscriptions
          SET status = 'active',
              current_period_start = $2,
              current_period_end   = $3,
              next_billing_date    = $3,
              retry_count          = 0,
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
    const billingRes = await client.query(
      `UPDATE billing_transactions
          SET status = 'failed',
              completed_at = NOW(),
              gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $2::jsonb
        WHERE reference = $1
        RETURNING *`,
      [reference, JSON.stringify(errorPayload || {})]
    );
    const billing = billingRes.rows[0];
    if (!billing) return { applied: false, reason: 'unknown_reference' };

    await client.query(
      `UPDATE subscriptions
          SET retry_count = retry_count + 1,
              status = CASE
                         WHEN status = 'active' THEN 'grace'
                         ELSE status
                       END
        WHERE id = $1`,
      [billing.subscription_id]
    );

    return { applied: true, billing };
  });
}

async function cancelSubscription(businessId) {
  const res = await query(
    `UPDATE subscriptions
        SET status = 'cancelled'
      WHERE business_id = $1
      RETURNING *`,
    [businessId]
  );
  return res.rows;
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
        AND s.next_billing_date IS NOT NULL
        AND s.next_billing_date <= NOW()
        AND b.status NOT IN ('cancelled','suspended')`
  );
  return res.rows;
}

/** Subscriptions whose next_billing_date is in (2,4) days from now → 3-day reminder window. */
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
        AND s.next_billing_date BETWEEN NOW() + INTERVAL '2 days' AND NOW() + INTERVAL '4 days'
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
  suspendBusiness,
  getDueRenewals,
  getUpcomingRenewalsForReminder,
  getOverdueForSuspension,
  clearStaleConversationStates,
  SUSPENSION_GRACE_DAYS
};
