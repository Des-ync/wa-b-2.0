const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Per-attempt outcome tracking. Before this, payment_attempts recorded only
 * that a reference had been ISSUED — never how it resolved. The gateway's
 * failure reason reached the customer's WhatsApp message and then existed
 * nowhere else, so a merchant looking at an order with three attempts could
 * not tell which one bounced or why.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
let currentTransaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });
db.query = (...a) => currentQuery(...a);
db.transaction = (...a) => currentTransaction(...a);

const orderService = require('../src/services/order.service');

const failedOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', order_number: 'ORD-1',
  status: 'pending', payment_status: 'failed', payment_ref: 'REF-A', total_ghs: '45.00',
  items: []
};

test('markOrderFailed stamps the attempt with both the raw code and the category', async () => {
  const writes = [];
  currentQuery = async (sql, params) => {
    writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('UPDATE orders')) return { rows: [failedOrder], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

  await orderService.markOrderFailed({
    orderId: 'ord-1',
    paymentRef: 'REF-A',
    reason: 'insufficient_funds',
    failureCode: 'Insufficient Funds'
  });

  const attempt = writes.find(w => w.sql.startsWith('UPDATE payment_attempts'));
  assert.ok(attempt, 'the attempt row was never stamped');
  assert.deepEqual(attempt.params, ['REF-A', 'ord-1', 'insufficient_funds', 'Insufficient Funds']);
  // Scoped to the order as well as the reference: a reference belonging to a
  // different order must never be markable from here.
  assert.match(attempt.sql, /WHERE reference = \$1 AND order_id = \$2/);
  // Only a still-open attempt may be resolved — a late duplicate callback
  // must not overwrite an outcome that is already recorded.
  assert.match(attempt.sql, /status = 'pending'/);
});

test('markOrderFailed on an already-paid order touches no attempt row', async () => {
  const writes = [];
  currentQuery = async (sql) => {
    writes.push(sql.replace(/\s+/g, ' ').trim());
    // The UPDATE's own guard (payment_status NOT IN ('paid','refunded'))
    // matched nothing.
    if (sql.includes('UPDATE orders')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  };

  const result = await orderService.markOrderFailed({
    orderId: 'ord-1', paymentRef: 'REF-A', reason: 'timeout', failureCode: 'TIMEOUT'
  });

  assert.equal(result, null);
  assert.ok(!writes.some(s => s.startsWith('UPDATE payment_attempts')),
    'a failure callback arriving after payment must not mark the attempt failed');
});

test('markOrderPaid settles the paying reference and retires its siblings', async () => {
  const writes = [];
  const client = {
    query: async (sql, params) => {
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ ...failedOrder, payment_status: 'pending' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE orders')) {
        return { rows: [{ ...failedOrder, payment_status: 'paid', status: 'confirmed' }], rowCount: 1 };
      }
      if (sql.includes('SELECT loyalty_enabled')) return { rows: [{ loyalty_enabled: false }], rowCount: 1 };
      if (sql.includes('UPDATE customers')) return { rows: [{ id: 'cust-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  currentTransaction = async (cb) => cb(client);

  await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 45 });

  const attempt = writes.find(w => w.sql.startsWith('UPDATE payment_attempts'));
  assert.ok(attempt, 'attempts were never settled');
  assert.deepEqual(attempt.params, ['ord-1', 'REF-A']);
  // The paying reference succeeds; anything else still open is retired, not
  // left dangling as 'pending' forever.
  assert.match(attempt.sql, /WHEN reference = \$2 THEN 'success' ELSE 'failed'/);
  assert.match(attempt.sql, /'superseded'/);
});

test('a cash sale with no reference settles no attempt at all', async () => {
  const writes = [];
  const client = {
    query: async (sql) => {
      writes.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ ...failedOrder, payment_status: 'pending', payment_ref: null }], rowCount: 1 };
      }
      if (sql.includes('UPDATE orders')) {
        return { rows: [{ ...failedOrder, payment_ref: null, payment_status: 'paid' }], rowCount: 1 };
      }
      if (sql.includes('SELECT loyalty_enabled')) return { rows: [{ loyalty_enabled: false }], rowCount: 1 };
      if (sql.includes('UPDATE customers')) return { rows: [{ id: 'cust-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  currentTransaction = async (cb) => cb(client);

  await orderService.markOrderPaid({ orderId: 'ord-1', paymentMethod: 'cash', changedBy: 'merchant' });

  assert.ok(!writes.some(s => s.startsWith('UPDATE payment_attempts')),
    'there is no gateway attempt to settle for cash in hand');
});
