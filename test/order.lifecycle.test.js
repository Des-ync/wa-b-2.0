const test = require('node:test');
const assert = require('node:assert/strict');

// order.service destructures { query } at require time, so install a
// swappable indirection on the db module BEFORE requiring the service.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const paystack = require('../src/services/paystack.service');
let currentRefund = async () => { throw new Error('no refund handler installed for this test'); };
paystack.refundTransaction = (...args) => currentRefund(...args);

const orderService = require('../src/services/order.service');

/**
 * Routes queries by SQL substring, same pattern as order.service.test.js's
 * makeClient, but for the plain (non-transaction) `query` function used by
 * the lifecycle helpers (notes, delivery, estimates, refunds).
 */
function withQuery(handlers, fn) {
  const calls = [];
  const original = currentQuery;
  currentQuery = async (sql, params) => {
    calls.push({ sql, params });
    for (const [match, respond] of handlers) {
      if (sql.includes(match)) return respond(params, calls);
    }
    throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => { currentQuery = original; });
}

function withRefund(handler, fn) {
  const original = currentRefund;
  currentRefund = handler;
  return Promise.resolve(fn()).finally(() => { currentRefund = original; });
}

const baseOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1',
  status: 'paid', payment_status: 'paid', payment_method: 'momo',
  payment_ref: 'REF-A', total_ghs: '50.00'
};

test('addOrderNote appends a timestamped, authored note and logs history', async () => {
  await withQuery([
    ['UPDATE orders SET internal_notes', (params) => {
      assert.equal(params[0], 'ord-1');
      assert.match(params[1], /^\[.+\] Merchant: Ran out of chicken, substituted beef$/);
      return { rows: [{ ...baseOrder, internal_notes: params[1] }] };
    }],
    ['INSERT INTO order_status_history', (params) => {
      assert.equal(params[1], 'note');
      assert.equal(params[3], 'merchant');
      return { rows: [] };
    }]
  ], async () => {
    const order = await orderService.addOrderNote('ord-1', 'Ran out of chicken, substituted beef');
    assert.ok(order.internal_notes.includes('Merchant:'));
  });
});

test('addOrderNote rejects an empty note', async () => {
  await assert.rejects(() => orderService.addOrderNote('ord-1', '   '), /note is required/);
});

test('assignDelivery sets rider fields and delivery_status to assigned', async () => {
  await withQuery([
    ['UPDATE orders SET rider_name', (params) => {
      assert.equal(params[1], 'Kwame');
      assert.equal(params[2], '0241234567');
      return { rows: [{ ...baseOrder, rider_name: 'Kwame', rider_phone: '0241234567', delivery_status: 'assigned' }] };
    }],
    ['INSERT INTO order_status_history', () => ({ rows: [] })]
  ], async () => {
    const order = await orderService.assignDelivery('ord-1', { riderName: 'Kwame', riderPhone: '0241234567' });
    assert.equal(order.delivery_status, 'assigned');
  });
});

test('assignDelivery rejects a missing rider name', async () => {
  await assert.rejects(() => orderService.assignDelivery('ord-1', { riderName: '' }), /riderName is required/);
});

test('updateDeliveryStatus rejects an invalid status', async () => {
  await assert.rejects(
    () => orderService.updateDeliveryStatus('ord-1', 'teleported'),
    /Invalid delivery status/
  );
});

test('updateDeliveryStatus writes delivery_proof_url when provided', async () => {
  await withQuery([
    ['UPDATE orders SET delivery_status', (params, calls) => {
      const sql = calls[calls.length - 1].sql;
      assert.match(sql, /delivery_proof_url/);
      assert.equal(params[2], 'https://example.com/proof.jpg');
      return { rows: [{ ...baseOrder, delivery_status: 'delivered' }] };
    }],
    ['INSERT INTO order_status_history', () => ({ rows: [] })]
  ], async () => {
    const order = await orderService.updateDeliveryStatus('ord-1', 'delivered', { proofUrl: 'https://example.com/proof.jpg' });
    assert.equal(order.delivery_status, 'delivered');
  });
});

test('setEstimates requires at least one field', async () => {
  await assert.rejects(() => orderService.setEstimates('ord-1', {}), /readyAt or deliveryAt is required/);
});

test('createRefund rejects a non-positive amount', async () => {
  await assert.rejects(
    () => orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 0 }),
    /amountGhs must be a positive number/
  );
});

test('createRefund rejects refunding more than the order total', async () => {
  await withQuery([
    ['SELECT * FROM orders WHERE id', () => ({ rows: [baseOrder] })],
    ['FROM order_refunds WHERE order_id', () => ({ rows: [{ total: '40.00' }] })]
  ], async () => {
    await assert.rejects(
      () => orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 20 }),
      /would exceed the order total/
    );
  });
});

test('createRefund rejects refunding an order that was never paid', async () => {
  await withQuery([
    ['SELECT * FROM orders WHERE id', () => ({ rows: [{ ...baseOrder, payment_status: 'unpaid' }] })]
  ], async () => {
    await assert.rejects(
      () => orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 10 }),
      /Only paid orders can be refunded/
    );
  });
});

test('createRefund calls the Paystack gateway for a momo order and marks it processed on success', async () => {
  await withRefund(async (ref, amount) => {
    assert.equal(ref, 'REF-A');
    assert.equal(amount, 15);
    return { success: true, gateway_ref: 'gw-123' };
  }, () => withQuery([
    ['SELECT * FROM orders WHERE id', () => ({ rows: [baseOrder] })],
    ['FROM order_refunds WHERE order_id', () => ({ rows: [{ total: '0' }] })],
    ['INSERT INTO order_refunds', (params) => {
      assert.equal(params[4], 'processed');
      assert.equal(params[5], 'gw-123');
      return { rows: [{ id: 'refund-1', status: 'processed', amount_ghs: '15.00', gateway_ref: 'gw-123' }] };
    }],
    ['UPDATE orders SET payment_status', () => ({ rows: [] })],
    ['INSERT INTO order_status_history', () => ({ rows: [] })]
  ], async () => {
    const refund = await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 15, reason: 'Customer complaint' });
    assert.equal(refund.status, 'processed');
  }));
});

test('createRefund marks a cash order refund processed without calling the gateway', async () => {
  const cashOrder = { ...baseOrder, payment_method: 'cash' };
  await withQuery([
    ['SELECT * FROM orders WHERE id', () => ({ rows: [cashOrder] })],
    ['FROM order_refunds WHERE order_id', () => ({ rows: [{ total: '0' }] })],
    ['INSERT INTO order_refunds', (params) => {
      assert.equal(params[4], 'processed');
      return { rows: [{ id: 'refund-2', status: 'processed' }] };
    }],
    ['UPDATE orders SET payment_status', () => ({ rows: [] })],
    ['INSERT INTO order_status_history', () => ({ rows: [] })]
  ], async () => {
    const refund = await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });
    assert.equal(refund.status, 'processed');
  });
});

test('createRefund falls back to pending when the gateway call fails', async () => {
  await withRefund(async () => ({ success: false, error: 'gateway timeout' }), () => withQuery([
    ['SELECT * FROM orders WHERE id', () => ({ rows: [baseOrder] })],
    ['FROM order_refunds WHERE order_id', () => ({ rows: [{ total: '0' }] })],
    ['INSERT INTO order_refunds', (params) => {
      assert.equal(params[4], 'pending');
      return { rows: [{ id: 'refund-3', status: 'pending' }] };
    }],
    ['INSERT INTO order_status_history', () => ({ rows: [] })]
  ], async () => {
    const refund = await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 10 });
    assert.equal(refund.status, 'pending');
  }));
});
