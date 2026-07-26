/**
 * Standalone worker process. Run this exactly ONCE per environment alongside
 * any number of HTTP server replicas (which should be started with
 * RUN_CRON=false RUN_PROCESSOR=false to keep them stateless).
 *
 * Responsibilities:
 *   - Drain the webhook_events queue (whatsapp / paystack / hubtel events)
 *   - Run every cron job via the shared src/services/cronJobs.js — the same
 *     module src/server.js uses in single-process mode, so this can never
 *     silently drift to a different/incomplete job list again.
 *
 * The worker_locks table protects against accidental multi-instance running of
 * the cron jobs (e.g., during a deploy overlap). The webhook queue uses
 * SELECT ... FOR UPDATE SKIP LOCKED so it scales to multiple workers safely.
 */
require('dotenv').config();
const cron = require('node-cron');
const logger = require('./utils/logger');
const { pool } = require('./config/database');
const webhookProcessor = require('./services/webhook.processor');
const { startCronJobs } = require('./services/cronJobs');

logger.info('🛠  Starting WhatsApp SaaS worker (env=%s)', process.env.NODE_ENV || 'development');

// 1) Webhook queue drain
webhookProcessor.start({
  intervalMs: parseInt(process.env.PROCESSOR_INTERVAL_MS || '1500', 10)
});

// 2) Cron jobs
startCronJobs();

logger.info('Worker cron + processor armed.');

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection: %s', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', err => {
  logger.error('Uncaught exception: %s', err.stack || err.message);
});

async function shutdown(signal) {
  logger.info('Received %s, shutting down worker...', signal);
  try { webhookProcessor.stop(); } catch (_e) { /* ignore */ }
  // Stop cron so nothing new fires against a closing pool.
  try { for (const task of cron.getTasks().values()) task.stop(); } catch (_e) { /* ignore */ }

  // Let any in-flight webhook drain finish (up to ~10s) so mid-flight events
  // aren't truncated into a stuck 'processing' state.
  const deadline = Date.now() + 10_000;
  while (webhookProcessor.isRunning() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  pool.end()
    .catch(() => {})
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
