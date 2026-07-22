require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const logger = require('./utils/logger');
const { pool, query } = require('./config/database');
const notification = require('./services/notification.service');
const webhookProcessor = require('./services/webhook.processor');
const paymentSweeper = require('./services/payment.sweeper');
const cartNudge = require('./services/cart.nudge');
const loyaltyJobs = require('./services/loyalty.jobs');
const automations = require('./services/automations');
const broadcastSender = require('./services/broadcast.sender');
const { alertOps } = require('./services/alert.service');
const dbBackup = require('./jobs/db.backup');
const dailySummary = require('./jobs/daily.summary');
const { requireAuth } = require('./middleware/auth');
const { latencyMiddleware } = require('./middleware/latency');
const { requestIdMiddleware } = require('./middleware/requestId');

const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');
const productRoutes = require('./routes/product.routes');
const authRoutes = require('./routes/auth.routes');
const customerRoutes = require('./routes/customer.routes');
const businessRoutes = require('./routes/business.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const conversationsRoutes = require('./routes/conversations.routes');
const broadcastRoutes = require('./routes/broadcast.routes');
const promoRoutes = require('./routes/promo.routes');
const receiptRoutes = require('./routes/receipt.routes');
const deviceRoutes = require('./routes/device.routes');
const onboardingRoutes = require('./routes/onboarding.routes');
const categoryRoutes = require('./routes/category.routes');
const notificationRoutes = require('./routes/notification.routes');
const searchRoutes = require('./routes/search.routes');
const apikeyRoutes = require('./routes/apikey.routes');
const storefrontRoutes = require('./routes/storefront.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const accountingRoutes = require('./routes/accounting.routes');
const automationsRoutes = require('./routes/automations.routes');
const auditlogRoutes = require('./routes/auditlog.routes');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Behind Nginx: trust the first proxy hop so req.ip (used by the rate
// limiter) reflects the real client, not 127.0.0.1.
app.set('trust proxy', 1);

// First middleware, always — every log line for the rest of this request
// (sync or async) needs the AsyncLocalStorage context this opens.
app.use(requestIdMiddleware);

// Security headers. The marketing site and dashboard rely on inline scripts
// and Clerk's hosted JS, so the CSP below is deliberately permissive
// ('unsafe-inline' + any https: origin) — but it still blocks http: script
// injection, plugin/object embedding, and base-tag hijacking, which is far
// better than no CSP at all. Tighten to nonces if the inline scripts move out.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'", 'https:'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https:'],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'", 'https:'],
      'font-src': ["'self'", 'data:', 'https:'],
      'frame-src': ['https:'],
      'worker-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      // Don't force-upgrade in local http dev; HSTS in production is nginx's job.
      'upgrade-insecure-requests': null
    }
  },
  crossOriginEmbedderPolicy: false
}));

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
  '/api/webhooks/messenger',
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
app.use(latencyMiddleware);

/* -------------------------------------------------------------------------
   Storefront OG/SEO server-render — mounted BEFORE the static middleware so
   a request for storefront.html?shop=<slug> gets real <title>/og:* tags in
   the initial HTML response (link-preview crawlers on WhatsApp/Facebook/
   Twitter never execute the page's client-side fetch). Any other request
   for this path (no ?shop, unknown shop) falls through to the static file
   unchanged via next(). The template is read once and cached — only the
   per-shop meta values are interpolated per request.
   ------------------------------------------------------------------------- */
const STOREFRONT_TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'storefront.html');
let storefrontTemplateCache = null;
function loadStorefrontTemplate() {
  if (!storefrontTemplateCache) {
    storefrontTemplateCache = fs.readFileSync(STOREFRONT_TEMPLATE_PATH, 'utf8');
  }
  return storefrontTemplateCache;
}
function escapeHtmlAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

app.get('/wa-b/storefront.html', async (req, res, next) => {
  const slug = String(req.query.shop || '').toLowerCase();
  if (!slug) return next();
  try {
    const bizRes = await query(
      `SELECT name, welcome_message, logo_url, banner_url, status, closed_at
         FROM businesses WHERE slug = $1`,
      [slug]
    );
    const business = bizRes.rows[0];
    if (!business || business.closed_at || ['suspended', 'cancelled'].includes(business.status)) {
      return next();
    }

    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const pageUrl = `${base}/wa-b/storefront.html?shop=${encodeURIComponent(slug)}`;
    const title = escapeHtmlAttr(`${business.name} · WA-B Solutions`);
    const description = escapeHtmlAttr(
      (business.welcome_message || `Browse ${business.name}'s catalog and order on WhatsApp.`).slice(0, 200)
    );
    const image = escapeHtmlAttr(business.banner_url || business.logo_url || `${base}/wa-b/assets/logo-light.jpg`);
    const ogTags = [
      '<meta property="og:type" content="website" />',
      `<meta property="og:title" content="${title}" />`,
      `<meta property="og:description" content="${description}" />`,
      `<meta property="og:url" content="${escapeHtmlAttr(pageUrl)}" />`,
      `<meta property="og:image" content="${image}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
      `<meta name="twitter:title" content="${title}" />`,
      `<meta name="twitter:description" content="${description}" />`,
      `<meta name="twitter:image" content="${image}" />`
    ].join('\n');

    const html = loadStorefrontTemplate()
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
      .replace(/<meta name="description"[^>]*\/>/, `<meta name="description" content="${description}" />`)
      .replace('<!--OG:TAGS-->', ogTags);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    logger.error('Storefront SSR failed for slug=%s: %s', slug, err.message);
    next();
  }
});

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
app.use('/api/customers', apiLimiter, customerRoutes);
app.use('/api/business', apiLimiter, businessRoutes);
app.use('/api/analytics', apiLimiter, analyticsRoutes);
app.use('/api/conversations', apiLimiter, conversationsRoutes);
app.use('/api/broadcasts', apiLimiter, broadcastRoutes);
app.use('/api/promos', apiLimiter, promoRoutes);
app.use('/api/devices', apiLimiter, deviceRoutes);
app.use('/api/onboarding', apiLimiter, onboardingRoutes);
app.use('/api/categories', apiLimiter, categoryRoutes);
app.use('/api/notifications', apiLimiter, notificationRoutes);
app.use('/api/search', apiLimiter, searchRoutes);
app.use('/api/keys', apiLimiter, apikeyRoutes);
// Public, unauthenticated — the order id itself is the shareable capability.
app.use('/api/receipts', apiLimiter, receiptRoutes);
app.use('/api/storefront', apiLimiter, storefrontRoutes);
app.use('/api/inventory', apiLimiter, inventoryRoutes);
app.use('/api/accounting', apiLimiter, accountingRoutes);
app.use('/api/automations', apiLimiter, automationsRoutes);
app.use('/api/audit-log', apiLimiter, auditlogRoutes);

// Public system status — powers the (honest) status page. Exposes only
// coarse operational signals, never tenant data.
app.get('/api/status', apiLimiter, async (_req, res) => {
  const status = { db: false, queue: null, checked_at: new Date().toISOString() };
  try {
    const r = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM webhook_events WHERE status = 'pending')     AS pending,
         (SELECT COUNT(*)::int FROM webhook_events WHERE status = 'processing')  AS processing,
         (SELECT COUNT(*)::int FROM webhook_events
           WHERE status = 'failed' AND received_at > NOW() - INTERVAL '24 hours') AS failed_24h,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(received_at)))::int
            FROM webhook_events)                                                 AS last_webhook_age_s,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(next_attempt_at)))::int
            FROM webhook_events WHERE status = 'pending')                        AS oldest_pending_age_s`
    );
    status.db = true;
    status.queue = r.rows[0];
    const degraded = (status.queue.pending || 0) > 100 || (status.queue.oldest_pending_age_s || 0) > 600;
    status.overall = degraded ? 'degraded' : 'operational';
    res.json({ success: true, status });
  } catch (err) {
    logger.error('GET /api/status failed: %s', err.message);
    status.overall = 'outage';
    res.status(503).json({ success: false, status });
  }
});

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

  // Cart-abandonment nudges every 15 minutes (leader-locked, once per cart).
  cron.schedule('*/15 * * * *', () => {
    cartNudge.runCartNudgeJob().catch(err =>
      logger.error('cartNudgeJob crashed: %s', err.message, { stack: err.stack })
    );
  }, { timezone: 'Africa/Accra' });

  // Birthday loyalty coupons, daily 07:00 — self-locked via worker_locks
  // (birthday_coupon_job), so this is safe even if RUN_CRON=true on more
  // than one instance. Previously only scheduled in src/worker.js, which
  // deploy/ecosystem.config.js never starts (only wa-saas-api / src/server.js
  // runs in production) — it was dead code in practice.
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
  const detail = reason && reason.stack ? reason.stack : String(reason);
  logger.error('Unhandled promise rejection: %s', detail);
  alertOps('Unhandled promise rejection', detail);
});
process.on('uncaughtException', err => {
  logger.error('Uncaught exception: %s', err.stack || err.message);
  alertOps('Uncaught exception', err.stack || err.message);
});

function gracefulShutdown(signal) {
  logger.info('Received %s, shutting down gracefully...', signal);
  try { webhookProcessor.stop(); } catch (_e) { /* ignore */ }
  // Stop cron jobs before tearing down the pool, otherwise a job firing during
  // shutdown queries a closed pool and logs a crash.
  try { for (const task of cron.getTasks().values()) task.stop(); } catch (_e) { /* ignore */ }
  server.close(async () => {
    try { await pool.end(); } catch (_e) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
