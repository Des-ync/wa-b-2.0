/**
 * Payment sweeper: reconciles orders stuck at payment_status='pending'.
 *
 * Why it exists: if a customer never approves the MoMo prompt (or abandons a
 * card link), no webhook ever arrives — the order would sit "pending" forever
 * and the customer's session silently expires. Every run this job:
 *
 *   1. Verifies each stale pending payment against Paystack directly.
 *      - success  → applies it through the normal (idempotent) paid path.
 *      - failed/abandoned → marks the order unpaid and offers the customer a
 *        retry button on the SAME order (no duplicate orders).
 *   2. Hard-expires payments still unresolved after HARD_EXPIRE_HOURS.
 *   3. Quietly cancels never-paid orders older than STALE_ORDER_HOURS so the
 *      merchant's dashboard isn't littered with abandoned carts.
 */
const logger = require('../utils/logger');
const { query } = require('../config/database');
const paystack = require('./paystack.service');
const mtnmomo = require('./mtnmomo.service');
const orderService = require('./order.service');
const subService = require('./subscription.service');
const webhookProcessor = require('./webhook.processor');
const conversation = require('./conversation.handler');
const { getAdapter, destOf } = require('./channel.adapter');
const lock = require('./worker.lock');

const PENDING_TTL_MINUTES = parseInt(process.env.PAYMENT_PENDING_TTL_MINUTES || '15', 10);
const HARD_EXPIRE_HOURS = parseInt(process.env.PAYMENT_HARD_EXPIRE_HOURS || '24', 10);
const STALE_ORDER_HOURS = parseInt(process.env.STALE_ORDER_HOURS || '48', 10);
// SaaS subscription billing (Paystack) has its own, slightly longer grace before
// we reconcile — a MoMo approval prompt can legitimately sit a few minutes.
const BILLING_PENDING_TTL_MINUTES = parseInt(process.env.BILLING_PENDING_TTL_MINUTES || '30', 10);

/**
 * Verify a stuck order's payment against whichever gateway actually holds it.
 * payment_attempts.gateway_ref is only ever set for MTN MoMo direct attempts
 * (Paystack's own reference doubles as its gateway reference — see
 * order.service.js#attachPaymentReference) — its presence IS the routing
 * signal. Paystack is now the sole active checkout gateway, so no NEW
 * attempt will ever have a gateway_ref again; this branch only still matters
 * for reconciling a residual in-flight MTN charge from before that switch.
 * Normalizes MTN's PENDING/SUCCESSFUL/FAILED vocabulary to the same
 * success/failed/pending shape verifyTransaction already returns, so the
 * rest of this file's reconciliation logic doesn't need to know which
 * gateway it's looking at.
 */
async function verifyOrderPayment(order, attempt) {
  if (attempt?.gateway_ref) {
    const s = await mtnmomo.getPaymentStatus(attempt.gateway_ref);
    if (!s.success) return { success: false, error: s.error };
    const STATUS_MAP = { SUCCESSFUL: 'success', FAILED: 'failed', PENDING: 'pending' };
    return {
      success: true,
      status: STATUS_MAP[s.status] || 'pending',
      amount_ghs: s.amountGhs,
      currency: s.currency,
      gateway_ref: s.financialTransactionId
    };
  }
  return paystack.verifyTransaction(order.payment_ref);
}

async function expirePendingPayment(order) {
  await orderService.markOrderFailed({ orderId: order.id, paymentRef: order.payment_ref, reason: 'timeout' });
  try {
    const customerRes = await query('SELECT * FROM customers WHERE id = $1', [order.customer_id]);
    const customer = customerRes.rows[0];
    if (customer) {
      // Route via the customer's channel: for Instagram rows whatsapp_number
      // holds the IG-scoped id, and a WhatsApp send to it would just fail.
      await getAdapter(customer.channel).sendButtons(destOf(customer),
        `⏰ We didn't receive payment for order *${order.order_number}*.\n\nYour order is still saved — want to try paying again?`,
        [
          { id: `retrypay_${order.id}`, title: 'Try again' },
          { id: `cancelord_${order.id}`, title: 'Cancel order' }
        ],
        { businessId: order.business_id, customerId: customer.id });
    }
  } catch (err) {
    logger.warn('[sweeper] retry notice failed for order %s: %s', order.order_number, err.message);
  }
}

/**
 * Reconcile SaaS subscription billing_transactions stuck at 'pending'. Only one
 * pending charge per subscription is allowed (to prevent double billing), so a
 * charge abandoned by the customer — or one left pending by a transient gateway
 * error / lost callback — would otherwise block the merchant from ever renewing.
 * We ask Paystack for the true state and resolve it: applied, failed, or (after
 * the hard-expiry window) force-failed to release the lock.
 */
async function reconcileStaleBilling() {
  const stale = await query(
    `SELECT * FROM billing_transactions
      WHERE status = 'pending'
        AND gateway = 'paystack'
        AND initiated_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY initiated_at ASC
      LIMIT 25`,
    [String(BILLING_PENDING_TTL_MINUTES)]
  );
  if (!stale.rows.length) return;
  logger.info('[sweeper] %d stale pending billing transaction(s) to reconcile', stale.rows.length);

  for (const tx of stale.rows) {
    try {
      const verified = await paystack.verifyTransaction(tx.reference);
      if (!verified.success) {
        logger.warn('[sweeper] billing status check failed ref=%s: %s', tx.reference, verified.error);
        continue; // Try again next run.
      }

      if (verified.status === 'success') {
        if (verified.currency && verified.currency !== 'GHS') {
          logger.error('[sweeper] billing %s completed in unexpected currency %s; failing',
            tx.reference, verified.currency);
          await subService.markPaymentFailed({ reference: tx.reference, errorPayload: { currency: verified.currency } });
          continue;
        }
        logger.info('[sweeper] billing %s actually paid — applying', tx.reference);
        await webhookProcessor.applyBillingSuccess({
          reference: tx.reference,
          transactionId: verified.gateway_ref,
          amount: verified.amount_ghs
        });
        continue;
      }

      if (['failed', 'abandoned', 'reversed'].includes(verified.status)) {
        await webhookProcessor.applyBillingFailure({
          reference: tx.reference,
          errorPayload: { status: verified.status },
          reason: verified.status
        });
        continue;
      }

      // Still in flight (pending/ongoing/queued). Give it until the hard-expiry
      // window, then stop waiting so the subscription isn't blocked forever.
      const ageHours = (Date.now() - new Date(tx.initiated_at).getTime()) / 3_600_000;
      if (ageHours >= HARD_EXPIRE_HOURS) {
        logger.warn('[sweeper] hard-failing billing %s after %dh pending', tx.reference, HARD_EXPIRE_HOURS);
        await subService.markPaymentFailed({ reference: tx.reference, errorPayload: { reason: 'hard_expired' } });
      }
    } catch (err) {
      logger.error('[sweeper] billing reconcile failed for ref=%s: %s', tx.reference, err.message);
    }
  }
}

async function runPaymentSweeper() {
  await lock.withLock('payment_sweeper', 240, async () => {
    const stale = await query(
      `SELECT * FROM orders
        WHERE payment_status = 'pending'
          AND updated_at < NOW() - ($1 || ' minutes')::interval
        ORDER BY updated_at ASC
        LIMIT 25`,
      [String(PENDING_TTL_MINUTES)]
    );
    if (stale.rows.length) {
      logger.info('[sweeper] %d stale pending payment(s) to reconcile', stale.rows.length);
    }

    for (const order of stale.rows) {
      try {
        if (!order.payment_ref) {
          await expirePendingPayment(order);
          continue;
        }

        const attempt = await orderService.getPaymentAttempt(order.payment_ref);
        const verification = await verifyOrderPayment(order, attempt);
        if (verification.success && verification.status === 'success') {
          // Same multi-currency guard as the live webhook path (processPaystack) —
          // an out-of-band currency here means our GHS amount assumption is wrong.
          if (verification.currency && verification.currency !== 'GHS') {
            logger.error('[sweeper] order %s verified paid in unexpected currency %s; skipping (needs manual review)',
              order.order_number, verification.currency);
            continue;
          }
          logger.info('[sweeper] order %s actually paid — applying', order.order_number);
          await conversation.handlePaymentSuccess({
            reference: order.payment_ref,
            gatewayRef: verification.gateway_ref,
            amount: verification.amount_ghs
          });
          continue;
        }
        if (verification.success && ['failed', 'abandoned', 'reversed'].includes(verification.status)) {
          await expirePendingPayment(order);
          continue;
        }

        // Verification unavailable (network/config) or still ongoing: give it
        // until the hard-expiry window, then stop waiting.
        const ageHours = (Date.now() - new Date(order.created_at).getTime()) / 3_600_000;
        if (ageHours >= HARD_EXPIRE_HOURS) {
          logger.warn('[sweeper] hard-expiring order %s after %dh pending', order.order_number, HARD_EXPIRE_HOURS);
          await expirePendingPayment(order);
        }
      } catch (err) {
        logger.error('[sweeper] reconcile failed for order %s: %s', order.order_number, err.message);
      }
    }

    // Abandoned carts: unpaid, never entered payment, untouched for days.
    try {
      const cancelled = await query(
        `UPDATE orders
            SET status = 'cancelled'
          WHERE status = 'pending'
            AND payment_status IN ('unpaid', 'failed')
            AND updated_at < NOW() - ($1 || ' hours')::interval
          RETURNING order_number`,
        [String(STALE_ORDER_HOURS)]
      );
      if (cancelled.rowCount) {
        logger.info('[sweeper] auto-cancelled %d abandoned order(s)', cancelled.rowCount);
      }
    } catch (err) {
      logger.error('[sweeper] abandoned-order cleanup failed: %s', err.message);
    }

    // Reconcile stuck SaaS subscription charges so a lost webhook / transient
    // gateway error can't block a merchant's renewals indefinitely.
    try {
      await reconcileStaleBilling();
    } catch (err) {
      logger.error('[sweeper] billing reconciliation failed: %s', err.message);
    }
  });
}

module.exports = { runPaymentSweeper, reconcileStaleBilling };
