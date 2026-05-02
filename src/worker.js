/**
 * Standalone worker process. Run this exactly ONCE per environment alongside
 * any number of HTTP server replicas (which should be started with
 * RUN_CRON=false RUN_PROCESSOR=false to keep them stateless).
 *
 * Responsibilities:
 *   - Drain the webhook_events queue (whatsapp / paystack / hubtel events)
 *   - Run the daily cron jobs (renewal / reminder / suspension)
 *
 * The worker_locks table protects against accidental multi-instance running of
 * the cron jobs (e.g., during a deploy overlap). The webhook queue uses
 * SELECT ... FOR UPDATE SKIP LOCKED so it scales to multiple workers safely.
 */
require('dotenv').config();
const cron = require('node-cron');
const logger = require('./utils/logger');
const { pool } = require('./config/database');
const notification = require('./services/notification.service');
const webhookProcessor = require('./services/webhook.processor');

logger.info('🛠  Starting WhatsApp SaaS worker (env=%s)', process.env.NODE_ENV || 'development');

// 1) Webhook queue drain
webhookProcessor.start({
  intervalMs: parseInt(process.env.PROCESSOR_INTERVAL_MS || '1500', 10)
});

// 2) Cron jobs
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

logger.info('Worker cron + processor armed.');

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection: %s', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', err => {
  logger.error('Uncaught exception: %s', err.stack || err.message);
});

function shutdown(signal) {
  logger.info('Received %s, shutting down worker...', signal);
  try { webhookProcessor.stop(); } catch (_e) { /* ignore */ }
  pool.end()
    .catch(() => {})
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
