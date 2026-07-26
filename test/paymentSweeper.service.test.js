const test = require('node:test');
const assert = require('node:assert/strict');

// payment.sweeper.js (and the services it pulls in) destructure { query } at
// require time, so install a swappable indirection on the db module BEFORE
// requiring anything downstream — same pattern as
// webhookProcessor.paystackDispatch.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

function withQuery(handlers, fn) {
  const original = currentQuery;
  currentQuery = async (sql, params) => {
    for (const [match, respond] of handlers) {
      if (sql.includes(match)) return respond(params);
    }
    throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
  };
  return Promise.resolve().then(fn).finally(() => { currentQuery = original; });
}

const paystack = require('../src/services/paystack.service');
let verifyTransactionImpl = async () => { throw new Error('no verifyTransaction handler installed'); };
paystack.verifyTransaction = (...args) => verifyTransactionImpl(...args);

const webhookProcessor = require('../src/services/webhook.processor');
let applyBillingSuccessCalls = [];
let applyBillingFailureCalls = [];
webhookProcessor.applyBillingSuccess = async (args) => { applyBillingSuccessCalls.push(args); };
webhookProcessor.applyBillingFailure = async (args) => { applyBillingFailureCalls.push(args); };

const subService = require('../src/services/subscription.service');
let markPaymentFailedCalls = [];
subService.markPaymentFailed = async (args) => { markPaymentFailedCalls.push(args); };

const conversation = require('../src/services/conversation.handler');
let handlePaymentSuccessCalls = [];
conversation.handlePaymentSuccess = async (args) => { handlePaymentSuccessCalls.push(args); };

const orderService = require('../src/services/order.service');
let getPaymentAttemptImpl = async () => null;
let markOrderFailedCalls = [];
orderService.getPaymentAttempt = (...args) => getPaymentAttemptImpl(...args);
orderService.markOrderFailed = async (args) => { markOrderFailedCalls.push(args); };

const { reconcileStaleBilling, runPaymentSweeper } = require('../src/services/payment.sweeper');
const workerLock = require('../src/services/worker.lock');

test.beforeEach(() => {
  applyBillingSuccessCalls = [];
  applyBillingFailureCalls = [];
  markPaymentFailedCalls = [];
  handlePaymentSuccessCalls = [];
  markOrderFailedCalls = [];
  verifyTransactionImpl = async () => { throw new Error('no verifyTransaction handler installed'); };
  getPaymentAttemptImpl = async () => null;
});

function billingRow(overrides = {}) {
  return {
    reference: 'SUB-1',
    status: 'pending',
    gateway: 'paystack',
    initiated_at: new Date(Date.now() - 60 * 60 * 1000), // 1h ago by default
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// reconcileStaleBilling
// ---------------------------------------------------------------------------

test('reconcileStaleBilling: verified success in GHS credits the subscription with the paystack gateway tag', async () => {
  const row = billingRow({ reference: 'SUB-OK-1' });
  verifyTransactionImpl = async (reference) => {
    assert.equal(reference, 'SUB-OK-1');
    return { success: true, status: 'success', currency: 'GHS', amount_ghs: 99, gateway_ref: 'PSK-123' };
  };

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [row] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 1);
  assert.deepEqual(applyBillingSuccessCalls[0], {
    reference: 'SUB-OK-1',
    transactionId: 'PSK-123',
    amount: 99,
    gateway: 'paystack'
  });
  assert.equal(applyBillingFailureCalls.length, 0);
  assert.equal(markPaymentFailedCalls.length, 0);
});

test('reconcileStaleBilling: verified success in a non-GHS currency fails it instead of crediting (currency-mismatch guard)', async () => {
  const row = billingRow({ reference: 'SUB-CCY-1' });
  verifyTransactionImpl = async () => ({ success: true, status: 'success', currency: 'NGN', amount_ghs: 99, gateway_ref: 'PSK-999' });

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [row] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 0, 'must NOT credit a currency-mismatched charge');
  assert.equal(markPaymentFailedCalls.length, 1);
  assert.equal(markPaymentFailedCalls[0].reference, 'SUB-CCY-1');
  assert.equal(markPaymentFailedCalls[0].gateway, 'paystack');
  assert.equal(markPaymentFailedCalls[0].errorPayload.currency, 'NGN');
});

test('reconcileStaleBilling: a definitively failed/abandoned/reversed gateway status fails the billing transaction', async () => {
  for (const status of ['failed', 'abandoned', 'reversed']) {
    applyBillingFailureCalls = [];
    const row = billingRow({ reference: `SUB-${status.toUpperCase()}` });
    verifyTransactionImpl = async () => ({ success: true, status });

    await withQuery([
      ['FROM billing_transactions', () => ({ rows: [row] })]
    ], () => reconcileStaleBilling());

    assert.equal(applyBillingFailureCalls.length, 1, `expected applyBillingFailure to run for status=${status}`);
    assert.equal(applyBillingFailureCalls[0].reference, row.reference);
    assert.equal(applyBillingFailureCalls[0].reason, status);
    assert.equal(applyBillingFailureCalls[0].gateway, 'paystack');
    assert.equal(applyBillingSuccessCalls.length, 0);
  }
});

test('reconcileStaleBilling: still-pending row NOT yet past the hard-expire window is left untouched', async () => {
  const row = billingRow({ reference: 'SUB-PENDING-YOUNG', initiated_at: new Date(Date.now() - 60 * 60 * 1000) }); // 1h old, well under HARD_EXPIRE_HOURS default (24h)
  verifyTransactionImpl = async () => ({ success: true, status: 'pending' });

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [row] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 0);
  assert.equal(applyBillingFailureCalls.length, 0);
  assert.equal(markPaymentFailedCalls.length, 0, 'a young pending charge must be left for the next run');
});

test('reconcileStaleBilling: still-pending row PAST the hard-expire window is force-failed to release the lock', async () => {
  const row = billingRow({ reference: 'SUB-PENDING-OLD', initiated_at: new Date(Date.now() - 25 * 60 * 60 * 1000) }); // 25h old, past default 24h HARD_EXPIRE_HOURS
  verifyTransactionImpl = async () => ({ success: true, status: 'pending' });

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [row] })]
  ], () => reconcileStaleBilling());

  assert.equal(markPaymentFailedCalls.length, 1);
  assert.equal(markPaymentFailedCalls[0].reference, 'SUB-PENDING-OLD');
  assert.equal(markPaymentFailedCalls[0].gateway, 'paystack');
  assert.equal(markPaymentFailedCalls[0].errorPayload.reason, 'hard_expired');
  assert.equal(applyBillingSuccessCalls.length, 0);
  assert.equal(applyBillingFailureCalls.length, 0);
});

test('reconcileStaleBilling: a verifyTransaction error for one row does not stop the sweep from processing subsequent rows', async () => {
  const rowBad = billingRow({ reference: 'SUB-ERR-1' });
  const rowGood = billingRow({ reference: 'SUB-GOOD-2' });

  verifyTransactionImpl = async (reference) => {
    if (reference === 'SUB-ERR-1') throw new Error('network blip talking to Paystack');
    return { success: true, status: 'success', currency: 'GHS', amount_ghs: 50, gateway_ref: 'PSK-2' };
  };

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [rowBad, rowGood] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 1, 'the second, healthy row must still be processed');
  assert.equal(applyBillingSuccessCalls[0].reference, 'SUB-GOOD-2');
  assert.equal(applyBillingFailureCalls.length, 0);
  assert.equal(markPaymentFailedCalls.length, 0);
});

test('reconcileStaleBilling: a verifyTransaction soft-failure (success:false) for one row does not stop the sweep either', async () => {
  const rowBad = billingRow({ reference: 'SUB-SOFTFAIL-1' });
  const rowGood = billingRow({ reference: 'SUB-GOOD-3' });

  verifyTransactionImpl = async (reference) => {
    if (reference === 'SUB-SOFTFAIL-1') return { success: false, error: 'timeout' };
    return { success: true, status: 'success', currency: 'GHS', amount_ghs: 25, gateway_ref: 'PSK-3' };
  };

  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [rowBad, rowGood] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 1);
  assert.equal(applyBillingSuccessCalls[0].reference, 'SUB-GOOD-3');
});

test('reconcileStaleBilling: no stale rows is a no-op', async () => {
  await withQuery([
    ['FROM billing_transactions', () => ({ rows: [] })]
  ], () => reconcileStaleBilling());

  assert.equal(applyBillingSuccessCalls.length, 0);
  assert.equal(applyBillingFailureCalls.length, 0);
  assert.equal(markPaymentFailedCalls.length, 0);
});

// ---------------------------------------------------------------------------
// runPaymentSweeper (order-payment sweep) — happy path + one edge case.
// Wrapped in worker.lock.withLock, which itself round-trips through db.query
// (INSERT ... ON CONFLICT / UPDATE against worker_locks), so route those too.
// ---------------------------------------------------------------------------

function lockHandlers() {
  return [
    ['INSERT INTO worker_locks', () => ({ rows: [], rowCount: 1 })],
    // acquire() only counts the lock as taken if locked_by === this process's
    // WORKER_ID, so the stub must echo that back, not an arbitrary string.
    ['UPDATE worker_locks', () => ({ rows: [{ locked_by: workerLock.WORKER_ID }], rowCount: 1 })],
    ['DELETE FROM worker_locks', () => ({ rows: [], rowCount: 1 })]
  ];
}

test('runPaymentSweeper: a stale order verified paid by Paystack is applied through handlePaymentSuccess', async () => {
  const order = {
    id: 'order-1',
    order_number: 'ORD-1001',
    payment_ref: 'ORD-1001-ref',
    updated_at: new Date(Date.now() - 60 * 60 * 1000),
    created_at: new Date(Date.now() - 60 * 60 * 1000)
  };
  getPaymentAttemptImpl = async () => null; // no gateway_ref => routes to Paystack verification
  verifyTransactionImpl = async (reference) => {
    assert.equal(reference, 'ORD-1001-ref');
    return { success: true, status: 'success', currency: 'GHS', amount_ghs: 40, gateway_ref: 'PSK-ORD-1' };
  };

  await withQuery([
    ['FROM orders', () => ({ rows: [order], rowCount: 1 })],
    ['UPDATE orders', () => ({ rows: [], rowCount: 0 })],
    ...lockHandlers()
  ], () => runPaymentSweeper());

  assert.equal(handlePaymentSuccessCalls.length, 1);
  assert.equal(handlePaymentSuccessCalls[0].reference, 'ORD-1001-ref');
  assert.equal(handlePaymentSuccessCalls[0].amount, 40);
  assert.equal(markOrderFailedCalls.length, 0);
});

test('runPaymentSweeper: order verification errors for one order do not stop the sweep from reconciling the next one', async () => {
  const orderBad = {
    id: 'order-bad',
    order_number: 'ORD-BAD',
    payment_ref: 'ORD-BAD-ref',
    updated_at: new Date(Date.now() - 60 * 60 * 1000),
    created_at: new Date(Date.now() - 60 * 60 * 1000)
  };
  const orderGood = {
    id: 'order-good',
    order_number: 'ORD-GOOD',
    payment_ref: 'ORD-GOOD-ref',
    updated_at: new Date(Date.now() - 60 * 60 * 1000),
    created_at: new Date(Date.now() - 60 * 60 * 1000)
  };
  getPaymentAttemptImpl = async (ref) => {
    if (ref === 'ORD-BAD-ref') throw new Error('lookup blew up');
    return null;
  };
  verifyTransactionImpl = async () => ({ success: true, status: 'success', currency: 'GHS', amount_ghs: 10, gateway_ref: 'PSK-GOOD' });

  let ordersSelectCalls = 0;
  await withQuery([
    ['SELECT * FROM orders', () => {
      ordersSelectCalls += 1;
      return { rows: [orderBad, orderGood], rowCount: 2 };
    }],
    ['UPDATE orders', () => ({ rows: [], rowCount: 0 })],
    ...lockHandlers()
  ], () => runPaymentSweeper());

  assert.equal(ordersSelectCalls, 1);
  assert.equal(handlePaymentSuccessCalls.length, 1, 'the second, healthy order must still be reconciled');
  assert.equal(handlePaymentSuccessCalls[0].reference, 'ORD-GOOD-ref');
});
