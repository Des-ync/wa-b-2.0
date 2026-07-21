const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, issueKey, issueImpersonationToken, revokeImpersonationToken } = require('../middleware/auth');
const { normalizeGhanaPhone } = require('../utils/helpers');
const wa = require('../services/whatsapp.service');
const { computeOnboardingSteps } = require('./onboarding.routes');
const { getLatencyStats } = require('../middleware/latency');
const { getMetricsSnapshot } = require('../utils/metrics');
const { recordAudit } = require('../utils/auditLog');
const { toCsv } = require('../utils/csv');

const router = express.Router();

function csvResponse(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(header, rows));
}

// All admin routes require an admin-scoped API key.
router.use(requireAuth('admin'));

/**
 * GET /api/admin/stats — high-level dashboard counters.
 */
router.get('/stats', async (_req, res) => {
  try {
    const result = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM businesses)                                AS businesses_total,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'active')        AS businesses_active,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'trial')         AS businesses_trial,
        (SELECT COUNT(*)::int FROM businesses WHERE status = 'suspended')     AS businesses_suspended,
        (SELECT COUNT(*)::int FROM customers)                                 AS customers_total,
        (SELECT COUNT(*)::int FROM products)                                  AS products_total,
        (SELECT COUNT(*)::int FROM orders)                                    AS orders_total,
        (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'paid')      AS orders_paid,
        (SELECT COALESCE(SUM(total_ghs),0) FROM orders WHERE payment_status='paid') AS gmv_ghs,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active')     AS subscriptions_active,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'grace')      AS subscriptions_grace,
        (SELECT COALESCE(SUM(amount_ghs),0) FROM billing_transactions
            WHERE status = 'success'
              AND completed_at >= date_trunc('month', NOW()))                 AS mrr_ghs_this_month,
        (SELECT COUNT(*)::int FROM message_log
            WHERE created_at >= NOW() - INTERVAL '24 hours')                  AS messages_last_24h
    `);
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    logger.error('GET /admin/stats failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/businesses — list businesses (basic).
 */
router.get('/businesses', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await query(
      `SELECT b.id, b.name, b.owner_name, b.whatsapp_number, b.wa_phone_number_id,
              b.industry, b.status, b.trial_ends_at, b.created_at, b.updated_at,
              (SELECT s.status FROM subscriptions s WHERE s.business_id = b.id
                ORDER BY s.created_at DESC LIMIT 1) AS subscription_status,
              (SELECT p.display_name FROM subscriptions s
                 JOIN plans p ON p.id = s.plan_id
                WHERE s.business_id = b.id
                ORDER BY s.created_at DESC LIMIT 1) AS plan_name
         FROM businesses b
        ORDER BY b.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ success: true, businesses: result.rows });
  } catch (err) {
    logger.error('GET /admin/businesses failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/businesses/incomplete-setup — merchants who haven't finished
 * onboarding, with the specific steps still missing. Lets support proactively
 * chase setup instead of waiting for a "why isn't my bot working" ticket.
 */
router.get('/businesses/incomplete-setup', async (_req, res) => {
  try {
    const result = await query(`
      SELECT b.id, b.name, b.owner_name, b.whatsapp_number, b.wa_phone_number_id,
             b.payout_momo_number, b.payout_momo_network, b.onboarding_test_message_sent_at,
             b.status, b.created_at,
             (SELECT COUNT(*)::int FROM products p WHERE p.business_id = b.id) AS product_count
        FROM businesses b
       ORDER BY b.created_at DESC
    `);
    const incomplete = result.rows
      .map(b => ({ business: b, checklist: computeOnboardingSteps(b, b.product_count) }))
      .filter(r => !r.checklist.all_complete)
      .map(r => ({
        id: r.business.id,
        name: r.business.name,
        owner_name: r.business.owner_name,
        whatsapp_number: r.business.whatsapp_number,
        status: r.business.status,
        created_at: r.business.created_at,
        missing_steps: r.checklist.steps.filter(s => !s.complete).map(s => s.key),
        percent: r.checklist.percent
      }));
    res.json({ success: true, businesses: incomplete });
  } catch (err) {
    logger.error('GET /admin/businesses/incomplete-setup failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/billing — recent SaaS billing transactions.
 */
router.get('/billing', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await query(
      `SELECT bt.*, b.name AS business_name, b.whatsapp_number
         FROM billing_transactions bt
         LEFT JOIN businesses b ON b.id = bt.business_id
        ORDER BY bt.initiated_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    logger.error('GET /admin/billing failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/messages — inbound/outbound message traffic across all
 * tenants, filterable: ?business_id=&direction=inbound|outbound&status=&q=
 * &before=<ISO timestamp for pagination>&limit=
 */
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (req.query.business_id) add('m.business_id = ?', req.query.business_id);
    if (['inbound', 'outbound'].includes(req.query.direction)) {
      add('m.direction = ?', req.query.direction);
    }
    if (req.query.status) add('m.status = ?', req.query.status);
    if (req.query.q) add('m.content ILIKE ?', `%${req.query.q}%`);
    if (req.query.before) add('m.created_at < ?', req.query.before);

    params.push(limit);
    const result = await query(
      `SELECT m.id, m.business_id, m.customer_id, m.direction, m.message_type,
              m.content, m.wa_message_id, m.status, m.created_at,
              b.name AS business_name,
              c.display_name AS customer_name, c.whatsapp_number AS customer_phone
         FROM message_log m
         LEFT JOIN businesses b ON b.id = m.business_id
         LEFT JOIN customers c ON c.id = m.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY m.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, messages: result.rows });
  } catch (err) {
    logger.error('GET /admin/messages failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/plans — active plans (used by the onboarding form).
 */
router.get('/plans', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, display_name, price_ghs, billing_cycle
         FROM plans WHERE is_active = TRUE ORDER BY price_ghs`
    );
    res.json({ success: true, plans: result.rows });
  } catch (err) {
    logger.error('GET /admin/plans failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/businesses — onboard a new business from the admin panel.
 * Body: { name, owner_name?, whatsapp_number, industry?, trial_days?,
 *         wa_phone_number_id?, send_welcome? }
 * Creates the tenant on trial and (optionally) texts the owner a welcome.
 */
router.post('/businesses', async (req, res) => {
  try {
    const { name, owner_name, whatsapp_number, industry, wa_phone_number_id } = req.body || {};
    const trialDays = Math.min(Math.max(parseInt(req.body?.trial_days, 10) || 14, 1), 90);

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Business name is required' });
    }
    const phone = normalizeGhanaPhone(whatsapp_number);
    if (!phone) {
      return res.status(400).json({ success: false, error: 'A valid WhatsApp number is required' });
    }

    const existing = await query('SELECT id, name FROM businesses WHERE whatsapp_number = $1', [phone]);
    if (existing.rows[0]) {
      return res.status(409).json({
        success: false,
        error: `That number already belongs to "${existing.rows[0].name}"`
      });
    }

    const inserted = await query(
      `INSERT INTO businesses (name, owner_name, whatsapp_number, wa_phone_number_id,
                               industry, status, trial_ends_at)
       VALUES ($1,$2,$3,$4,$5,'trial', NOW() + ($6 || ' days')::interval)
       RETURNING *`,
      [String(name).trim(), owner_name || null, phone, wa_phone_number_id || null,
       industry || 'retail', String(trialDays)]
    );
    const business = inserted.rows[0];
    logger.info('admin: onboarded business %s (%s), trial %d days', business.id, business.name, trialDays);

    if (req.body?.send_welcome !== false) {
      const first = (business.owner_name || '').split(' ')[0];
      wa.sendText(
        phone,
        `Akwaaba${first ? ' ' + first : ''}! 🎉 ${business.name} is now on WA-B. ` +
        `Your ${trialDays}-day free trial has started — just message this number and ` +
        `your customers can browse, order and pay right here on WhatsApp. ` +
        `We'll help you set up your products next.`,
        { businessId: business.id }
      ).catch(err => logger.warn('admin onboarding welcome SMS failed: %s', err.message));
    }

    res.status(201).json({ success: true, business });
  } catch (err) {
    logger.error('POST /admin/businesses failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/businesses/:id — full profile for the detail screen:
 * business row + latest subscription + activity counters + recent messages.
 */
router.get('/businesses/:id', async (req, res) => {
  try {
    const bizRes = await query(
      `SELECT b.*,
              (SELECT row_to_json(s) FROM (
                 SELECT s.id, s.status, s.current_period_end, s.next_billing_date,
                        p.display_name AS plan_name, p.price_ghs
                   FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                  WHERE s.business_id = b.id
                  ORDER BY s.created_at DESC LIMIT 1) s) AS subscription
         FROM businesses b WHERE b.id = $1`,
      [req.params.id]
    );
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });
    delete business.wa_access_token;
    delete business.ig_page_access_token;
    delete business.messenger_page_access_token;

    const [counters, messages] = await Promise.all([
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM customers WHERE business_id = $1)        AS customers,
           (SELECT COUNT(*)::int FROM products WHERE business_id = $1)         AS products,
           (SELECT COUNT(*)::int FROM orders WHERE business_id = $1)           AS orders,
           (SELECT COALESCE(SUM(total_ghs),0) FROM orders
             WHERE business_id = $1 AND payment_status = 'paid')               AS revenue_ghs,
           (SELECT COUNT(*)::int FROM message_log
             WHERE business_id = $1
               AND created_at >= NOW() - INTERVAL '7 days')                    AS messages_7d`,
        [req.params.id]
      ),
      query(
        `SELECT m.id, m.direction, m.message_type, m.content, m.status, m.created_at,
                c.display_name AS customer_name
           FROM message_log m LEFT JOIN customers c ON c.id = m.customer_id
          WHERE m.business_id = $1
          ORDER BY m.created_at DESC LIMIT 20`,
        [req.params.id]
      )
    ]);

    res.json({
      success: true,
      business,
      counters: counters.rows[0],
      recent_messages: messages.rows
    });
  } catch (err) {
    logger.error('GET /admin/businesses/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Fields an admin may edit from the app. Everything else (tokens, clerk ids)
// stays out of reach of this endpoint on purpose.
const EDITABLE_BUSINESS_FIELDS = [
  'name', 'owner_name', 'industry', 'status', 'whatsapp_number',
  'wa_phone_number_id', 'welcome_message', 'support_phone', 'bot_language',
  'delivery_fee_ghs', 'open_time', 'close_time', 'trial_ends_at',
  'payout_momo_number', 'payout_momo_network', 'slug', 'vat_rate_pct',
  'logo_url', 'banner_url',
  // Reopen-only here — CLOSING an account goes through POST /api/business/close,
  // which pairs closed_at with a closure_reason and its own audit entry.
  'closed_at'
];
const BUSINESS_STATUSES = ['trial', 'active', 'grace', 'suspended', 'cancelled'];
const MOMO_NETWORKS = ['mtn', 'vodafone', 'airteltigo'];

/**
 * PATCH /api/admin/businesses/:id — edit a client profile.
 */
router.patch('/businesses/:id', async (req, res) => {
  try {
    const sets = [];
    const params = [];
    for (const field of EDITABLE_BUSINESS_FIELDS) {
      if (!(field in (req.body || {}))) continue;
      let value = req.body[field];
      if (field === 'status' && !BUSINESS_STATUSES.includes(value)) {
        return res.status(400).json({ success: false, error: `status must be one of ${BUSINESS_STATUSES.join(', ')}` });
      }
      if (field === 'whatsapp_number' || field === 'payout_momo_number') {
        value = value ? normalizeGhanaPhone(value) : null;
        if (req.body[field] && !value) {
          return res.status(400).json({ success: false, error: `Invalid ${field}` });
        }
      }
      if (field === 'payout_momo_network' && value) {
        value = String(value).trim().toLowerCase();
        if (!MOMO_NETWORKS.includes(value)) {
          return res.status(400).json({ success: false, error: `payout_momo_network must be one of ${MOMO_NETWORKS.join(', ')}` });
        }
      }
      if (field === 'delivery_fee_ghs') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ success: false, error: 'Invalid delivery fee' });
        }
      }
      if (field === 'vat_rate_pct') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ success: false, error: 'vat_rate_pct must be a number between 0 and 100' });
        }
      }
      if (field === 'slug' && value) {
        value = String(value).trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/.test(value)) {
          return res.status(400).json({
            success: false,
            error: 'slug must be 3-60 lowercase letters/numbers/hyphens, no leading/trailing hyphen'
          });
        }
      }
      if (field === 'closed_at' && value) {
        return res.status(400).json({
          success: false,
          error: 'closed_at can only be cleared (reopen) here — pass null. To close an account, use POST /api/business/close.'
        });
      }
      for (const col of ['logo_url', 'banner_url']) {
        if (field === col) value = value == null ? null : String(value).trim().slice(0, 500) || null;
      }
      params.push(value === '' ? null : value);
      sets.push(`${field} = $${params.length}`);
    }
    if (!sets.length) {
      return res.status(400).json({ success: false, error: 'No editable fields in request' });
    }
    params.push(req.params.id);
    const result = await query(
      `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`,
      params
    );
    const business = result.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });
    delete business.wa_access_token;
    delete business.ig_page_access_token;
    delete business.messenger_page_access_token;
    const changedFields = sets.map(s => s.split(' ')[0]);
    logger.info('admin: updated business %s fields [%s]', business.id, changedFields.join(', '));
    recordAudit({
      actorType: 'admin', actorId: req.auth?.keyId, businessId: business.id,
      action: 'business.update', detail: { fields: changedFields }
    });
    res.json({ success: true, business });
  } catch (err) {
    if (err.code === '23505' && /slug/.test(err.constraint || '')) {
      return res.status(409).json({ success: false, error: 'That storefront handle is already taken' });
    }
    logger.error('PATCH /admin/businesses/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/businesses/:id/message — WhatsApp the business owner
 * directly from the admin panel (support / onboarding follow-ups).
 */
router.post('/businesses/:id/message', async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ success: false, error: 'Message body is required' });

    const bizRes = await query('SELECT id, whatsapp_number FROM businesses WHERE id = $1', [req.params.id]);
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const sent = await wa.sendText(business.whatsapp_number, body, { businessId: business.id });
    if (!sent.success) {
      return res.status(502).json({ success: false, error: sent.error || 'WhatsApp send failed' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /admin/businesses/:id/message failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/businesses/:id/api-key — issue a tenant API key.
 * The plaintext is returned exactly once.
 */
router.post('/businesses/:id/api-key', async (req, res) => {
  try {
    const bizRes = await query('SELECT id, name FROM businesses WHERE id = $1', [req.params.id]);
    if (!bizRes.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });

    const key = await issueKey({
      name: String(req.body?.name || `${bizRes.rows[0].name} (admin-issued)`).slice(0, 120),
      businessId: req.params.id,
      scope: 'tenant'
    });
    recordAudit({
      actorType: 'admin', actorId: req.auth?.keyId, businessId: req.params.id,
      action: 'api_key.issue', detail: { key_id: key.id, name: key.name }
    });
    res.status(201).json({ success: true, key });
  } catch (err) {
    logger.error('POST /admin/businesses/:id/api-key failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Tail the winston error log (logs/error.log, JSON lines). Best-effort:
 * a missing or unreadable file just yields [].
 */
function tailErrorLog(maxEntries = 100) {
  try {
    const file = path.join(process.cwd(), 'logs', 'error.log');
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    // Read only the final chunk — the log rotates at 5 MB but reads stay cheap.
    const readBytes = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readBytes);
    try {
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    } finally {
      // Guarantee the descriptor is closed even if the read throws — otherwise
      // repeated failures leak fds until the process hits EMFILE.
      fs.closeSync(fd);
    }
    return buf.toString('utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-maxEntries)
      .map(line => {
        try {
          const e = JSON.parse(line);
          return { at: e.timestamp, message: e.message, stack: e.stack || null };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (err) {
    logger.warn('tailErrorLog failed: %s', err.message);
    return [];
  }
}

/**
 * GET /api/admin/issues — one live feed of everything going wrong:
 * server error-log entries, failed/stuck webhooks, failed message sends
 * and failed billing charges. Newest first.
 */
router.get('/issues', async (_req, res) => {
  try {
    const [webhooks, messages, billing] = await Promise.all([
      query(
        `SELECT w.id, w.source, w.status, w.attempts, w.last_error, w.received_at
           FROM webhook_events w
          WHERE w.status = 'failed'
             OR (w.status = 'pending' AND w.received_at < NOW() - INTERVAL '10 minutes')
          ORDER BY w.received_at DESC LIMIT 50`
      ),
      query(
        `SELECT m.id, m.business_id, m.content, m.created_at, b.name AS business_name
           FROM message_log m LEFT JOIN businesses b ON b.id = m.business_id
          WHERE m.status = 'failed' AND m.created_at >= NOW() - INTERVAL '7 days'
          ORDER BY m.created_at DESC LIMIT 50`
      ),
      query(
        `SELECT bt.id, bt.amount_ghs, bt.gateway, bt.initiated_at, b.name AS business_name
           FROM billing_transactions bt LEFT JOIN businesses b ON b.id = bt.business_id
          WHERE bt.status = 'failed' AND bt.initiated_at >= NOW() - INTERVAL '14 days'
          ORDER BY bt.initiated_at DESC LIMIT 50`
      )
    ]);

    const issues = [
      ...tailErrorLog(60).map(e => ({
        kind: 'server_error',
        at: e.at,
        title: String(e.message || '').slice(0, 200),
        detail: e.stack ? String(e.stack).slice(0, 600) : null
      })),
      ...webhooks.rows.map(w => ({
        kind: w.status === 'failed' ? 'webhook_failed' : 'webhook_stuck',
        at: w.received_at,
        title: `${w.source} webhook ${w.status === 'failed' ? 'failed' : 'stuck pending'} (${w.attempts} attempts)`,
        detail: w.last_error ? String(w.last_error).slice(0, 600) : null,
        webhook_id: w.id
      })),
      ...messages.rows.map(m => ({
        kind: 'message_failed',
        at: m.created_at,
        title: `Message send failed${m.business_name ? ' — ' + m.business_name : ''}`,
        detail: m.content ? String(m.content).slice(0, 300) : null,
        business_id: m.business_id
      })),
      ...billing.rows.map(t => ({
        kind: 'billing_failed',
        at: t.initiated_at,
        title: `Billing charge failed — ${t.business_name || 'unknown'} (GHS ${t.amount_ghs} via ${t.gateway})`,
        detail: null
      }))
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 150);

    res.json({ success: true, issues });
  } catch (err) {
    logger.error('GET /admin/issues failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/health — live backend vitals for the ops screen.
 */
router.get('/health', async (_req, res) => {
  try {
    const t0 = Date.now();
    const queue = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int    AS webhooks_pending,
         COUNT(*) FILTER (WHERE status = 'processing')::int AS webhooks_processing,
         COUNT(*) FILTER (WHERE status = 'failed')::int     AS webhooks_failed,
         (SELECT COUNT(*)::int FROM message_log
           WHERE created_at >= NOW() - INTERVAL '1 hour')   AS messages_last_hour,
         (SELECT COUNT(*)::int FROM message_log
           WHERE status = 'failed'
             AND created_at >= NOW() - INTERVAL '24 hours') AS messages_failed_24h
       FROM webhook_events
       WHERE received_at >= NOW() - INTERVAL '7 days'`
    );
    const dbLatencyMs = Date.now() - t0;
    const mem = process.memoryUsage();
    res.json({
      success: true,
      health: {
        ...queue.rows[0],
        db_latency_ms: dbLatencyMs,
        uptime_seconds: Math.round(process.uptime()),
        memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
        node_version: process.version,
        env: process.env.NODE_ENV || 'development',
        // Platform-wide, not per-tenant — see onboarding.routes.js's
        // webhook-health note: Paystack is one shared account for every shop.
        paystack_mode: process.env.PAYSTACK_SECRET_KEY
          ? (/^(sk|pk)_test_/.test(process.env.PAYSTACK_SECRET_KEY) ? 'test' : 'live')
          : 'unconfigured'
      }
    });
  } catch (err) {
    logger.error('GET /admin/health failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/ops — everything the admin operational dashboard needs
 * beyond /health and /issues: p95 response times, retry counts, per-provider
 * webhook error rates, stuck orders/payments, and recent alert history.
 */
router.get('/ops', async (_req, res) => {
  try {
    const [byProvider, stuckOrders, alerts] = await Promise.all([
      query(
        `SELECT source,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COALESCE(SUM(attempts), 0)::int AS total_attempts,
                COALESCE(MAX(attempts), 0)::int AS max_attempts
           FROM webhook_events
          WHERE received_at >= NOW() - INTERVAL '7 days'
          GROUP BY source
          ORDER BY source`
      ),
      query(
        `SELECT id, order_number, business_id, total_ghs, payment_status, updated_at
           FROM orders
          WHERE payment_status = 'pending'
            AND updated_at < NOW() - INTERVAL '15 minutes'
          ORDER BY updated_at ASC
          LIMIT 50`
      ),
      query(
        `SELECT id, title, detail, suppressed_count, created_at
           FROM admin_alerts
          ORDER BY created_at DESC
          LIMIT 50`
      )
    ]);

    const providerErrorRates = byProvider.rows.map(r => ({
      ...r,
      error_rate_pct: r.total > 0 ? Math.round((r.failed / r.total) * 100) : 0
    }));

    res.json({
      success: true,
      ops: {
        latency: getLatencyStats({ withinMinutes: 60 }),
        provider_error_rates: providerErrorRates,
        stuck_payments: stuckOrders.rows,
        stuck_payments_count: stuckOrders.rowCount,
        alerts: alerts.rows,
        metrics: getMetricsSnapshot()
      }
    });
  } catch (err) {
    logger.error('GET /admin/ops failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/audit-log?business_id=&limit= — who did what: business
 * settings changes, API key issuance, promo edits, and anything else
 * wired to recordAudit(). Order-level history lives on the order itself
 * (order_status_history) instead of here.
 */
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const params = [];
    let where = '';
    if (req.query.business_id) {
      params.push(req.query.business_id);
      where = 'WHERE business_id = $1';
    }
    params.push(limit);
    const result = await query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    if (String(req.query.format || 'json').toLowerCase() === 'csv') {
      const columns = ['id', 'actor_type', 'actor_id', 'business_id', 'action', 'detail', 'created_at'];
      const rows = result.rows.map(r => [
        r.id, r.actor_type, r.actor_id || '', r.business_id || '', r.action,
        JSON.stringify(r.detail || {}), r.created_at.toISOString()
      ]);
      return csvResponse(res, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`, columns, rows);
    }
    res.json({ success: true, audit_log: result.rows });
  } catch (err) {
    logger.error('GET /admin/audit-log failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/webhooks — inspect the inbound webhook queue.
 * ?status=failed|pending|done|processing&limit=
 */
router.get('/webhooks', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const params = [];
    let where = '';
    if (req.query.status) {
      params.push(req.query.status);
      where = 'WHERE status = $1';
    }
    params.push(limit);
    const result = await query(
      `SELECT id, source, external_id, status, attempts, last_error, signature_valid,
              next_attempt_at, processed_at, received_at
         FROM webhook_events ${where}
        ORDER BY received_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, webhooks: result.rows });
  } catch (err) {
    logger.error('GET /admin/webhooks failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/webhooks/:id — debug/diff viewer: the full stored event,
 * raw payload included, so a failure can be diagnosed without SSHing in to
 * read logs. signature_header is the raw header value the provider sent
 * (present only for sources that verify one at the door — WhatsApp,
 * Instagram, Paystack, Hubtel).
 */
router.get('/webhooks/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM webhook_events WHERE id = $1', [req.params.id]);
    const event = result.rows[0];
    if (!event) return res.status(404).json({ success: false, error: 'Webhook event not found' });
    res.json({ success: true, webhook: event });
  } catch (err) {
    logger.error('GET /admin/webhooks/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/webhooks/:id/retry — requeue one failed webhook.
 * POST /api/admin/webhooks/retry-failed — requeue everything failed.
 */
router.post('/webhooks/retry-failed', async (_req, res) => {
  try {
    const result = await query(
      `UPDATE webhook_events
          SET status = 'pending', next_attempt_at = NOW(),
              locked_at = NULL, locked_by = NULL
        WHERE status = 'failed'
        RETURNING id`
    );
    logger.info('admin: requeued %d failed webhooks', result.rowCount);
    res.json({ success: true, requeued: result.rowCount });
  } catch (err) {
    logger.error('POST /admin/webhooks/retry-failed failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/webhooks/:id/retry', async (req, res) => {
  try {
    const result = await query(
      `UPDATE webhook_events
          SET status = 'pending', next_attempt_at = NOW(),
              locked_at = NULL, locked_by = NULL
        WHERE id = $1 AND status = 'failed'
        RETURNING id`,
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ success: false, error: 'No failed webhook with that id' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /admin/webhooks/:id/retry failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Merchant impersonation (audited, read-only support mode)
   ================================================================= */

/**
 * POST /api/admin/businesses/:id/impersonate — body: { reason, ttl_minutes? }
 * Issues a short-lived (default 30 min), strictly read-only token an admin
 * can use exactly like a tenant API key (Authorization: Bearer <token>)
 * against every existing tenant-scoped route — requireAuth() resolves it to
 * role='readonly' (utils/permissions.js), so any write attempt 403s the
 * same way an accountant-role key would. Every issuance is audited with the
 * admin's own key id and the stated reason; every use bumps last_used_at.
 */
router.post('/businesses/:id/impersonate', async (req, res) => {
  try {
    const bizRes = await query('SELECT id, name FROM businesses WHERE id = $1', [req.params.id]);
    if (!bizRes.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });

    const ttl = Math.min(Math.max(parseInt(req.body?.ttl_minutes, 10) || 30, 5), 120);
    const session = await issueImpersonationToken({
      businessId: req.params.id,
      adminKeyId: req.auth?.keyId || null,
      reason: req.body?.reason,
      ttlMinutes: ttl
    });
    recordAudit({
      actorType: 'admin', actorId: req.auth?.keyId, businessId: req.params.id,
      action: 'admin.impersonate_start',
      detail: { session_id: session.id, reason: req.body?.reason, ttl_minutes: ttl }
    });
    res.status(201).json({ success: true, session });
  } catch (err) {
    logger.error('POST /admin/businesses/:id/impersonate failed: %s', err.message);
    res.status(400).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/** POST /api/admin/impersonation/:id/revoke — end a support session early. */
router.post('/impersonation/:id/revoke', async (req, res) => {
  try {
    const ok = await revokeImpersonationToken(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'Session not found or already revoked' });
    recordAudit({
      actorType: 'admin', actorId: req.auth?.keyId, businessId: null,
      action: 'admin.impersonate_end', detail: { session_id: req.params.id }
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /admin/impersonation/:id/revoke failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** GET /api/admin/businesses/:id/impersonation-history — audit trail of support-mode access. */
router.get('/businesses/:id/impersonation-history', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, admin_key_id, reason, expires_at, revoked_at, last_used_at, created_at
         FROM impersonation_sessions WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, sessions: result.rows });
  } catch (err) {
    logger.error('GET /admin/businesses/:id/impersonation-history failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Tenant health score
   ================================================================= */

/**
 * GET /api/admin/businesses/:id/health-score — a single composite number
 * (0-100) plus its factor breakdown, so support can triage "which shops need
 * attention" without opening five different screens. Every factor is a real,
 * already-instrumented signal — nothing here is fabricated:
 *   - WhatsApp connected (wa_phone_number_id set)                    25 pts
 *   - Inbound WhatsApp activity in the last 30d (or too new to judge) 25 pts
 *   - Payment failures in the last 30d (orders.payment_status)       20 pts
 *   - Subscription status                                           20 pts
 *   - Message quota headroom this month vs. plan cap                10 pts
 */
router.get('/businesses/:id/health-score', async (req, res) => {
  try {
    const bizRes = await query(
      `SELECT id, name, wa_phone_number_id, created_at FROM businesses WHERE id = $1`,
      [req.params.id]
    );
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const [msgRes, failedRes, subRes, quotaRes] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS n FROM message_log
          WHERE business_id = $1 AND direction = 'inbound' AND created_at >= NOW() - INTERVAL '30 days'`,
        [business.id]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM orders
          WHERE business_id = $1 AND payment_status = 'failed' AND created_at >= NOW() - INTERVAL '30 days'`,
        [business.id]
      ),
      query(
        `SELECT s.status FROM subscriptions s WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [business.id]
      ),
      query(
        `SELECT p.max_msgs_month,
                (SELECT COUNT(*)::int FROM message_log m
                  WHERE m.business_id = $1 AND m.direction = 'outbound'
                    AND m.created_at >= date_trunc('month', NOW())) AS sent_this_month
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [business.id]
      )
    ]);

    const ageDays = (Date.now() - new Date(business.created_at).getTime()) / 86_400_000;
    const inboundCount = msgRes.rows[0].n;
    const failedCount = failedRes.rows[0].n;
    const subStatus = subRes.rows[0]?.status || 'none';
    const quota = quotaRes.rows[0] || null;

    const factors = {
      whatsapp_connected: {
        points: business.wa_phone_number_id ? 25 : 0, max: 25,
        detail: business.wa_phone_number_id ? 'Connected' : 'No wa_phone_number_id set'
      },
      whatsapp_activity: {
        points: !business.wa_phone_number_id ? 0 : (inboundCount > 0 ? 25 : (ageDays < 3 ? 15 : 0)),
        max: 25,
        detail: inboundCount > 0
          ? `${inboundCount} inbound message(s) in 30d`
          : (ageDays < 3 ? 'Too new to judge (< 3 days old)' : 'No inbound messages in 30d')
      },
      payment_failures: {
        points: Math.max(0, 20 - failedCount * 4), max: 20,
        detail: `${failedCount} failed payment(s) in 30d`
      },
      subscription_status: {
        points: { active: 20, trial: 20, grace: 10, suspended: 0, cancelled: 0, pending: 10, none: 0 }[subStatus] ?? 0,
        max: 20,
        detail: subStatus
      },
      quota_headroom: {
        points: (() => {
          if (!quota || quota.max_msgs_month == null || quota.max_msgs_month === -1) return 10;
          const usedPct = quota.sent_this_month / quota.max_msgs_month;
          return usedPct >= 1 ? 0 : usedPct >= 0.9 ? 4 : 10;
        })(),
        max: 10,
        detail: quota && quota.max_msgs_month != null && quota.max_msgs_month !== -1
          ? `${quota.sent_this_month}/${quota.max_msgs_month} messages this month`
          : 'Unlimited plan or no active subscription'
      }
    };
    const score = Object.values(factors).reduce((sum, f) => sum + f.points, 0);

    res.json({ success: true, health_score: score, factors });
  } catch (err) {
    logger.error('GET /admin/businesses/:id/health-score failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Per-tenant usage dashboard
   ================================================================= */

/**
 * GET /api/admin/businesses/:id/usage — messages, broadcasts, and webhook
 * volume this billing month, against the plan's message cap. Deliberately
 * does NOT report "API calls" or "storage/media usage" — this codebase has
 * no per-request counter (adding one would mean a DB write on every single
 * API call, a real latency/cost tradeoff not worth taking for an ops nicety)
 * and no media storage of its own (image_url values are external links) —
 * reporting a made-up number for either would be worse than omitting them.
 */
router.get('/businesses/:id/usage', async (req, res) => {
  try {
    const bizRes = await query('SELECT id, name FROM businesses WHERE id = $1', [req.params.id]);
    if (!bizRes.rows[0]) return res.status(404).json({ success: false, error: 'Business not found' });
    const businessId = req.params.id;

    const [msgRes, broadcastRes, planRes] = await Promise.all([
      query(
        `SELECT
           COUNT(*) FILTER (WHERE direction = 'outbound')::int AS sent_this_month,
           COUNT(*) FILTER (WHERE direction = 'inbound')::int  AS received_this_month
         FROM message_log
        WHERE business_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [businessId]
      ),
      query(
        `SELECT COUNT(*)::int AS broadcasts_sent,
                COALESCE(SUM(sent_count), 0)::int AS recipients_sent
           FROM broadcasts
          WHERE business_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [businessId]
      ),
      query(
        `SELECT p.display_name, p.max_msgs_month, p.max_numbers
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [businessId]
      )
    ]);

    const plan = planRes.rows[0] || null;
    const sent = msgRes.rows[0].sent_this_month;
    res.json({
      success: true,
      usage: {
        plan_name: plan?.display_name || null,
        messages_sent_this_month: sent,
        messages_received_this_month: msgRes.rows[0].received_this_month,
        message_cap: plan && plan.max_msgs_month !== -1 ? plan.max_msgs_month : null,
        message_cap_used_pct: plan && plan.max_msgs_month && plan.max_msgs_month !== -1
          ? Math.round((sent / plan.max_msgs_month) * 100) : null,
        broadcasts_sent_this_month: broadcastRes.rows[0].broadcasts_sent,
        broadcast_recipients_sent_this_month: broadcastRes.rows[0].recipients_sent
      }
    });
  } catch (err) {
    logger.error('GET /admin/businesses/:id/usage failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Risk flags
   ================================================================= */

/**
 * GET /api/admin/risk-flags — platform-wide feed of things worth a human
 * look: API keys used from a new IP (already logged by lookupKey() as
 * audit_log action='auth.suspicious_new_ip'), and per-business spikes in
 * failed payments or inbound message volume (today vs. that business's own
 * trailing 7-day daily average) — a spike is relative to each shop's own
 * baseline, not a fixed platform-wide threshold, so a naturally busy shop
 * doesn't get flagged just for being busy.
 */
router.get('/risk-flags', async (_req, res) => {
  try {
    const [suspiciousIps, paymentSpikes, messageSpikes] = await Promise.all([
      query(
        `SELECT al.id, al.actor_id, al.business_id, b.name AS business_name, al.detail, al.created_at
           FROM audit_log al LEFT JOIN businesses b ON b.id = al.business_id
          WHERE al.action = 'auth.suspicious_new_ip' AND al.created_at >= NOW() - INTERVAL '7 days'
          ORDER BY al.created_at DESC LIMIT 50`
      ),
      query(
        `WITH daily AS (
           SELECT business_id, (created_at AT TIME ZONE 'Africa/Accra')::date AS day, COUNT(*) AS n
             FROM orders WHERE payment_status = 'failed' AND created_at >= NOW() - INTERVAL '8 days'
             GROUP BY business_id, day
         ),
         baseline AS (
           SELECT business_id, AVG(n) AS avg_n FROM daily
            WHERE day < (NOW() AT TIME ZONE 'Africa/Accra')::date GROUP BY business_id
         )
         SELECT d.business_id, b.name AS business_name, d.n AS today_count, COALESCE(bl.avg_n, 0) AS baseline_avg
           FROM daily d JOIN businesses b ON b.id = d.business_id
           LEFT JOIN baseline bl ON bl.business_id = d.business_id
          WHERE d.day = (NOW() AT TIME ZONE 'Africa/Accra')::date
            AND d.n >= 3 AND d.n > GREATEST(COALESCE(bl.avg_n, 0) * 3, 2)
          ORDER BY d.n DESC`
      ),
      query(
        `WITH daily AS (
           SELECT business_id, (created_at AT TIME ZONE 'Africa/Accra')::date AS day, COUNT(*) AS n
             FROM message_log WHERE created_at >= NOW() - INTERVAL '8 days'
             GROUP BY business_id, day
         ),
         baseline AS (
           SELECT business_id, AVG(n) AS avg_n FROM daily
            WHERE day < (NOW() AT TIME ZONE 'Africa/Accra')::date GROUP BY business_id
         )
         SELECT d.business_id, b.name AS business_name, d.n AS today_count, COALESCE(bl.avg_n, 0) AS baseline_avg
           FROM daily d JOIN businesses b ON b.id = d.business_id
           LEFT JOIN baseline bl ON bl.business_id = d.business_id
          WHERE d.day = (NOW() AT TIME ZONE 'Africa/Accra')::date
            AND d.n >= 20 AND d.n > GREATEST(COALESCE(bl.avg_n, 0) * 3, 20)
          ORDER BY d.n DESC`
      )
    ]);

    const flags = [
      ...suspiciousIps.rows.map(r => ({
        kind: 'suspicious_ip', at: r.created_at, business_id: r.business_id, business_name: r.business_name,
        title: `API key used from a new IP${r.business_name ? ' — ' + r.business_name : ''}`,
        detail: r.detail
      })),
      ...paymentSpikes.rows.map(r => ({
        kind: 'failed_payment_spike', at: new Date(), business_id: r.business_id, business_name: r.business_name,
        title: `Failed-payment spike — ${r.business_name}`,
        detail: { today: r.today_count, baseline_avg: Number(Number(r.baseline_avg).toFixed(1)) }
      })),
      ...messageSpikes.rows.map(r => ({
        kind: 'message_spike', at: new Date(), business_id: r.business_id, business_name: r.business_name,
        title: `Message-volume spike — ${r.business_name}`,
        detail: { today: r.today_count, baseline_avg: Number(Number(r.baseline_avg).toFixed(1)) }
      }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ success: true, flags });
  } catch (err) {
    logger.error('GET /admin/risk-flags failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
