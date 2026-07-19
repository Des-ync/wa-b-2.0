const logger = require('../utils/logger');
const wa = require('./whatsapp.service');
const { getAdapter, destOf } = require('./channel.adapter');
const subService = require('./subscription.service');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const { formatGhs } = require('../utils/helpers');
const { t, langOf } = require('../utils/i18n');
const push = require('./push.service');

const WEBHOOK_RETENTION_DAYS = parseInt(process.env.WEBHOOK_RETENTION_DAYS || '30', 10);
const MESSAGE_LOG_RETENTION_DAYS = parseInt(process.env.MESSAGE_LOG_RETENTION_DAYS || '90', 10);

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

        const result = await subService.initiateRenewal({ business, plan });
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

    // Trial lifecycle: "ending soon" reminders, then "trial ended" notices.
    try {
      const endingSoon = await subService.getTrialsEndingSoon();
      if (endingSoon.length) logger.info('[cron] %d trial(s) ending soon', endingSoon.length);
      for (const biz of endingSoon) {
        try {
          const daysLeft = Math.max(
            1,
            Math.ceil((new Date(biz.trial_ends_at) - new Date()) / (24 * 3600 * 1000))
          );
          await wa.sendTrialReminder(biz.whatsapp_number, {
            businessName: biz.name,
            endsAt: biz.trial_ends_at,
            daysLeft
          }, { businessId: biz.id });
          await subService.markTrialReminderSent(biz.id);
        } catch (err) {
          logger.error('[cron] trial reminder failed for %s: %s', biz.whatsapp_number, err.message);
        }
      }

      const expired = await subService.getExpiredTrialsToNotify();
      if (expired.length) logger.info('[cron] %d expired trial(s) to notify', expired.length);
      for (const biz of expired) {
        try {
          await wa.sendTrialExpiredNotice(biz.whatsapp_number, { businessName: biz.name },
            { businessId: biz.id });
          await subService.markTrialExpiredNotified(biz.id);
        } catch (err) {
          logger.error('[cron] trial-expired notice failed for %s: %s', biz.whatsapp_number, err.message);
        }
      }
    } catch (err) {
      logger.error('[cron] trial lifecycle pass failed: %s', err.message);
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
  // Customer receipt goes out on the channel the customer ordered from;
  // the merchant notification below stays WhatsApp-only.
  if (customer && destOf(customer)) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const receiptUrl = base ? `${base}/wa-b/receipt.html?order=${order.id}` : null;
    promises.push(
      getAdapter(customer.channel).sendPaymentConfirmation(destOf(customer), {
        orderNumber: order.order_number,
        total: order.total_ghs,
        businessName: business?.name,
        lang: langOf(business),
        receiptUrl
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

  push.pushToBusiness(business?.id, {
    title: '💰 New paid order',
    body: `${customer?.display_name || customer?.whatsapp_number || 'A customer'} paid ${formatGhs(order.total_ghs)} — #${order.order_number}`,
    data: { type: 'order', order_id: order.id }
  });
}

/**
 * Tell the customer their order moved to a new fulfilment status.
 * Used by both the merchant's WhatsApp reply flow and the dashboard API.
 */
const STATUS_KEYS = {
  confirmed: 'ns_confirmed',
  preparing: 'ns_preparing',
  ready: 'ns_ready',
  delivered: 'ns_delivered',
  cancelled: 'ns_cancelled'
};

async function notifyOrderStatusChange({ order, business }) {
  if (!order?.customer_id) return;
  const key = STATUS_KEYS[order.status];
  if (!key) return;
  try {
    const customerRes = await query('SELECT * FROM customers WHERE id = $1', [order.customer_id]);
    const customer = customerRes.rows[0];
    if (!customer) return;
    // Callers don't always pass the full business row; fetch what's missing.
    // Both name and bot_language are needed — the notification text is
    // branded with the shop's name, so a language-only fetch would leave
    // customers seeing "at the shop" instead of the real business name.
    let biz = business;
    if (!biz || !('bot_language' in biz) || !biz.name) {
      const bizRes = await query('SELECT name, bot_language FROM businesses WHERE id = $1', [order.business_id]);
      biz = bizRes.rows[0] || biz;
    }
    const lang = langOf(biz);
    await getAdapter(customer.channel).sendText(
      destOf(customer),
      t(lang, key, { n: order.order_number, shop: biz?.name || 'the shop' }),
      { businessId: order.business_id, customerId: customer.id }
    );
  } catch (err) {
    logger.warn('notifyOrderStatusChange failed for order %s: %s', order.id, err.message);
  }
}

/**
 * Weekly retention pass: prune processed webhook events and old message logs
 * so PII ages out on a fixed schedule (matches the privacy policy's claims).
 */
async function runPruneJob() {
  await lock.withLock('prune_job', 600, async () => {
    logger.info('[cron] runPruneJob starting (webhooks>%dd, messages>%dd)',
      WEBHOOK_RETENTION_DAYS, MESSAGE_LOG_RETENTION_DAYS);
    try {
      const w = await query(
        `DELETE FROM webhook_events
          WHERE status IN ('done','failed')
            AND received_at < NOW() - ($1 || ' days')::interval`,
        [String(WEBHOOK_RETENTION_DAYS)]
      );
      const m = await query(
        `DELETE FROM message_log
          WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(MESSAGE_LOG_RETENTION_DAYS)]
      );
      const o = await query(
        `DELETE FROM business_link_otps WHERE expires_at < NOW() - INTERVAL '1 day'`
      );
      logger.info('[cron] runPruneJob done: %d webhook event(s), %d message log row(s), %d link OTP(s) pruned',
        w.rowCount, m.rowCount, o.rowCount);
    } catch (err) {
      logger.error('[cron] runPruneJob failed: %s', err.message);
    }
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
  push.pushToBusiness(business.id, {
    title: '✅ Subscription renewed',
    body: `${planName} — ${formatGhs(amountGhs)} paid. Active until ${new Date(periodEnd).toLocaleDateString('en-GB')}.`,
    data: { type: 'subscription' }
  });
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
  push.pushToBusiness(business.id, {
    title: '⚠️ Subscription payment failed',
    body: `${planName} — ${formatGhs(amountGhs)}. Open the app to retry.`,
    data: { type: 'subscription' }
  });
}

module.exports = {
  runRenewalJob,
  runReminderJob,
  runSuspensionJob,
  runPruneJob,
  notifyOrderPaid,
  notifyOrderStatusChange,
  notifySubscriptionRenewed,
  notifySubscriptionFailed
};
