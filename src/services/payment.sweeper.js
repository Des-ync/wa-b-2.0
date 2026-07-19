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
const orderService = require('./order.service');
const conversation = require('./conversation.handler');
const { getAdapter, destOf } = require('./channel.adapter');
const lock = require('./worker.lock');

const PENDING_TTL_MINUTES = parseInt(process.env.PAYMENT_PENDING_TTL_MINUTES || '15', 10);
const HARD_EXPIRE_HOURS = parseInt(process.env.PAYMENT_HARD_EXPIRE_HOURS || '24', 10);
const STALE_ORDER_HOURS = parseInt(process.env.STALE_ORDER_HOURS || '48', 10);

async function expirePendingPayment(order) {
  await orderService.markOrderFailed({ orderId: order.id, paymentRef: order.payment_ref });
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

        const verification = await paystack.verifyTransaction(order.payment_ref);
        if (verification.success && verification.status === 'success') {
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
            AND payment_status = 'unpaid'
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
  });
}

module.exports = { runPaymentSweeper };
