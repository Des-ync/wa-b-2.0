const test = require('node:test');
const assert = require('node:assert/strict');

// Same pattern as webhookProcessor.paystackDispatch.test.js: webhook.processor
// (and everything it pulls in) destructures { query } at require time, so the
// db indirection must be installed BEFORE requiring anything downstream.
const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const conversation = require('../src/services/conversation.handler');
let successCalls = [];
let failureCalls = [];
conversation.handlePaymentSuccess = async (args) => { successCalls.push(args); };
conversation.handlePaymentFailure = async (args) => { failureCalls.push(args); };

const mtnmomo = require('../src/services/mtnmomo.service');
let paymentStatusReturn = null;
let transferStatusReturn = null;
mtnmomo.getPaymentStatus = async () => paymentStatusReturn;
mtnmomo.getTransferStatus = async () => transferStatusReturn;

const orderService = require('../src/services/order.service');
let attemptReturn = null;
orderService.getPaymentAttemptByGatewayRef = async () => attemptReturn;

const webhookProcessor = require('../src/services/webhook.processor');
const processMtnMomo = webhookProcessor.PROCESSORS.mtn_momo;
const processMtnMomoDisbursement = webhookProcessor.PROCESSORS.mtn_momo_disbursement;

test.beforeEach(() => {
  successCalls = [];
  failureCalls = [];
  paymentStatusReturn = null;
  transferStatusReturn = null;
  attemptReturn = null;
  currentQuery = async () => ({ rows: [], rowCount: 0 });
});

test('processMtnMomo applies success from the RE-POLLED status, never from the callback body', async () => {
  paymentStatusReturn = { success: true, status: 'SUCCESSFUL', amountGhs: 50, currency: 'GHS', financialTransactionId: 'FT-1' };
  attemptReturn = { reference: 'ORD-ABC-1', order_id: 'ord-1', gateway_ref: 'momo-ref-1' };

  // The callback payload itself claims nothing about status — only carries
  // the referenceId, exactly what payment.routes.js's callback route enqueues.
  await processMtnMomo({ referenceId: 'momo-ref-1' });

  assert.equal(successCalls.length, 1);
  assert.equal(successCalls[0].reference, 'ORD-ABC-1');
  assert.equal(successCalls[0].amount, 50);
  assert.equal(successCalls[0].gatewayRef, 'FT-1');
  assert.equal(failureCalls.length, 0);
});

test('processMtnMomo applies failure for a FAILED polled status', async () => {
  paymentStatusReturn = { success: true, status: 'FAILED', reason: { code: 'PAYER_NOT_FOUND' } };
  attemptReturn = { reference: 'ORD-ABC-2', gateway_ref: 'momo-ref-2' };

  await processMtnMomo({ referenceId: 'momo-ref-2' });

  assert.equal(failureCalls.length, 1);
  assert.equal(failureCalls[0].reference, 'ORD-ABC-2');
  // MTN's reason is a { code, message } object, not a bare string — this
  // must read status.reason.code, not stringify the whole object.
  assert.equal(failureCalls[0].reason, 'wrong_number');
  assert.equal(successCalls.length, 0);
});

test('processMtnMomo normalizes an unrecognized MTN reason code to "declined" instead of throwing', async () => {
  paymentStatusReturn = { success: true, status: 'FAILED', reason: { code: 'SOME_NEW_MTN_CODE' } };
  attemptReturn = { reference: 'ORD-ABC-5', gateway_ref: 'momo-ref-5' };

  await processMtnMomo({ referenceId: 'momo-ref-5' });

  assert.equal(failureCalls.length, 1);
  assert.equal(failureCalls[0].reason, 'declined');
});

test('processMtnMomo applies neither outcome while still PENDING', async () => {
  paymentStatusReturn = { success: true, status: 'PENDING' };
  attemptReturn = { reference: 'ORD-ABC-3', gateway_ref: 'momo-ref-3' };

  await processMtnMomo({ referenceId: 'momo-ref-3' });

  assert.equal(successCalls.length, 0);
  assert.equal(failureCalls.length, 0);
});

test('processMtnMomo drops a payment settled in an unexpected currency instead of crediting it', async () => {
  paymentStatusReturn = { success: true, status: 'SUCCESSFUL', amountGhs: 50, currency: 'USD' };
  attemptReturn = { reference: 'ORD-ABC-4', gateway_ref: 'momo-ref-4' };

  await processMtnMomo({ referenceId: 'momo-ref-4' });

  assert.equal(successCalls.length, 0);
});

test('processMtnMomo ignores a gateway_ref with no matching payment_attempts row', async () => {
  paymentStatusReturn = { success: true, status: 'SUCCESSFUL', amountGhs: 50, currency: 'GHS' };
  attemptReturn = null;

  await processMtnMomo({ referenceId: 'unknown-ref' });

  assert.equal(successCalls.length, 0);
  assert.equal(failureCalls.length, 0);
});

test('processMtnMomo throws (so the queue retries) when the MTN status check itself fails', async () => {
  paymentStatusReturn = { success: false, error: 'network timeout' };

  await assert.rejects(() => processMtnMomo({ referenceId: 'momo-ref-5' }));
  assert.equal(successCalls.length, 0);
});

test('processMtnMomo drops a malformed callback with no referenceId', async () => {
  await processMtnMomo({});
  assert.equal(successCalls.length, 0);
  assert.equal(failureCalls.length, 0);
});

test('processMtnMomoDisbursement settles a pending payout row on SUCCESSFUL status', async () => {
  transferStatusReturn = { success: true, status: 'SUCCESSFUL' };
  let updateParams = null;
  currentQuery = async (sql, params) => {
    if (sql.includes("status = 'settled'")) { updateParams = params; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };

  await processMtnMomoDisbursement({ referenceId: 'payout-ref-1' });
  assert.deepEqual(updateParams, ['payout-ref-1']);
});

test('processMtnMomoDisbursement fails a pending payout row on FAILED status', async () => {
  transferStatusReturn = { success: true, status: 'FAILED' };
  let updateParams = null;
  currentQuery = async (sql, params) => {
    if (sql.includes("status = 'failed'")) { updateParams = params; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };

  await processMtnMomoDisbursement({ referenceId: 'payout-ref-2' });
  assert.deepEqual(updateParams, ['payout-ref-2']);
});

test('processMtnMomoDisbursement throws when the MTN transfer status check itself fails', async () => {
  transferStatusReturn = { success: false, error: 'timeout' };
  await assert.rejects(() => processMtnMomoDisbursement({ referenceId: 'payout-ref-3' }));
});

test('processMtnMomoDisbursement drops a malformed callback with no referenceId', async () => {
  await processMtnMomoDisbursement({});
});
