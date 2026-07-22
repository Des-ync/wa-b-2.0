const test = require('node:test');
const assert = require('node:assert/strict');

// webhook.processor (and the services it pulls in) destructure { query } at
// require time, so install a swappable indirection on the db module BEFORE
// requiring anything downstream — same pattern as order.lifecycle.test.js.
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

const conversation = require('../src/services/conversation.handler');
let handlePaymentSuccessCalls = [];
let handlePaymentFailureCalls = [];
conversation.handlePaymentSuccess = async (args) => { handlePaymentSuccessCalls.push(args); };
conversation.handlePaymentFailure = async (args) => { handlePaymentFailureCalls.push(args); };

const subService = require('../src/services/subscription.service');
let applySuccessfulPaymentReturn = null;
let markPaymentFailedReturn = null;
subService.applySuccessfulPayment = async () => applySuccessfulPaymentReturn;
subService.markPaymentFailed = async () => markPaymentFailedReturn;

const notification = require('../src/services/notification.service');
let notifyRenewedCalls = [];
let notifyFailedCalls = [];
notification.notifySubscriptionRenewed = async (args) => { notifyRenewedCalls.push(args); };
notification.notifySubscriptionFailed = async (args) => { notifyFailedCalls.push(args); };

const webhookProcessor = require('../src/services/webhook.processor');
const processPaystack = webhookProcessor.PROCESSORS.paystack;

test.beforeEach(() => {
  handlePaymentSuccessCalls = [];
  handlePaymentFailureCalls = [];
  notifyRenewedCalls = [];
  notifyFailedCalls = [];
  applySuccessfulPaymentReturn = null;
  markPaymentFailedReturn = null;
});

test('processPaystack routes an ORD- reference to the order payment flow, not billing', async () => {
  await processPaystack({
    event: 'charge.success',
    data: { reference: 'ORD-ABC-123', id: 999, status: 'success', amount: 5000, currency: 'GHS' }
  });
  assert.equal(handlePaymentSuccessCalls.length, 1);
  assert.equal(handlePaymentSuccessCalls[0].reference, 'ORD-ABC-123');
  assert.equal(handlePaymentSuccessCalls[0].amount, 50);
});

test('processPaystack routes a SUB- reference to subscription billing, not the order flow', async () => {
  applySuccessfulPaymentReturn = {
    applied: true,
    subscription: { business_id: 'biz-1' },
    billing: { amount_ghs: '99.00' },
    planName: 'Pro',
    periodEnd: new Date('2026-08-01')
  };
  await withQuery([
    ['SELECT * FROM businesses WHERE id', () => ({ rows: [{ id: 'biz-1', name: 'Kwame Shop' }] })]
  ], () => processPaystack({
    event: 'charge.success',
    data: { reference: 'SUB-XYZ-999', id: 111, status: 'success', amount: 9900, currency: 'GHS' }
  }));

  assert.equal(handlePaymentSuccessCalls.length, 0, 'must NOT be treated as an order payment');
  assert.equal(notifyRenewedCalls.length, 1);
  assert.equal(notifyRenewedCalls[0].amountGhs, 99);
});

test('processPaystack routes a SUB- failure to billing failure, not order failure', async () => {
  markPaymentFailedReturn = { applied: true };
  await withQuery([
    ['FROM billing_transactions bt', () => ({
      rows: [{
        biz_id: 'biz-1', whatsapp_number: '+233241234567', business_name: 'Kwame Shop',
        plan_display_name: 'Pro', amount_ghs: '99.00'
      }]
    })]
  ], () => processPaystack({
    event: 'charge.failed',
    data: { reference: 'SUB-FAIL-1', status: 'failed' }
  }));

  assert.equal(handlePaymentFailureCalls.length, 0, 'must NOT be treated as an order payment failure');
  assert.equal(notifyFailedCalls.length, 1);
  assert.equal(notifyFailedCalls[0].business.id, 'biz-1');
});

test('processPaystack routes an ORD- failure to the order flow with a normalized reason', async () => {
  await processPaystack({
    event: 'charge.failed',
    data: { reference: 'ORD-FAIL-1', status: 'failed', gateway_response: 'Insufficient Funds' }
  });

  assert.equal(handlePaymentFailureCalls.length, 1);
  assert.equal(handlePaymentFailureCalls[0].reference, 'ORD-FAIL-1');
  assert.equal(handlePaymentFailureCalls[0].reason, 'insufficient_funds');
});

test('processPaystack drops a charge in an unexpected (non-GHS) currency instead of crediting it', async () => {
  await processPaystack({
    event: 'charge.success',
    data: { reference: 'ORD-WRONG-CCY', id: 1, status: 'success', amount: 5000, currency: 'NGN' }
  });
  assert.equal(handlePaymentSuccessCalls.length, 0);
});

test('processPaystack settles a pending payout on transfer.success', async () => {
  let updateParams = null;
  await withQuery([
    ['UPDATE payouts SET status', (params) => { updateParams = params; return { rowCount: 1, rows: [{ id: 'payout-1' }] }; }]
  ], () => processPaystack({
    event: 'transfer.success',
    data: { reference: 'PAYOUT-1', transfer_code: 'TRF_1', status: 'success' }
  }));
  assert.deepEqual(updateParams, ['PAYOUT-1', 'settled', 'TRF_1']);
  // Must not be misrouted into the customer/billing charge flows.
  assert.equal(handlePaymentSuccessCalls.length, 0);
});

test('processPaystack fails a pending payout on transfer.failed', async () => {
  let updateParams = null;
  await withQuery([
    ['UPDATE payouts SET status', (params) => { updateParams = params; return { rowCount: 1, rows: [{ id: 'payout-1' }] }; }]
  ], () => processPaystack({
    event: 'transfer.failed',
    data: { reference: 'PAYOUT-2', transfer_code: 'TRF_2', status: 'failed' }
  }));
  assert.deepEqual(updateParams, ['PAYOUT-2', 'failed', 'TRF_2']);
  assert.equal(handlePaymentFailureCalls.length, 0);
});

test('processPaystack fails a pending payout on transfer.reversed', async () => {
  let updateParams = null;
  await withQuery([
    ['UPDATE payouts SET status', (params) => { updateParams = params; return { rowCount: 1, rows: [{ id: 'payout-1' }] }; }]
  ], () => processPaystack({
    event: 'transfer.reversed',
    data: { reference: 'PAYOUT-3', transfer_code: 'TRF_3', status: 'reversed' }
  }));
  assert.equal(updateParams[1], 'failed');
});

test('processPaystack transfer event with no matching pending payout does not throw (already settled or unknown ref)', async () => {
  await withQuery([
    ['UPDATE payouts SET status', () => ({ rowCount: 0, rows: [] })]
  ], () => processPaystack({
    event: 'transfer.success',
    data: { reference: 'PAYOUT-UNKNOWN', transfer_code: 'TRF_9' }
  }));
});
