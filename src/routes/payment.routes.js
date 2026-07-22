const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const paystack = require('../services/paystack.service');
const hubtel = require('../services/hubtel.service');
const queue = require('../services/webhook.queue');

const router = express.Router();

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
      signatureValid: true,
      signatureHeader: signature
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

const MOMO_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Separate instances (not one shared limiter) so a burst of Collections
// callbacks can never eat into the Disbursements callback budget, or vice
// versa, when both arrive from the same MTN egress IP.
const mtnCollectionCallbackLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const mtnDisbursementCallbackLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * MTN MoMo Collections callback — DORMANT. Paystack is now the sole active
 * gateway for customer checkout (all networks); nothing initiates a new
 * MTN-direct charge anymore, so no new X-Callback-Url pointing here will be
 * issued going forward. This route stays mounted purely to receive/verify
 * any residual in-flight MTN charge from before that switch, same reasoning
 * as the dormant Hubtel route below.
 *
 * Unlike Paystack/Hubtel, MTN's callbacks are NOT cryptographically signed —
 * so this route trusts NOTHING from the body. The path segment (our own
 * generated X-Reference-Id, embedded in the X-Callback-Url we gave MTN) is
 * the only thing used to identify the transaction; the worker re-verifies
 * the real status via getPaymentStatus before applying any state change.
 * This route is purely a "something changed, go check" doorbell — a forged
 * POST here is harmless, at worst it triggers one extra (free) status-check
 * call to MTN for a bogus reference.
 */
router.post('/mtnmomo/callback/:reference', mtnCollectionCallbackLimiter, async (req, res) => {
  const referenceId = req.params.reference;
  if (!MOMO_REF_RE.test(referenceId)) {
    return res.status(400).send('invalid reference');
  }
  try {
    const { duplicate } = await queue.enqueue({
      source: 'mtn_momo',
      externalId: referenceId,
      payload: { referenceId },
      signatureValid: true
    });
    if (duplicate) {
      logger.info('MTN MoMo callback duplicate ignored: %s', referenceId);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error('MTN MoMo enqueue failed: %s', err.message);
    res.status(500).send('enqueue failed');
  }
});

/**
 * MTN MoMo Disbursements (merchant payout) callback — DORMANT. Automated
 * merchant payouts now go through Paystack Transfers (see
 * accounting.routes.js POST /payouts/auto and the transfer.* handling in
 * webhook.processor.js); this route stays mounted only to receive/verify any
 * residual in-flight MTN payout from before that switch. Same doorbell-only
 * pattern as above, re-verified via getTransferStatus downstream.
 */
router.post('/mtnmomo/disbursement-callback/:reference', mtnDisbursementCallbackLimiter, async (req, res) => {
  const referenceId = req.params.reference;
  if (!MOMO_REF_RE.test(referenceId)) {
    return res.status(400).send('invalid reference');
  }
  try {
    const { duplicate } = await queue.enqueue({
      source: 'mtn_momo_disbursement',
      externalId: referenceId,
      payload: { referenceId },
      signatureValid: true
    });
    if (duplicate) {
      logger.info('MTN MoMo disbursement callback duplicate ignored: %s', referenceId);
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error('MTN MoMo disbursement enqueue failed: %s', err.message);
    res.status(500).send('enqueue failed');
  }
});

/**
 * Hubtel callback: signed with HMAC-SHA256 (`x-hubtel-signature`) when configured.
 *
 * Legacy fallback only — Paystack is the sole active gateway for both customer
 * checkout and SaaS subscription billing. Hubtel is never used to initiate a
 * new charge; this route stays mounted purely to receive/verify any residual
 * in-flight Hubtel callbacks from before the Paystack switch. Not wired back
 * into any active flow — kept dormant intentionally, to be reconsidered later.
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
      signatureValid: true,
      signatureHeader: signature
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
