const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const paystack = require('../services/paystack.service');
const hubtel = require('../services/hubtel.service');
const queue = require('../services/webhook.queue');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Paystack webhook: HMAC-SHA512 over the raw body. Mounted with express.raw()
 * in server.js so req.body is a Buffer here.
 *
 * Strategy: verify signature, persist to webhook_events (idempotent on event id),
 * acknowledge 200 OK. A worker drains the queue durably — a crash after the 200
 * cannot lose the event.
 */
router.post('/paystack/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body; // Buffer

  let valid = false;
  try {
    valid = paystack.verifyPaystackWebhook(rawBody, signature);
  } catch (err) {
    logger.warn('Paystack signature verify threw: %s', err.message);
  }

  if (!valid) {
    logger.warn('Paystack webhook signature invalid');
    return res.status(401).send('invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Paystack webhook: invalid JSON body: %s', err.message);
    return res.status(400).send('invalid json');
  }

  // Paystack events expose a unique `id` per event; reference also unique per charge.
  const externalId = event.id ? String(event.id)
    : `${event.event}:${event.data?.reference || event.data?.id || ''}`;

  try {
    const { duplicate } = await queue.enqueue({
      source: 'paystack',
      externalId,
      payload: event,
      signatureValid: true
    });
    if (duplicate) {
      logger.info('Paystack webhook duplicate ignored: %s', externalId);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error('Paystack enqueue failed: %s', err.message);
    res.status(500).send('enqueue failed');
  }
});

/**
 * Browser callback after a card payment. Used as `callback_url` in initialize.
 * Verify on the server and enqueue a synthetic event so the worker handles it.
 *
 * Rate-limited (unlike the webhook POSTs, which must never be): each hit
 * triggers an outbound Paystack verify call, so an attacker spraying random
 * references would otherwise burn our API quota.
 */
const callbackLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
router.get('/paystack/callback', callbackLimiter, async (req, res) => {
  const reference = req.query.reference || req.query.trxref;
  if (!reference) return res.status(400).send('Missing reference');

  let verification;
  try {
    verification = await paystack.verifyTransaction(reference);
  } catch (err) {
    logger.error('Paystack callback: verifyTransaction threw for ref=%s: %s', reference, err.message);
    return res.redirect(303, '/wa-b/payment-pending.html');
  }

  if (verification.success && verification.status === 'success') {
    try {
      await queue.enqueue({
        source: 'paystack',
        externalId: `callback:${reference}`,
        payload: {
          event: 'charge.success',
          data: {
            reference,
            id: verification.gateway_ref,
            status: 'success',
            amount: Math.round((verification.amount_ghs || 0) * 100)
          }
        },
        signatureValid: true
      });
    } catch (err) {
      logger.error('Paystack callback enqueue failed: %s', err.message);
    }
    return res.redirect(303, '/wa-b/payment-success.html');
  }
  return res.redirect(303, '/wa-b/payment-pending.html');
});

/**
 * pawaPay deposit callback (SaaS subscription billing). Configure
 * {PUBLIC_BASE_URL}/api/payments/pawapay/callback in the pawaPay dashboard.
 *
 * The callback body is treated purely as a TRIGGER: the queue processor
 * re-verifies the deposit via GET /v2/deposits/{depositId} against pawaPay
 * before applying any billing state, so a forged callback cannot fake a
 * payment — at worst it makes us look up a deposit that doesn't exist.
 */
router.post('/pawapay/callback', async (req, res) => {
  const payload = req.body || {};
  const depositId = payload.depositId;

  if (typeof depositId !== 'string' || !UUID_RE.test(depositId)) {
    logger.warn('pawaPay callback missing/invalid depositId; dropping');
    return res.status(400).send('invalid depositId');
  }

  try {
    const { duplicate } = await queue.enqueue({
      source: 'pawapay',
      externalId: `deposit:${depositId}:${payload.status || 'x'}`,
      payload,
      signatureValid: true
    });
    if (duplicate) {
      logger.info('pawaPay callback duplicate ignored: %s', depositId);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error('pawaPay enqueue failed: %s', err.message);
    res.status(500).send('enqueue failed');
  }
});

/**
 * Hubtel callback: signed with HMAC-SHA256 (`x-hubtel-signature`) when configured.
 * Kept for legacy in-flight transactions initiated before the pawaPay switch.
 * Mounted with express.raw() so we can verify the raw body.
 */
router.post('/hubtel/callback', async (req, res) => {
  const signature = req.headers['x-hubtel-signature'] || req.headers['hubtel-signature'];
  const rawBody = req.body;

  let valid = false;
  try {
    valid = hubtel.verifyHubtelWebhook(rawBody, signature);
  } catch (err) {
    logger.warn('Hubtel signature verify threw: %s', err.message);
  }

  if (!valid) {
    logger.warn('Hubtel webhook signature invalid');
    return res.status(401).send('invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Hubtel webhook: invalid JSON body: %s', err.message);
    return res.status(400).send('invalid json');
  }

  const parsed = hubtel.parseHubtelCallback(event);
  const externalId = parsed.transactionId
    ? `tx:${parsed.transactionId}`
    : (parsed.reference ? `ref:${parsed.reference}` : null);

  if (!externalId) {
    logger.warn('Hubtel callback missing reference and transactionId; dropping');
    return res.status(400).send('missing identifiers');
  }

  try {
    const { duplicate } = await queue.enqueue({
      source: 'hubtel',
      externalId,
      payload: event,
      signatureValid: true
    });
    if (duplicate) {
      logger.info('Hubtel webhook duplicate ignored: %s', externalId);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error('Hubtel enqueue failed: %s', err.message);
    res.status(500).send('enqueue failed');
  }
});

module.exports = router;
