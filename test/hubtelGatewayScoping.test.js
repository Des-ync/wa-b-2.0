const test = require('node:test');
const assert = require('node:assert/strict');

// subscription.service (and webhook.processor, which requires it) destructure
// { query, transaction } at require time, so install swappable indirections
// on the db module BEFORE requiring anything downstream — same pattern as
// test/order.service.test.js and test/webhookProcessor.paystackDispatch.test.js.
const db = require('../src/config/database');
let currentTransaction = async () => { throw new Error('no transaction handler installed for this test'); };
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.transaction = (...args) => currentTransaction(...args);
db.query = (...args) => currentQuery(...args);

function withTransaction(client, fn) {
  const original = currentTransaction;
  currentTransaction = async cb => cb(client);
  return Promise.resolve().then(fn).finally(() => { currentTransaction = original; });
}

const subService = require('../src/services/subscription.service');

/**
 * Fake transaction client for applySuccessfulPayment. The gateway-scoped
 * billing lookup is the SELECT ... FROM billing_transactions bt JOIN
 * subscriptions s ... query; `billingRow` is what it should return (null
 * simulates "no row matches THIS gateway", i.e. the reference exists but was
 * raised against a different gateway).
 */
function makeApplyClient(billingRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM billing_transactions bt') && sql.includes('JOIN subscriptions s')) {
        return billingRow ? { rows: [billingRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE billing_transactions')) {
        return { rows: [{ ...billingRow }], rowCount: 1 };
      }
      if (sql.includes('UPDATE subscriptions')) {
        return { rows: [{ id: billingRow.subscription_id, status: 'active' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE businesses')) {
        return { rows: [{ id: billingRow.sub_business_id, status: 'active' }], rowCount: 1 };
      }
      throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
    }
  };
}

/**
 * Fake transaction client for markPaymentFailed. Its gateway-scoped lookup is
 * the plain `SELECT id, status, subscription_id FROM billing_transactions
 * WHERE reference = $1 AND gateway = $2 FOR UPDATE` query.
 */
function makeMarkFailedClient(lookupRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM billing_transactions') && sql.includes('FOR UPDATE') && !sql.includes('JOIN')) {
        return lookupRow ? { rows: [lookupRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE billing_transactions')) {
        return { rows: [{ id: lookupRow.id, subscription_id: lookupRow.subscription_id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE subscriptions')) {
        return { rows: [{ id: lookupRow.subscription_id }], rowCount: 1 };
      }
      throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
    }
  };
}

const baseBillingRow = {
  id: 'bt-1',
  subscription_id: 'sub-1',
  reference: 'SUB-1',
  gateway: 'paystack',
  status: 'pending',
  amount_ghs: '50.00',
  sub_business_id: 'biz-1',
  plan_id: 'plan-1',
  billing_cycle: 'monthly',
  sub_period_end: null,
  plan_display_name: 'Pro',
  plan_price_ghs: '50.00'
};

test('applySuccessfulPayment: a hubtel-gateway callback cannot settle a row that is really paystack', async () => {
  // Simulate the real row belonging to 'paystack': a lookup scoped to
  // gateway='hubtel' finds nothing, proving the query is gateway-scoped
  // rather than reference-only.
  const client = makeApplyClient(null);
  await withTransaction(client, async () => {
    const result = await subService.applySuccessfulPayment({
      reference: 'SUB-1', transactionId: 'txn-1', amount: 50, gateway: 'hubtel'
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'unknown_reference');

    // Must not proceed to touch subscriptions/businesses at all.
    const writes = client.calls.filter(c => c.sql.trim().startsWith('UPDATE'));
    assert.equal(writes.length, 0);

    // The lookup itself must have been scoped by gateway.
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0].params, ['SUB-1', 'hubtel']);
  });
});

test('applySuccessfulPayment: the correct gateway (paystack) still applies normally (no regression)', async () => {
  const client = makeApplyClient({ ...baseBillingRow });
  await withTransaction(client, async () => {
    const result = await subService.applySuccessfulPayment({
      reference: 'SUB-1', transactionId: 'txn-1', amount: 50, gateway: 'paystack'
    });
    assert.equal(result.applied, true);
    assert.equal(result.planName, 'Pro');
    assert.ok(result.subscription);

    const billingUpdate = client.calls.find(c => c.sql.includes('UPDATE billing_transactions'));
    assert.ok(billingUpdate, 'expected billing_transactions to be marked success');
    const subUpdate = client.calls.find(c => c.sql.includes('UPDATE subscriptions'));
    assert.ok(subUpdate, 'expected the subscription to be extended');
    const bizUpdate = client.calls.find(c => c.sql.includes('UPDATE businesses'));
    assert.ok(bizUpdate, 'expected the business to be reactivated');
  });
});

test('markPaymentFailed: a hubtel-gateway callback cannot fail a row that is really paystack', async () => {
  const client = makeMarkFailedClient(null);
  await withTransaction(client, async () => {
    const result = await subService.markPaymentFailed({
      reference: 'SUB-1', errorPayload: { reason: 'declined' }, gateway: 'hubtel'
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'unknown_reference');

    const writes = client.calls.filter(c => c.sql.trim().startsWith('UPDATE'));
    assert.equal(writes.length, 0);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0].params, ['SUB-1', 'hubtel']);
  });
});

test('markPaymentFailed: the correct gateway (paystack) still fails the row normally (no regression)', async () => {
  const client = makeMarkFailedClient({ id: 'bt-1', status: 'pending', subscription_id: 'sub-1' });
  await withTransaction(client, async () => {
    const result = await subService.markPaymentFailed({
      reference: 'SUB-1', errorPayload: { reason: 'declined' }, gateway: 'paystack'
    });
    assert.equal(result.applied, true);
    const billingUpdate = client.calls.find(c => c.sql.includes('UPDATE billing_transactions'));
    assert.ok(billingUpdate);
    const subUpdate = client.calls.find(c => c.sql.includes('UPDATE subscriptions'));
    assert.ok(subUpdate);
  });
});

test('regression tripwire: both lookup queries filter by gateway, not just reference', async () => {
  const applyClient = makeApplyClient({ ...baseBillingRow });
  await withTransaction(applyClient, async () => {
    await subService.applySuccessfulPayment({ reference: 'SUB-1', amount: 50, gateway: 'paystack' });
  });
  assert.ok(applyClient.calls[0].sql.includes('gateway'),
    'applySuccessfulPayment lookup must filter by gateway');

  const failClient = makeMarkFailedClient({ id: 'bt-1', status: 'pending', subscription_id: 'sub-1' });
  await withTransaction(failClient, async () => {
    await subService.markPaymentFailed({ reference: 'SUB-1', gateway: 'paystack' });
  });
  assert.ok(failClient.calls[0].sql.includes('gateway'),
    'markPaymentFailed lookup must filter by gateway');
});

/* =================================================================
   Plumbing check: processHubtel must pass gateway:'hubtel' (not undefined,
   not 'paystack') into applySuccessfulPayment. Tested through
   webhook.processor.js, mocking hubtel.parseHubtelCallback and replacing
   subService.applySuccessfulPayment wholesale (same style as
   test/webhookProcessor.paystackDispatch.test.js) so this test proves only
   the argument plumbing, not the query behavior already covered above.
   ================================================================= */

const hubtel = require('../src/services/hubtel.service');
const webhookProcessor = require('../src/services/webhook.processor');
const processHubtel = webhookProcessor.PROCESSORS.hubtel;

test('processHubtel passes gateway:"hubtel" into applySuccessfulPayment', async () => {
  const originalParse = hubtel.parseHubtelCallback;
  const originalApply = subService.applySuccessfulPayment;
  const applyCalls = [];
  hubtel.parseHubtelCallback = () => ({
    reference: 'SUB-PLUMB-1', success: true, transactionId: 'txn-plumb', amount: 25
  });
  subService.applySuccessfulPayment = async (args) => {
    applyCalls.push(args);
    return { applied: false, reason: 'stubbed' };
  };

  try {
    await processHubtel({ some: 'raw-hubtel-payload' });
  } finally {
    hubtel.parseHubtelCallback = originalParse;
    subService.applySuccessfulPayment = originalApply;
  }

  assert.equal(applyCalls.length, 1);
  assert.equal(applyCalls[0].reference, 'SUB-PLUMB-1');
  assert.equal(applyCalls[0].gateway, 'hubtel');
  assert.notEqual(applyCalls[0].gateway, 'paystack');
  assert.notEqual(applyCalls[0].gateway, undefined);
});
