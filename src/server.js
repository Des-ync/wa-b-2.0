require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const logger = require('./utils/logger');
const { pool, query } = require('./config/database');
const notification = require('./services/notification.service');
const webhookProcessor = require('./services/webhook.processor');
const paymentSweeper = require('./services/payment.sweeper');
const { requireAuth } = require('./middleware/auth');

const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');
const productRoutes = require('./routes/product.routes');
const authRoutes = require('./routes/auth.routes');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Behind Nginx: trust the first proxy hop so req.ip (used by the rate
// limiter) reflects the real client, not 127.0.0.1.
app.set('trust proxy', 1);

// Security headers. CSP is off because the marketing site and dashboard use
// inline scripts; everything else (frameguard, nosniff, HSTS via nginx) applies.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

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
  '/api/webhooks/whatsapp',
  express.raw({ type: '*/*', limit: '1mb' })
);
app.use(
  '/api/webhooks/instagram',
  express.raw({ type: '*/*', limit: '1mb' })
);
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

// Marketing site (public/) — mounted at /wa-b so this app can live alongside
// other projects on the same domain instead of owning the domain root.
app.use('/wa-b', express.static(path.join(__dirname, '..', 'public')));

// Lightweight request logger (skip noisy webhook polling)
app.use((req, _res, next) => {
  if (!req.path.startsWith('/api/webhooks/whatsapp') || req.method !== 'GET') {
    logger.debug('%s %s', req.method, req.path);
  }
  next();
});

/* -------------------------------------------------------------------------
   Health check
   ------------------------------------------------------------------------- */

app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ status: 'ok', db: r.rows[0].ok === 1 });
  } catch (err) {
    logger.error('Health check DB probe failed: %s', err.message);
    res.status(503).json({ status: 'degraded', db: false });
  }
});

/* -------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */

// Throttle the authed management APIs (webhooks are deliberately excluded —
// Meta/Paystack retry bursts must never be rate-limited into data loss).
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, slow down.' }
});

app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/subscriptions', apiLimiter, subscriptionRoutes);
app.use('/api/orders', apiLimiter, orderRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/products', apiLimiter, productRoutes);
app.use('/api/auth', apiLimiter, authRoutes);

// Who am I? Lets the dashboard resolve the business behind an API key OR a
// Clerk session token — requireAuth() accepts either transparently. A Clerk
// user with no linked business gets a 409 'not_linked' from requireAuth
// itself, which the dashboard uses to show the "link your shop" step.
app.get('/api/me', apiLimiter, requireAuth('any'), async (req, res) => {
  try {
    if (req.auth.scope === 'admin') {
      return res.json({ success: true, scope: 'admin', business: null });
    }
    const r = await query(
      'SELECT id, name, owner_name, whatsapp_number, status, trial_ends_at FROM businesses WHERE id = $1',
      [req.auth.businessId]
    );
    res.json({ success: true, scope: 'tenant', business: r.rows[0] || null });
  } catch (err) {
    logger.error('GET /api/me failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 404 — /wa-b/* gets the branded page, API callers get JSON, everything
// else (the domain root, reserved for other projects) falls through as JSON too.
app.use((req, res) => {
  if (req.method === 'GET' && req.path.startsWith('/wa-b')) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }
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

  logger.info('Cron jobs scheduled (Africa/Accra) — 08:00 renewals, 09:00 reminders, 10:00 suspensions, 5-min payment sweeper, weekly prune.');
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
