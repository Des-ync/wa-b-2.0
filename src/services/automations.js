/**
 * Lifecycle-automation engine — reorder reminders, win-back, post-purchase
 * review, delivery feedback. One generic table + registry (automations,
 * automation_sends) driving all four, instead of a bespoke cron function
 * copy-pasted per template the way cart_nudge.js and loyalty.jobs.js's
 * birthday job each are — those two are the pattern this deliberately does
 * NOT repeat a third and fourth time.
 *
 * Delivery: every message here is business-initiated, sent to a customer who
 * (for win_back/reorder_reminder especially) is very likely outside Meta's
 * 24-hour free-form messaging window — the same constraint cart_nudge.js
 * documents, except cart_nudge stays safely inside it by design and these
 * four cannot. sendAutomationMessage() therefore always goes through
 * wa.sendBusinessNotice (approved template if WA_TPL_* is configured,
 * otherwise best-effort free text) and falls back to SMS on failure, exactly
 * mirroring the fallback notification.service.js's notifyOrderPaid and
 * cart_nudge.js already use for WhatsApp customers.
 */
const logger = require('../utils/logger');
const lock = require('./worker.lock');
const { query } = require('../config/database');
const wa = require('./whatsapp.service');
const sms = require('./sms.service');
const { getAdapter, destOf } = require('./channel.adapter');
const { t, langOf } = require('../utils/i18n');

const AUTOMATION_DEFS = {
  reorder_reminder: {
    label: 'Reorder reminder',
    description: 'Nudge a repeat customer to order again a while after their last purchase. Good for food, groceries, water, gas, cosmetics — anything bought on a cycle.',
    defaultConfig: { delay_days: 14 }
  },
  win_back: {
    label: 'Win back inactive customers',
    description: "Reach out to customers who haven't ordered in a while.",
    defaultConfig: { inactive_days: 30 }
  },
  post_purchase_review: {
    label: 'Ask for a review',
    description: 'Ask how the order was a while after it was delivered.',
    defaultConfig: { delay_hours: 24 }
  },
  delivery_feedback: {
    label: 'Delivery feedback',
    description: 'Check in on the delivery experience shortly after an order arrives.',
    defaultConfig: { delay_hours: 2 }
  }
};

/** Merge a business's stored config over the template default — missing/new config keys never crash an old row. */
function resolveConfig(key, storedConfig) {
  return { ...AUTOMATION_DEFS[key].defaultConfig, ...(storedConfig || {}) };
}

/**
 * WhatsApp (template-or-fallback, then SMS if that still failed) for
 * WhatsApp customers; best-effort free text for Instagram/Messenger, which
 * have no equivalent template mechanism in this codebase yet.
 */
async function sendAutomationMessage({ customer, business, templateEnv, bodyParams, fallbackText, smsText }) {
  let result;
  if (!customer.channel || customer.channel === 'whatsapp') {
    result = await wa.sendBusinessNotice({
      to: destOf(customer), templateEnv, bodyParams, fallbackText,
      meta: { businessId: business.id, customerId: customer.id }
    });
  } else {
    result = await getAdapter(customer.channel).sendText(
      destOf(customer), fallbackText, { businessId: business.id, customerId: customer.id }
    );
  }
  if (result?.success === false && customer.channel === 'whatsapp' && customer.whatsapp_number && smsText) {
    result = await sms.sendSms(customer.whatsapp_number, smsText,
      { businessId: business.id, customerId: customer.id });
  }
  return result;
}

async function recordSend({ businessId, automationKey, customerId, orderId }) {
  await query(
    `INSERT INTO automation_sends (business_id, automation_key, customer_id, order_id) VALUES ($1,$2,$3,$4)`,
    [businessId, automationKey, customerId, orderId || null]
  );
}

/** Customers eligible for a customer-anchored automation (reorder_reminder/win_back). */
async function findEligibleCustomers(key, businessId, { anchorSql, days }) {
  const res = await query(
    `SELECT DISTINCT c.* FROM customers c
      WHERE c.business_id = $1
        AND c.opted_out = FALSE
        AND (${anchorSql})
        AND NOT EXISTS (
          SELECT 1 FROM automation_sends s
           WHERE s.automation_key = $2 AND s.customer_id = c.id
             AND s.sent_at > NOW() - ($3 || ' days')::interval
        )
      LIMIT 200`,
    [businessId, key, days]
  );
  return res.rows;
}

async function handleReorderReminder(business, config) {
  const days = Math.max(1, Number(config.delay_days) || 14);
  const customers = await findEligibleCustomers('reorder_reminder', business.id, {
    days,
    anchorSql: `EXISTS (
      SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.payment_status = 'paid'
        AND o.created_at <= NOW() - (${days} || ' days')::interval
    )`
  });
  let sent = 0;
  for (const customer of customers) {
    const lang = langOf(business);
    const result = await sendAutomationMessage({
      customer, business,
      templateEnv: 'WA_TPL_REORDER_REMINDER',
      bodyParams: [String(days)],
      fallbackText: t(lang, 'reorder_reminder', { shop: business.name, days }),
      smsText: t(lang, 'sms_reorder_reminder', { shop: business.name })
    });
    if (result?.success !== false) {
      await recordSend({ businessId: business.id, automationKey: 'reorder_reminder', customerId: customer.id });
      sent++;
    }
  }
  return sent;
}

async function handleWinBack(business, config) {
  const days = Math.max(1, Number(config.inactive_days) || 30);
  const customers = await findEligibleCustomers('win_back', business.id, {
    days,
    anchorSql: `c.total_orders > 0 AND COALESCE(c.last_seen_at, c.created_at) <= NOW() - (${days} || ' days')::interval`
  });
  let sent = 0;
  for (const customer of customers) {
    const lang = langOf(business);
    const result = await sendAutomationMessage({
      customer, business,
      templateEnv: 'WA_TPL_WIN_BACK',
      bodyParams: [String(days)],
      fallbackText: t(lang, 'win_back', { shop: business.name, days }),
      smsText: t(lang, 'sms_win_back', { shop: business.name })
    });
    if (result?.success !== false) {
      await recordSend({ businessId: business.id, automationKey: 'win_back', customerId: customer.id });
      sent++;
    }
  }
  return sent;
}

/** Delivered orders eligible for an order-anchored automation, not yet sent for this key. */
async function findEligibleDeliveredOrders(key, businessId, hours) {
  const res = await query(
    `SELECT o.*, c.id AS c_id, c.channel, c.channel_id, c.whatsapp_number, c.opted_out
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.business_id = $1
        AND o.status = 'delivered'
        AND EXISTS (
          SELECT 1 FROM order_status_history h
           WHERE h.order_id = o.id AND h.event = 'status:delivered'
             AND h.created_at <= NOW() - ($2 || ' hours')::interval
        )
        AND NOT EXISTS (
          SELECT 1 FROM automation_sends s
           WHERE s.automation_key = $3 AND s.order_id = o.id
        )
      LIMIT 200`,
    [businessId, hours, key]
  );
  return res.rows;
}

async function handlePostPurchaseReview(business, config) {
  const hours = Math.max(1, Number(config.delay_hours) || 24);
  const orders = await findEligibleDeliveredOrders('post_purchase_review', business.id, hours);
  let sent = 0;
  for (const order of orders) {
    // Order-anchored automations are transactional (about a specific
    // purchase they just made), unlike reorder_reminder/win_back — they
    // deliberately do NOT check opted_out, same precedent as the automatic
    // payment_failed_retry message.
    const customer = { id: order.c_id, channel: order.channel, channel_id: order.channel_id, whatsapp_number: order.whatsapp_number };
    const lang = langOf(business);
    const result = await sendAutomationMessage({
      customer, business,
      templateEnv: 'WA_TPL_POST_PURCHASE_REVIEW',
      bodyParams: [order.order_number],
      fallbackText: t(lang, 'post_purchase_review', { n: order.order_number, shop: business.name }),
      smsText: t(lang, 'sms_post_purchase_review', { shop: business.name, n: order.order_number })
    });
    if (result?.success !== false) {
      await recordSend({ businessId: business.id, automationKey: 'post_purchase_review', customerId: customer.id, orderId: order.id });
      sent++;
    }
  }
  return sent;
}

async function handleDeliveryFeedback(business, config) {
  const hours = Math.max(1, Number(config.delay_hours) || 2);
  const orders = await findEligibleDeliveredOrders('delivery_feedback', business.id, hours);
  let sent = 0;
  for (const order of orders) {
    const customer = { id: order.c_id, channel: order.channel, channel_id: order.channel_id, whatsapp_number: order.whatsapp_number };
    const lang = langOf(business);
    const result = await sendAutomationMessage({
      customer, business,
      templateEnv: 'WA_TPL_DELIVERY_FEEDBACK',
      bodyParams: [order.order_number],
      fallbackText: t(lang, 'delivery_feedback', { n: order.order_number }),
      smsText: t(lang, 'sms_delivery_feedback', { shop: business.name, n: order.order_number })
    });
    if (result?.success !== false) {
      await recordSend({ businessId: business.id, automationKey: 'delivery_feedback', customerId: customer.id, orderId: order.id });
      sent++;
    }
  }
  return sent;
}

const HANDLERS = {
  reorder_reminder: handleReorderReminder,
  win_back: handleWinBack,
  post_purchase_review: handlePostPurchaseReview,
  delivery_feedback: handleDeliveryFeedback
};

/**
 * Cron: run every enabled automation for every business that has it on.
 * Single-leader via worker_locks, same as every other scheduled job.
 */
async function runAutomationsJob() {
  await lock.withLock('automations_job', 600, async () => {
    const enabledRes = await query(
      `SELECT a.*, b.id AS biz_id, b.name, b.bot_language, b.status AS business_status
         FROM automations a
         JOIN businesses b ON b.id = a.business_id
        WHERE a.enabled = TRUE`
    );
    if (!enabledRes.rows.length) return;

    let totalSent = 0;
    for (const row of enabledRes.rows) {
      // Never message on behalf of a shop that can't take orders right now.
      if (['suspended', 'cancelled'].includes(row.business_status)) continue;
      const handler = HANDLERS[row.key];
      if (!handler) continue;
      const business = { id: row.biz_id, name: row.name, bot_language: row.bot_language };
      try {
        const sent = await handler(business, resolveConfig(row.key, row.config));
        totalSent += sent;
        if (sent) logger.info('[cron] automation %s sent %d for business %s', row.key, sent, business.id);
      } catch (err) {
        logger.warn('[cron] automation %s failed for business %s: %s', row.key, business.id, err.message);
      }
    }
    if (totalSent) logger.info('[cron] automations job done: %d message(s) sent', totalSent);
  });
}

/**
 * Back-in-stock: fired directly (not on the cron) the moment a product's
 * stock_qty/in_stock transitions from empty to available — see
 * product.routes.js's PATCH /:id. Notifies everyone still watching, then
 * clears their notified_at so a future restock-after-OOS cycle can watch
 * again is unaffected (watchProductForRestock resets it on re-opt-in, this
 * function only ever sets it).
 */
async function notifyProductRestocked(product) {
  const watchers = await query(
    `SELECT pw.id AS watcher_id, c.id, c.channel, c.channel_id, c.whatsapp_number
       FROM product_watchers pw
       JOIN customers c ON c.id = pw.customer_id
      WHERE pw.product_id = $1 AND pw.notified_at IS NULL
      LIMIT 500`,
    [product.id]
  );
  if (!watchers.rows.length) return 0;
  const bizRes = await query('SELECT * FROM businesses WHERE id = $1', [product.business_id]);
  const business = bizRes.rows[0];
  if (!business) return 0;

  let sent = 0;
  for (const row of watchers.rows) {
    const customer = { id: row.id, channel: row.channel, channel_id: row.channel_id, whatsapp_number: row.whatsapp_number };
    const lang = langOf(business);
    try {
      await sendAutomationMessage({
        customer, business,
        templateEnv: 'WA_TPL_BACK_IN_STOCK',
        bodyParams: [product.name],
        fallbackText: t(lang, 'back_in_stock', { name: product.name, shop: business.name }),
        smsText: t(lang, 'sms_back_in_stock', { shop: business.name, name: product.name })
      });
      await query('UPDATE product_watchers SET notified_at = NOW() WHERE id = $1', [row.watcher_id]);
      sent++;
    } catch (err) {
      logger.warn('back-in-stock notify failed for watcher %s: %s', row.watcher_id, err.message);
    }
  }
  return sent;
}

module.exports = {
  AUTOMATION_DEFS,
  resolveConfig,
  runAutomationsJob,
  notifyProductRestocked,
  // exported for tests
  handleReorderReminder,
  handleWinBack,
  handlePostPurchaseReview,
  handleDeliveryFeedback
};
