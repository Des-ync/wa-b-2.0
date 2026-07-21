const logger = require('../utils/logger');
const queue = require('./webhook.queue');
const conversation = require('./conversation.handler');
const subService = require('./subscription.service');
const notification = require('./notification.service');
const hubtel = require('./hubtel.service');
const { query } = require('../config/database');

/**
 * Process a WhatsApp event payload pulled from the queue.
 * Status updates (sent/delivered/read/failed) update message_log; inbound
 * messages run the conversation engine. Idempotency: handleInbound hits the
 * unique index on message_log.wa_message_id and silently absorbs duplicates.
 */
async function processWhatsApp(payload) {
  await conversation.handleStatuses(payload);
  await conversation.handleInbound(payload);
}

/**
 * Process an Instagram DM event pulled from the queue. The payload is
 * normalized inside conversation.extractInbound(payload, 'instagram') into the
 * SAME shape WhatsApp inbounds take, then runs the same state machine —
 * there is no parallel Instagram flow. Idempotency: same unique index on
 * message_log (IG mids and WA mids never collide).
 */
async function processInstagram(payload) {
  await conversation.handleInbound(payload, 'instagram');
}

/**
 * Process a Messenger event pulled from the queue — same normalize-then-run
 * pattern as Instagram, feeding the same conversation state machine.
 */
async function processMessenger(payload) {
  await conversation.handleInbound(payload, 'messenger');
}

/**
 * Paystack now serves two distinct flows through the same webhook: customer
 * order payments (references generated with generateReference('ORD') in
 * conversation.handler.js) and SaaS subscription billing (references
 * generated with generateReference('SUB') in subscription.service.js,
 * replacing the old pawaPay integration). The 'SUB-' prefix is how we tell
 * them apart and route to the right handler.
 */
async function processPaystack(payload) {
  const eventType = payload?.event;
  const data = payload?.data || {};
  const reference = data.reference;
  const gatewayRef = data.id ? String(data.id) : null;
  const amount = (data.amount || 0) / 100;

  if (!reference) {
    logger.warn('Paystack event has no reference; dropping: %s', eventType);
    return;
  }

  const isBilling = reference.startsWith('SUB-');

  if (eventType === 'charge.success' && data.status === 'success') {
    // Paystack accounts can be multi-currency. `amount` is a bare minor-unit
    // integer with no currency baked in, so a 1000 NGN charge would otherwise
    // be credited as GH₵10.00. Only trust GHS charges.
    if (data.currency && data.currency !== 'GHS') {
      logger.error('Paystack charge %s completed in unexpected currency %s; dropping',
        reference, data.currency);
      return;
    }
    if (isBilling) {
      await applyBillingSuccess({ reference, transactionId: gatewayRef, amount });
    } else {
      await conversation.handlePaymentSuccess({ reference, gatewayRef, amount });
    }
    return;
  }
  if (eventType === 'charge.failed' || data.status === 'failed') {
    if (isBilling) {
      await applyBillingFailure({ reference, errorPayload: payload, reason: data.gateway_response || 'declined' });
    } else {
      await conversation.handlePaymentFailure({ reference });
    }
    return;
  }
  logger.debug('Paystack event ignored: %s status=%s', eventType, data.status);
}

/**
 * Shared SaaS-billing success path: extend the subscription and notify.
 */
async function applyBillingSuccess({ reference, transactionId, amount }) {
  const result = await subService.applySuccessfulPayment({ reference, transactionId, amount });
  if (result.applied) {
    const businessRes = await query(
      'SELECT * FROM businesses WHERE id = $1',
      [result.subscription.business_id]
    );
    const business = businessRes.rows[0];
    await notification.notifySubscriptionRenewed({
      business,
      planName: result.planName,
      amountGhs: amount || result.billing.amount_ghs,
      periodEnd: result.periodEnd
    });
  }
  return result;
}

/**
 * Shared SaaS-billing failure path: mark failed and notify.
 */
async function applyBillingFailure({ reference, errorPayload, reason }) {
  const billingRes = await query(
    `SELECT bt.*, b.id AS biz_id, b.whatsapp_number, b.name AS business_name,
            p.display_name AS plan_display_name
       FROM billing_transactions bt
       JOIN subscriptions s ON s.id = bt.subscription_id
       JOIN businesses b   ON b.id = bt.business_id
       JOIN plans p        ON p.id = COALESCE(bt.plan_id, s.pending_plan_id, s.plan_id)
      WHERE bt.reference = $1`,
    [reference]
  );
  const billing = billingRes.rows[0];
  const result = await subService.markPaymentFailed({ reference, errorPayload });
  if (billing && result.applied) {
    await notification.notifySubscriptionFailed({
      business: {
        id: billing.biz_id,
        whatsapp_number: billing.whatsapp_number,
        name: billing.business_name
      },
      planName: billing.plan_display_name,
      amountGhs: billing.amount_ghs,
      reason: reason || 'declined'
    });
  }
  return result;
}

async function processHubtel(payload) {
  const parsed = hubtel.parseHubtelCallback(payload);
  if (!parsed.reference) {
    logger.warn('Hubtel callback missing reference; dropping');
    return;
  }

  if (parsed.success) {
    await applyBillingSuccess({
      reference: parsed.reference,
      transactionId: parsed.transactionId,
      amount: parsed.amount
    });
    return;
  }

  await applyBillingFailure({
    reference: parsed.reference,
    errorPayload: payload,
    reason: parsed.status
  });
}

const PROCESSORS = {
  whatsapp:  processWhatsApp,
  instagram: processInstagram,
  messenger: processMessenger,
  paystack:  processPaystack,
  hubtel:    processHubtel
};

let _running = false;
let _timer = null;
let _lastReclaimAt = 0;

// Reclaiming stuck events only matters after a worker has actually been dead
// longer than LOCK_TTL (60s). Running the two full-table sweeps on every 1.5s
// tick was pure write contention for no benefit — a ~60s cooldown covers it.
const RECLAIM_COOLDOWN_MS = 60_000;

/**
 * Drain the queue, then schedule the next poll. Single-flight: never two drains
 * concurrently in the same process.
 */
async function tick() {
  if (_running) return;
  _running = true;
  try {
    // Free up events stuck in 'processing' from a prior crash — on a cooldown,
    // not every tick.
    const now = Date.now();
    if (now - _lastReclaimAt >= RECLAIM_COOLDOWN_MS) {
      _lastReclaimAt = now;
      await queue.reclaimStuck().catch(err => logger.warn('reclaimStuck failed: %s', err.message));
    }
    const processed = await queue.drain(PROCESSORS, { maxBatch: 50 });
    if (processed > 0) logger.debug('Drained %d webhook event(s)', processed);
  } catch (err) {
    logger.error('Webhook drain tick failed: %s', err.message, { stack: err.stack });
  } finally {
    _running = false;
  }
}

/**
 * Start the in-process webhook processor. Polls every `intervalMs` ms.
 * Returns a stop() function.
 */
function start({ intervalMs = 1500 } = {}) {
  if (_timer) return () => stop();
  logger.info('Starting webhook processor (interval=%dms)', intervalMs);
  _timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  // Immediate first run.
  setImmediate(() => { tick().catch(() => {}); });
  return stop;
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Webhook processor stopped');
  }
}

/** True while a drain tick is mid-flight — lets a graceful shutdown wait it out. */
function isRunning() {
  return _running;
}

module.exports = { start, stop, tick, isRunning, applyBillingSuccess, applyBillingFailure, PROCESSORS };
