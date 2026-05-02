const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
const subService = require('./subscription.service');
const lock = require('./worker.lock');
const { formatGhs } = require('../utils/helpers');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/**
 * Cron: charge subscriptions due today. Single-leader via worker_locks.
 */
async function runRenewalJob() {
  await lock.withLock('renewal_job', 600, async () => {
    logger.info('[cron] runRenewalJob starting');
    const due = await subService.getDueRenewals();
    logger.info('[cron] %d subscription(s) due for renewal', due.length);

    let ok = 0, fail = 0, skipped = 0;
    for (const row of due) {
      try {
        const business = await subService.getBusinessById(row.business_id);
        const plan = await subService.getPlanById(row.plan_id);
        if (!business || !plan) continue;

        const callbackUrl = PUBLIC_BASE_URL
          ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/hubtel/callback`
          : undefined;

        const result = await subService.initiateRenewal({ business, plan, callbackUrl });
        if (result.alreadyPending) {
          skipped++;
          logger.info('[cron] Renewal already pending for %s ref=%s', business.whatsapp_number, result.reference);
        } else if (result.success) {
          ok++;
          logger.info('[cron] Renewal initiated for %s ref=%s', business.whatsapp_number, result.reference);
        } else {
          fail++;
          logger.warn('[cron] Renewal failed for %s: %s', business.whatsapp_number, result.error);
        }
      } catch (err) {
        fail++;
        logger.error('[cron] renewal error for business %s: %s', row.business_id, err.message);
      }
    }
    logger.info('[cron] runRenewalJob done. ok=%d skipped=%d fail=%d', ok, skipped, fail);

    try {
      const finalized = await subService.finalizeExpiredCancellations();
      if (finalized) logger.info('[cron] Finalized %d cancel-at-period-end subscription(s)', finalized);
    } catch (err) {
      logger.warn('[cron] finalizeExpiredCancellations failed: %s', err.message);
    }

    try {
      const cleared = await subService.clearStaleConversationStates();
      if (cleared) logger.info('[cron] Cleared %d stale conversation state(s)', cleared);
    } catch (err) {
      logger.warn('[cron] clearStaleConversationStates failed: %s', err.message);
    }
  });
}

/**
 * Cron: send 3-day renewal reminders. Single-leader via worker_locks.
 */
async function runReminderJob() {
  await lock.withLock('reminder_job', 600, async () => {
    logger.info('[cron] runReminderJob starting');
    const upcoming = await subService.getUpcomingRenewalsForReminder();
    logger.info('[cron] %d business(es) need a renewal reminder', upcoming.length);

    for (const row of upcoming) {
      try {
        const daysLeft = Math.max(
          1,
          Math.ceil((new Date(row.next_billing_date) - new Date()) / (24 * 3600 * 1000))
        );
        await wa.sendRenewalReminder(row.whatsapp_number, {
          planName: row.plan_display_name,
          amountGhs: row.price_ghs,
          daysLeft
        }, { businessId: row.business_id });
      } catch (err) {
        logger.error('[cron] reminder send failed for %s: %s', row.whatsapp_number, err.message);
      }
    }
    logger.info('[cron] runReminderJob done');
  });
}

/**
 * Cron: suspend businesses past the grace period. Single-leader via worker_locks.
 */
async function runSuspensionJob() {
  await lock.withLock('suspension_job', 600, async () => {
    logger.info('[cron] runSuspensionJob starting');
    const overdue = await subService.getOverdueForSuspension();
    logger.info('[cron] %d business(es) past grace period', overdue.length);

    for (const row of overdue) {
      try {
        await subService.suspendBusiness(row.business_id);
        await wa.sendSuspensionNotice(row.whatsapp_number, {
          businessName: row.business_name
        }, { businessId: row.business_id });
      } catch (err) {
        logger.error('[cron] suspension failed for %s: %s', row.whatsapp_number, err.message);
      }
    }
    logger.info('[cron] runSuspensionJob done');
  });
}

/**
 * Notify customer + business when a customer order is paid.
 */
async function notifyOrderPaid({ order, business, customer }) {
  const promises = [];
  if (customer?.whatsapp_number) {
    promises.push(
      wa.sendPaymentConfirmation(customer.whatsapp_number, {
        orderNumber: order.order_number,
        total: order.total_ghs,
        businessName: business?.name
      }, { businessId: business?.id, customerId: customer.id })
    );
  }
  if (business?.whatsapp_number) {
    promises.push(
      wa.sendOrderNotification(business.whatsapp_number, {
        orderNumber: order.order_number,
        customerName: customer?.display_name || customer?.whatsapp_number,
        items: Array.isArray(order.items) ? order.items : [],
        total: order.total_ghs,
        address: order.delivery_address
      }, { businessId: business?.id })
    );
  }
  const results = await Promise.allSettled(promises);
  results.forEach(r => {
    if (r.status === 'rejected') logger.warn('notifyOrderPaid send rejected: %s', r.reason?.message);
  });
}

/**
 * Notify a business that their SaaS subscription was activated/renewed.
 */
async function notifySubscriptionRenewed({ business, planName, amountGhs, periodEnd }) {
  if (!business?.whatsapp_number) return;
  try {
    await wa.sendSubscriptionReceipt(business.whatsapp_number, {
      planName,
      amountGhs,
      expiresAt: periodEnd
    }, { businessId: business.id });
  } catch (err) {
    logger.warn('notifySubscriptionRenewed send failed: %s', err.message);
  }
}

/**
 * Notify a business that their SaaS payment failed.
 */
async function notifySubscriptionFailed({ business, planName, amountGhs, reason }) {
  if (!business?.whatsapp_number) return;
  const text =
`⚠️ Subscription payment failed

Plan: ${planName}
Amount: ${formatGhs(amountGhs)}
${reason ? `Reason: ${reason}\n` : ''}
Reply *RETRY* to try again or *SUPPORT* if you need help.`;
  try {
    await wa.sendText(business.whatsapp_number, text, { businessId: business.id });
  } catch (err) {
    logger.warn('notifySubscriptionFailed send failed: %s', err.message);
  }
}

module.exports = {
  runRenewalJob,
  runReminderJob,
  runSuspensionJob,
  notifyOrderPaid,
  notifySubscriptionRenewed,
  notifySubscriptionFailed
};
