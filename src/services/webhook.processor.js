const logger = require('../utils/logger');
const queue = require('./webhook.queue');
const conversation = require('./conversation.handler');
const subService = require('./subscription.service');
const notification = require('./notification.service');
const hubtel = require('./hubtel.service');
const { query } = require('../config/database');

/**
 * Process a WhatsApp event payload pulled from the queue.
 * Idempotency: handleInbound itself will hit the unique index on
 * message_log.wa_message_id and silently absorb duplicates.
 */
async function processWhatsApp(payload) {
  await conversation.handleInbound(payload);
}

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

  if (eventType === 'charge.success' && data.status === 'success') {
    await conversation.handlePaymentSuccess({ reference, gatewayRef, amount });
    return;
  }
  if (eventType === 'charge.failed' || data.status === 'failed') {
    await conversation.handlePaymentFailure({ reference });
    return;
  }
  logger.debug('Paystack event ignored: %s status=%s', eventType, data.status);
}

async function processHubtel(payload) {
  const parsed = hubtel.parseHubtelCallback(payload);
  if (!parsed.reference) {
    logger.warn('Hubtel callback missing reference; dropping');
    return;
  }

  if (parsed.success) {
    const result = await subService.applySuccessfulPayment({
      reference: parsed.reference,
      transactionId: parsed.transactionId,
      amount: parsed.amount
    });
    if (result.applied) {
      const businessRes = await query(
        'SELECT * FROM businesses WHERE id = $1',
        [result.subscription.business_id]
      );
      const business = businessRes.rows[0];
      await notification.notifySubscriptionRenewed({
        business,
        planName: result.planName,
        amountGhs: parsed.amount || result.billing.amount_ghs,
        periodEnd: result.periodEnd
      });
    }
    return;
  }

  // Failure path
  const billingRes = await query(
    `SELECT bt.*, b.id AS biz_id, b.whatsapp_number, b.name AS business_name,
            p.display_name AS plan_display_name
       FROM billing_transactions bt
       JOIN subscriptions s ON s.id = bt.subscription_id
       JOIN businesses b   ON b.id = bt.business_id
       JOIN plans p        ON p.id = s.plan_id
      WHERE bt.reference = $1`,
    [parsed.reference]
  );
  const billing = billingRes.rows[0];
  await subService.markPaymentFailed({
    reference: parsed.reference,
    errorPayload: payload
  });
  if (billing) {
    await notification.notifySubscriptionFailed({
      business: {
        id: billing.biz_id,
        whatsapp_number: billing.whatsapp_number,
        name: billing.business_name
      },
      planName: billing.plan_display_name,
      amountGhs: billing.amount_ghs,
      reason: parsed.status || 'declined'
    });
  }
}

const PROCESSORS = {
  whatsapp: processWhatsApp,
  paystack: processPaystack,
  hubtel:   processHubtel
};

let _running = false;
let _timer = null;

/**
 * Drain the queue, then schedule the next poll. Single-flight: never two drains
 * concurrently in the same process.
 */
async function tick() {
  if (_running) return;
  _running = true;
  try {
    // Free up events stuck in 'processing' from a prior crash.
    await queue.reclaimStuck().catch(err => logger.warn('reclaimStuck failed: %s', err.message));
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

module.exports = { start, stop, tick, PROCESSORS };
