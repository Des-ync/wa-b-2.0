const cron = require('node-cron');
const logger = require('../utils/logger');
const notification = require('./notification.service');
const paymentSweeper = require('./payment.sweeper');
const cartNudge = require('./cart.nudge');
const loyaltyJobs = require('./loyalty.jobs');
const automations = require('./automations');
const broadcastSender = require('./broadcast.sender');
const dbBackup = require('../jobs/db.backup');
const dailySummary = require('../jobs/daily.summary');

/**
 * The single source of truth for every scheduled job, shared by src/server.js
 * (single-process deploy, the default) and src/worker.js (the dedicated
 * worker for a multi-instance deploy — see README.md section 13). Previously
 * each file scheduled its own copy of this list, and they silently drifted
 * out of sync (the birthday-coupon job existed only in worker.js while
 * deploy/ecosystem.config.js only ever started server.js, so it never fired
 * in production). Keeping exactly one copy makes that class of bug
 * structurally impossible — add a job here once and both entry points get it.
 */
function startCronJobs() {
  // Each job acquires a DB-backed worker_lock first, so even if multiple
  // instances run this scheduler (RUN_CRON=true everywhere), only one will
  // execute the body of each job per fire.
  cron.schedule('0 8 * * *', () => {
    notification.runRenewalJob().catch(err =>
      logger.error('renewalJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  cron.schedule('0 9 * * *', () => {
    notification.runReminderJob().catch(err =>
      logger.error('reminderJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  cron.schedule('0 10 * * *', () => {
    notification.runSuspensionJob().catch(err =>
      logger.error('suspensionJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Reconcile stuck pending payments every 5 minutes.
  cron.schedule('*/5 * * * *', () => {
    paymentSweeper.runPaymentSweeper().catch(err =>
      logger.error('paymentSweeper crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Weekly retention prune (Sunday 02:30).
  cron.schedule('30 2 * * 0', () => {
    notification.runPruneJob().catch(err =>
      logger.error('pruneJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Cart-abandonment nudges every 15 minutes (leader-locked, once per cart).
  cron.schedule('*/15 * * * *', () => {
    cartNudge.runCartNudgeJob().catch(err =>
      logger.error('cartNudgeJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Birthday loyalty coupons, daily 07:00 — self-locked via worker_locks
  // (birthday_coupon_job), so this is safe even if RUN_CRON=true on more
  // than one instance.
  cron.schedule('0 7 * * *', () => {
    loyaltyJobs.runBirthdayCouponJob().catch(err =>
      logger.error('birthdayCouponJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Broadcast queue drain, once a minute — small rate-limited batches so a
  // merchant's re-engagement blast never bursts past Meta's send limits.
  cron.schedule('* * * * *', () => {
    broadcastSender.runBroadcastSenderJob().catch(err =>
      logger.error('broadcastSenderJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Lifecycle automations (reorder reminder / win-back / post-purchase
  // review / delivery feedback) every 30 minutes — hour/day-granularity
  // triggers, no need for tighter polling.
  cron.schedule('*/30 * * * *', () => {
    automations.runAutomationsJob().catch(err =>
      logger.error('automationsJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Nightly DB backup (03:15 Africa/Accra, low-traffic hour). No-op unless
  // DB_BACKUP_ENABLED=true — see .env.example.
  cron.schedule('15 3 * * *', () => {
    dbBackup.runDbBackupJob().catch(err =>
      logger.error('dbBackupJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // End-of-day merchant summary (20:30 Africa/Accra) — orders, revenue, top
  // product, low stock, failed payments, via WhatsApp + mobile push.
  cron.schedule('30 20 * * *', () => {
    dailySummary.runDailySummaryJob().catch(err =>
      logger.error('dailySummaryJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  logger.info('Cron jobs scheduled (Africa/Accra) — 08:00 renewals, 09:00 reminders, 10:00 suspensions, 5-min payment sweeper, 15-min cart nudges, 07:00 birthday coupons, 1-min broadcast drain, 30-min lifecycle automations, 20:30 daily summary, 03:15 db backup, weekly prune.');
}

module.exports = { startCronJobs };
