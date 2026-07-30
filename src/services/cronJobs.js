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
 *
 * The two guards below make the OTHER half of that bug class structurally
 * impossible too: a job registered twice fires twice, which for a job like
 * the broadcast drain or the birthday coupon means duplicate customer
 * messages. Both failures are loud at startup rather than silent in
 * production, which is the whole point — the original bug survived for
 * months precisely because nothing ever complained.
 */

const registered = new Set();
let started = false;

/**
 * Schedule one job. Throws on a duplicate name so a copy-paste that reuses an
 * existing job's name fails at boot instead of double-firing forever.
 */
function register(name, expression, run) {
  if (registered.has(name)) {
    throw new Error(
      `Cron job "${name}" is already registered — a job must be scheduled exactly once. ` +
      'Registering it twice makes it fire twice per tick.'
    );
  }
  registered.add(name);
  cron.schedule(expression, () => {
    run().catch(err =>
      logger.error('%s crashed: %s', name, err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });
}

function startCronJobs() {
  // Guard against BOTH entry points running in one process (e.g. a future
  // change that requires server.js from worker.js, or a test harness that
  // boots the app twice) — that would double every job below.
  if (started) {
    throw new Error(
      'startCronJobs() has already run in this process. Exactly one of src/server.js ' +
      'or src/worker.js may schedule jobs — see README.md section 13.'
    );
  }
  started = true;

  // Each job acquires a DB-backed worker_lock first, so even if multiple
  // instances run this scheduler (RUN_CRON=true everywhere), only one will
  // execute the body of each job per fire.
  register('renewalJob', '0 8 * * *', () => notification.runRenewalJob());
  register('reminderJob', '0 9 * * *', () => notification.runReminderJob());
  register('suspensionJob', '0 10 * * *', () => notification.runSuspensionJob());

  // Reconcile stuck pending payments every 5 minutes.
  register('paymentSweeper', '*/5 * * * *', () => paymentSweeper.runPaymentSweeper());

  // Weekly retention prune (Sunday 02:30).
  register('pruneJob', '30 2 * * 0', () => notification.runPruneJob());

  // Cart-abandonment nudges every 15 minutes (leader-locked, once per cart).
  register('cartNudgeJob', '*/15 * * * *', () => cartNudge.runCartNudgeJob());

  // Birthday loyalty coupons, daily 07:00 — self-locked via worker_locks
  // (birthday_coupon_job), so this is safe even if RUN_CRON=true on more
  // than one instance.
  register('birthdayCouponJob', '0 7 * * *', () => loyaltyJobs.runBirthdayCouponJob());

  // Broadcast queue drain, once a minute — small rate-limited batches so a
  // merchant's re-engagement blast never bursts past Meta's send limits.
  register('broadcastSenderJob', '* * * * *', () => broadcastSender.runBroadcastSenderJob());

  // Lifecycle automations (reorder reminder / win-back / post-purchase
  // review / delivery feedback) every 30 minutes — hour/day-granularity
  // triggers, no need for tighter polling.
  register('automationsJob', '*/30 * * * *', () => automations.runAutomationsJob());

  // Nightly DB backup (03:15 Africa/Accra, low-traffic hour). No-op unless
  // DB_BACKUP_ENABLED=true — see .env.example.
  register('dbBackupJob', '15 3 * * *', () => dbBackup.runDbBackupJob());

  // End-of-day merchant summary (20:30 Africa/Accra) — orders, revenue, top
  // product, low stock, failed payments, via WhatsApp + mobile push.
  register('dailySummaryJob', '30 20 * * *', () => dailySummary.runDailySummaryJob());

  logger.info('Cron jobs scheduled (Africa/Accra), %d jobs: %s',
    registered.size, [...registered].join(', '));
}

/** Test-only: clear the guards so a suite can exercise startCronJobs twice. */
function __resetForTests() {
  registered.clear();
  started = false;
}

module.exports = { startCronJobs, __resetForTests };
