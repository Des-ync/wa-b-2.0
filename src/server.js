require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const logger = require('./utils/logger');
const { pool } = require('./config/database');
const notification = require('./services/notification.service');
const webhookProcessor = require('./services/webhook.processor');

const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// In a multi-instance deployment, set RUN_CRON=false on every replica except one
// (or run the dedicated worker via `node src/worker.js` instead). The worker_lock
// table is the cooperative safety net that prevents double-execution either way.
const RUN_CRON = process.env.RUN_CRON !== 'false';
const RUN_PROCESSOR = process.env.RUN_PROCESSOR !== 'false';

/* -------------------------------------------------------------------------
   Middleware order matters:
   - Payment webhook routes need the RAW body so we can verify HMAC signatures.
     Mount express.raw() ONLY for those exact paths, before express.json().
   - All other routes use parsed JSON.
   ------------------------------------------------------------------------- */

app.use(
  '/api/payments/paystack/webhook',
  express.raw({ type: '*/*', limit: '1mb' })
);
app.use(
  '/api/payments/hubtel/callback',
  express.raw({ type: '*/*', limit: '1mb' })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Lightweight request logger (skip noisy webhook polling)
app.use((req, _res, next) => {
  if (!req.path.startsWith('/api/webhooks/whatsapp') || req.method !== 'GET') {
    logger.debug('%s %s', req.method, req.path);
  }
  next();
});

/* -------------------------------------------------------------------------
   Health + root
   ------------------------------------------------------------------------- */

app.get('/', (_req, res) => {
  res.json({
    service: 'whatsapp-saas',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ status: 'ok', db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: false, error: err.message });
  }
});

/* -------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */

app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

// Final error handler — never crashes on bad payloads
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error: %s', err.message, { stack: err.stack });
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Internal server error' });
});

/* -------------------------------------------------------------------------
   Cron jobs (Africa/Accra)
   ------------------------------------------------------------------------- */

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

  logger.info('Cron jobs scheduled (Africa/Accra) — 08:00 renewals, 09:00 reminders, 10:00 suspensions.');
}

/* -------------------------------------------------------------------------
   Bootstrap
   ------------------------------------------------------------------------- */

const server = app.listen(PORT, () => {
  logger.info('🚀 WhatsApp SaaS server listening on port %d (env=%s)', PORT, process.env.NODE_ENV || 'development');
  if (RUN_CRON) {
    startCronJobs();
  } else {
    logger.info('Cron disabled in this instance (RUN_CRON=false)');
  }
  if (RUN_PROCESSOR) {
    webhookProcessor.start({ intervalMs: parseInt(process.env.PROCESSOR_INTERVAL_MS || '1500', 10) });
  } else {
    logger.info('Webhook processor disabled in this instance (RUN_PROCESSOR=false)');
  }
});

process.on('unhandledRejection', reason => {
  logger.error('Unhandled promise rejection: %s', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', err => {
  logger.error('Uncaught exception: %s', err.stack || err.message);
});

function gracefulShutdown(signal) {
  logger.info('Received %s, shutting down gracefully...', signal);
  try { webhookProcessor.stop(); } catch (_e) { /* ignore */ }
  server.close(async () => {
    try { await pool.end(); } catch (_e) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
