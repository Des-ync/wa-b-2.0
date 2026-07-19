const test = require('node:test');
const assert = require('node:assert/strict');

// order.service destructures { transaction } at require time, so install a
// swappable indirection on the db module BEFORE requiring the service.
const db = require('../src/config/database');
let currentTransaction = db.transaction;
db.transaction = (...args) => currentTransaction(...args);

/**
 * Fake transaction client: routes queries by SQL substring so each test can
 * script the order row the FOR UPDATE lock returns and capture every write.
 */
function makeClient(orderRow, { knownAttemptRefs = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE')) {
        return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
      }
      if (sql.includes('FROM payment_attempts')) {
        const hit = knownAttemptRefs.includes(params[0]);
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('UPDATE orders')) {
        const updated = {
          ...orderRow,
          payment_status: 'paid',
          status: orderRow.status === 'pending' ? 'confirmed' : orderRow.status,
          payment_ref: params[1] || orderRow.payment_ref
        };
        return { rows: [updated], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected query in test: ' + sql.slice(0, 60));
    }
  };
}

function withTransaction(client, fn) {
  const original = currentTransaction;
  currentTransaction = async cb => cb(client);
  return Promise.resolve()
    .then(fn)
    .finally(() => { currentTransaction = original; });
}

const orderService = require('../src/services/order.service');

const baseOrder = {
  id: 'ord-1',
  customer_id: 'cust-1',
  order_number: 'ORD-2026-1234',
  status: 'pending',
  payment_status: 'pending',
  payment_ref: 'REF-A',
  total_ghs: '50.00'
};

test('markOrderPaid: happy path pays once and bumps the customer', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.ok(result.order);
    assert.equal(result.alreadyPaid, undefined);
    assert.equal(result.mismatch, undefined);
    assert.equal(result.order.payment_status, 'paid');
    assert.equal(result.order.status, 'confirmed');
    const customerBumps = client.calls.filter(c => c.sql.includes('UPDATE customers'));
    assert.equal(customerBumps.length, 1);
  });
});

test('markOrderPaid: double webhook is an idempotent no-op', async () => {
  const client = makeClient({ ...baseOrder, payment_status: 'paid' });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.equal(result.alreadyPaid, true);
    // No writes: neither orders nor customers were updated a second time.
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: refunded orders are never re-credited', async () => {
  const client = makeClient({ ...baseOrder, payment_status: 'refunded' });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', amount: 50 });
    assert.equal(result.refunded, true);
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: short payment leaves the order unpaid', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 49.5
    });
    assert.equal(result.mismatch, true);
    assert.equal(result.reason, 'amount_mismatch');
    assert.equal(result.expected, 50);
    assert.equal(result.received, 49.5);
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: an unknown payment_ref cannot pay this order', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-OTHER', amount: 50
    });
    assert.equal(result.mismatch, true);
    assert.equal(result.reason, 'payment_ref_conflict');
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: an EARLIER attempt ref for the same order still pays it', async () => {
  // Customer retried (current ref REF-B) then approved the ORIGINAL prompt
  // (REF-A, recorded in payment_attempts). That money must credit the order.
  const client = makeClient(
    { ...baseOrder, payment_ref: 'REF-B' },
    { knownAttemptRefs: ['REF-A'] }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.equal(result.mismatch, undefined);
    assert.ok(result.order);
    assert.equal(result.order.payment_status, 'paid');
    // The ref that actually paid becomes the order's payment_ref.
    assert.equal(result.order.payment_ref, 'REF-A');
  });
});

test('markOrderPaid: missing order returns null', async () => {
  const client = makeClient(null);
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'nope', amount: 10 });
    assert.equal(result, null);
  });
});

test('computeTotals sums cart with quantities and delivery fee', () => {
  const totals = orderService.computeTotals(
    [
      { price_ghs: 10.5, quantity: 2 },
      { price_ghs: 5, quantity: 1 }
    ],
    15
  );
  assert.equal(totals.subtotal_ghs, 26);
  assert.equal(totals.delivery_fee, 15);
  assert.equal(totals.total_ghs, 41);
});
