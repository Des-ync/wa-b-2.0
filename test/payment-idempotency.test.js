/**
 * Integration tests for the money-critical idempotency paths.
 *
 * These need a throwaway Postgres database. They are SKIPPED unless
 * TEST_DATABASE_URL is set (never point this at production):
 *
 *   createdb wa_b_test
 *   TEST_DATABASE_URL=postgres://localhost/wa_b_test npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_URL && 'TEST_DATABASE_URL not set';

if (TEST_URL) {
  // Must be set before any src module require()s the pool.
  process.env.DATABASE_URL = TEST_URL;
}

test('payment idempotency (integration)', { skip }, async t => {
  const { query, close } = require('../src/config/database');
  const { migrate } = require('../src/models/migrate');
  const orderService = require('../src/services/order.service');
  const subService = require('../src/services/subscription.service');

  await migrate();

  // Minimal fixtures
  const biz = (await query(
    `INSERT INTO businesses (name, whatsapp_number, status)
     VALUES ('Test Biz', '+233240000001', 'active') RETURNING *`
  )).rows[0];
  const customer = (await query(
    `INSERT INTO customers (business_id, whatsapp_number)
     VALUES ($1, '+233240000002') RETURNING *`, [biz.id]
  )).rows[0];
  const plan = (await query(
    `INSERT INTO plans (name, display_name, price_ghs)
     VALUES ('test_plan', 'Test Plan', 100.00)
     ON CONFLICT (name) DO UPDATE SET price_ghs = 100.00
     RETURNING *`
  )).rows[0];

  await t.test('markOrderPaid applies once, then reports alreadyPaid', async () => {
    const order = await orderService.createOrder({
      businessId: biz.id,
      customerId: customer.id,
      cart: [{ product_id: null, name: 'Thing', price_ghs: 50, quantity: 2 }],
      deliveryAddress: 'Test address',
      deliveryFee: 0
    });
    await orderService.attachPaymentReference(order.id, 'REF-TEST-1', 'momo');

    const first = await orderService.markOrderPaid({ orderId: order.id, paymentRef: 'REF-TEST-1', amount: 100 });
    assert.equal(first.alreadyPaid, undefined);
    assert.equal(first.order.payment_status, 'paid');

    const second = await orderService.markOrderPaid({ orderId: order.id, paymentRef: 'REF-TEST-1', amount: 100 });
    assert.equal(second.alreadyPaid, true, 'replayed webhook must be a no-op');

    const spent = (await query('SELECT total_spent_ghs FROM customers WHERE id = $1', [customer.id])).rows[0];
    assert.equal(Number(spent.total_spent_ghs), 100, 'total_spent incremented exactly once');
  });

  await t.test('markOrderPaid rejects underpayment', async () => {
    const order = await orderService.createOrder({
      businessId: biz.id,
      customerId: customer.id,
      cart: [{ product_id: null, name: 'Thing', price_ghs: 80, quantity: 1 }],
      deliveryAddress: 'Test address',
      deliveryFee: 0
    });
    await orderService.attachPaymentReference(order.id, 'REF-TEST-2', 'momo');
    const res = await orderService.markOrderPaid({ orderId: order.id, paymentRef: 'REF-TEST-2', amount: 10 });
    assert.equal(res.mismatch, true);
    const after = await orderService.getOrderById(order.id);
    assert.notEqual(after.payment_status, 'paid');
  });

  await t.test('applySuccessfulPayment extends once; replay refused', async () => {
    const sub = (await query(
      `INSERT INTO subscriptions (business_id, plan_id, status)
       VALUES ($1, $2, 'pending') RETURNING *`, [biz.id, plan.id]
    )).rows[0];
    const ref = 'BILL-TEST-1';
    await query(
      `INSERT INTO billing_transactions (business_id, subscription_id, amount_ghs, gateway, reference, status)
       VALUES ($1, $2, 100.00, 'pawapay', $3, 'pending')`, [biz.id, sub.id, ref]
    );

    const first = await subService.applySuccessfulPayment({ reference: ref, transactionId: 'tx1', amount: 100 });
    assert.equal(first.applied, true);
    assert.equal(first.subscription.status, 'active');

    const replay = await subService.applySuccessfulPayment({ reference: ref, transactionId: 'tx1', amount: 100 });
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, 'already_applied');
  });

  await t.test('applySuccessfulPayment rejects amount mismatch and marks failed', async () => {
    const sub = (await query(
      `INSERT INTO subscriptions (business_id, plan_id, status)
       VALUES ($1, $2, 'pending') RETURNING *`, [biz.id, plan.id]
    )).rows[0];
    const ref = 'BILL-TEST-2';
    await query(
      `INSERT INTO billing_transactions (business_id, subscription_id, amount_ghs, gateway, reference, status)
       VALUES ($1, $2, 100.00, 'pawapay', $3, 'pending')`, [biz.id, sub.id, ref]
    );

    const res = await subService.applySuccessfulPayment({ reference: ref, transactionId: 'tx2', amount: 0.01 });
    assert.equal(res.applied, false);
    assert.equal(res.reason, 'amount_mismatch');
    const row = (await query('SELECT status FROM billing_transactions WHERE reference = $1', [ref])).rows[0];
    assert.equal(row.status, 'failed');
  });

  await t.test('markPaymentFailed refuses to fail an already-successful charge', async () => {
    const res = await subService.markPaymentFailed({ reference: 'BILL-TEST-1', errorPayload: { fake: true } });
    assert.equal(res.applied, false);
    assert.equal(res.reason, 'already_succeeded');
  });

  // Cleanup so reruns start clean.
  await query('DELETE FROM billing_transactions WHERE business_id = $1', [biz.id]);
  await query('DELETE FROM subscriptions WHERE business_id = $1', [biz.id]);
  await query('DELETE FROM orders WHERE business_id = $1', [biz.id]);
  await query('DELETE FROM customers WHERE business_id = $1', [biz.id]);
  await query('DELETE FROM businesses WHERE id = $1', [biz.id]);
  await close();
});
