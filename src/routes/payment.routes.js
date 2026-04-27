const express = require('express');
const logger = require('../utils/logger');
const paystack = require('../services/paystack.service');
const hubtel = require('../services/hubtel.service');
const subService = require('../services/subscription.service');
const notification = require('../services/notification.service');
const conversation = require('../services/conversation.handler');
const { query } = require('../config/database');

const router = express.Router();

/**
 * Paystack webhook: x-paystack-signature is HMAC-SHA512 over the raw body.
 * IMPORTANT: this route is mounted with express.raw() in server.js — req.body is a Buffer here.
 */
router.post('/paystack/webhook', (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body; // Buffer
  const valid = paystack.verifyPaystackWebhook(rawBody, signature);

  // Always respond 200 fast — never let Paystack retry due to slow processing.
  res.status(200).send('OK');

  if (!valid) {
    logger.warn('Paystack webhook signature invalid');
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Paystack webhook: invalid JSON body: %s', err.message);
    return;
  }

  setImmediate(async () => {
    try {
      const eventType = event.event;
      const data = event.data || {};
      const reference = data.reference;
      const gatewayRef = data.id ? String(data.id) : null;
      const amount = (data.amount || 0) / 100;

      logger.info('Paystack event=%s ref=%s status=%s', eventType, reference, data.status);

      if (eventType === 'charge.success' && data.status === 'success' && reference) {
        await conversation.handlePaymentSuccess({ reference, gatewayRef, amount });
      } else if (eventType === 'charge.failed' || data.status === 'failed') {
        if (reference) await conversation.handlePaymentFailure({ reference });
      } else {
        logger.debug('Paystack event ignored: %s', eventType);
      }
    } catch (err) {
      logger.error('Paystack webhook handler error: %s', err.message, { stack: err.stack });
    }
  });
});

/**
 * Paystack browser callback after card payment. Used as `callback_url` in initialize.
 * Verify on the server, then redirect / acknowledge.
 */
router.get('/paystack/callback', async (req, res) => {
  const reference = req.query.reference || req.query.trxref;
  if (!reference) return res.status(400).send('Missing reference');

  const verification = await paystack.verifyTransaction(reference);
  if (verification.success && verification.status === 'success') {
    setImmediate(() => {
      conversation.handlePaymentSuccess({
        reference,
        gatewayRef: verification.gateway_ref,
        amount: verification.amount_ghs
      }).catch(err => logger.error('callback handlePaymentSuccess: %s', err.message));
    });
    return res.status(200).send('Payment received. You can return to WhatsApp now.');
  }
  return res.status(200).send('Payment is still processing. We will update you on WhatsApp.');
});

/**
 * Hubtel callback: signed with HMAC-SHA256 (`x-hubtel-signature`) when configured.
 * Mounted with express.raw() so we can verify the raw body.
 */
router.post('/hubtel/callback', (req, res) => {
  const signature = req.headers['x-hubtel-signature'] || req.headers['hubtel-signature'];
  const rawBody = req.body;
  const valid = hubtel.verifyHubtelWebhook(rawBody, signature);

  res.status(200).send('OK');

  if (!valid) {
    logger.warn('Hubtel webhook signature invalid');
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Hubtel webhook: invalid JSON body: %s', err.message);
    return;
  }

  setImmediate(async () => {
    try {
      const parsed = hubtel.parseHubtelCallback(event);
      logger.info('Hubtel callback ref=%s success=%s status=%s', parsed.reference, parsed.success, parsed.status);

      if (!parsed.reference) {
        logger.warn('Hubtel callback missing ClientReference');
        return;
      }

      if (parsed.success) {
        const result = await subService.applySuccessfulPayment({
          reference: parsed.reference,
          transactionId: parsed.transactionId,
          amount: parsed.amount
        });
        if (result.applied) {
          const businessRes = await query('SELECT * FROM businesses WHERE id = $1',
            [result.subscription.business_id]);
          const business = businessRes.rows[0];
          await notification.notifySubscriptionRenewed({
            business,
            planName: result.planName,
            amountGhs: parsed.amount || result.billing.amount_ghs,
            periodEnd: result.periodEnd
          });
        } else if (result.reason !== 'already_applied') {
          logger.warn('applySuccessfulPayment skipped: %s', result.reason);
        }
      } else {
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
          errorPayload: event
        });
        if (billing) {
          await notification.notifySubscriptionFailed({
            business: { id: billing.biz_id, whatsapp_number: billing.whatsapp_number, name: billing.business_name },
            planName: billing.plan_display_name,
            amountGhs: billing.amount_ghs,
            reason: parsed.status || 'declined'
          });
        }
      }
    } catch (err) {
      logger.error('Hubtel webhook handler error: %s', err.message, { stack: err.stack });
    }
  });
});

module.exports = router;
