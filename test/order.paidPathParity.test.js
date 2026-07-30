const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * The acceptance criterion for the payment-pipeline unification:
 *
 *   "A cash sale marked paid on mobile produces byte-identical downstream
 *    state to the same sale paid via webhook."
 *
 * The bug this guards against was never that markOrderPaid was wrong — it was
 * that the mobile client reached a DIFFERENT function (updateOrderStatus),
 * which wrote orders.status and nothing else, so cash sales silently vanished
 * from GMV, analytics, stock and loyalty. Both callers now converge on
 * markOrderPaid, and these tests pin that convergence in place so a future
 * change cannot quietly re-fork them:
 *
 *   1. The two paths issue the SAME sequence of writes for the same sale.
 *   2. The merchant route cannot reach any other paid-path.
 *   3. PATCH /status still cannot set payment_status at all.
 */

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
let currentTransaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });
db.query = (...args) => currentQuery(...args);
db.transaction = (...args) => currentTransaction(...args);

const notification = require('../src/services/notification.service');
notification.notifyOrderPaid = async () => {};
notification.notifyOrderStatusChange = async () => {};

const orderService = require('../src/services/order.service');
const orderRoutes = require('../src/routes/order.routes');

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

const pendingOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', order_number: 'ORD-1',
  status: 'pending', payment_status: 'pending', payment_ref: null, payment_method: null,
  total_ghs: '45.00',
  items: [{ product_id: 'prod-1', name: 'Jollof', quantity: 2, price_ghs: 22.5 }]
};

/**
 * Records every statement markOrderPaid issues, so two runs can be compared
 * as sequences rather than as end-state snapshots — an end-state assertion
 * would pass even if one path skipped loyalty entirely and another wrote it
 * twice.
 */
function recordingClient(order, trace) {
  return {
    query: async (sql, params) => {
      trace.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FOR UPDATE')) return { rows: [order], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM payment_attempts')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('UPDATE orders')) {
        return {
          rows: [{ ...order, payment_status: 'paid', status: 'confirmed',
            payment_ref: params[1] || order.payment_ref,
            payment_method: params[2] || order.payment_method }],
          rowCount: 1
        };
      }
      if (sql.includes('UPDATE payment_attempts')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO order_status_history')) return { rows: [{ id: 'h1' }], rowCount: 1 };
      if (sql.includes('SELECT loyalty_enabled')) {
        return { rows: [{ loyalty_enabled: true, loyalty_points_per_ghs: 1, loyalty_stamps_target: 5,
          loyalty_free_item_value_ghs: 10, loyalty_referral_reward_ghs: 5 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers SET loyalty_points')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE customers SET loyalty_stamps')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE customers')) {
        return { rows: [{ id: 'cust-1', loyalty_points: 0, loyalty_stamps: 1,
          referred_by_customer_id: null, referral_reward_granted_at: null }], rowCount: 1 };
      }
      if (sql.includes('UPDATE products')) {
        return { rows: [{ id: 'prod-1', name: 'Jollof', stock_qty: 8, low_stock_threshold: 3,
          low_stock_notified: false }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO stock_movements')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
}

/** Run markOrderPaid against a fresh recording client and return the trace. */
async function traceOf(args) {
  const trace = [];
  const client = recordingClient(pendingOrder, trace);
  const prev = currentTransaction;
  currentTransaction = async (cb) => cb(client);
  try {
    await orderService.markOrderPaid(args);
  } finally {
    currentTransaction = prev;
  }
  return trace;
}

test('the merchant and webhook paid-paths issue an identical write sequence', async () => {
  // The webhook path: a gateway reference, credited by the system.
  const webhook = await traceOf({
    orderId: 'ord-1', paymentRef: 'ORD-REF-1', paymentMethod: 'momo',
    amount: 45, changedBy: 'system'
  });
  // The merchant path: cash in hand, no gateway reference, credited by a human.
  const merchant = await traceOf({
    orderId: 'ord-1', paymentMethod: 'cash', amount: 45, changedBy: 'merchant'
  });

  const shape = t => t.map(c => c.sql);
  // The ONE legitimate difference: with no reference to settle, the cash path
  // has no payment_attempts row to stamp. Everything else must match.
  const webhookShape = shape(webhook).filter(s => !s.startsWith('UPDATE payment_attempts'));
  const merchantShape = shape(merchant).filter(s => !s.startsWith('UPDATE payment_attempts'));

  assert.deepEqual(merchantShape, webhookShape,
    'the two paid-paths diverged — one of them is doing side-effect work the other is not');

  // And spot-check that the shared sequence really does include the four
  // side effects the original bug was silently skipping.
  const joined = webhookShape.join(' | ');
  assert.match(joined, /UPDATE orders SET payment_status = 'paid'/, 'payment_status not written');
  assert.match(joined, /INSERT INTO order_status_history/, 'no status-history row');
  assert.match(joined, /UPDATE customers SET total_spent_ghs/, 'GMV/customer spend not updated');
  assert.match(joined, /UPDATE products/, 'stock not decremented');
  assert.match(joined, /loyalty_enabled/, 'loyalty not consulted');
});

test('the mark-paid route reaches markOrderPaid and nothing else', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql === 'SELECT * FROM businesses WHERE id = $1') return { rows: [{ id: 'biz-1', name: 'Auntie Ama' }] };
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [{ id: 'cust-1' }] };
    return { rows: [] };
  };

  const called = [];
  const realMarkPaid = orderService.markOrderPaid;
  const realUpdateStatus = orderService.updateOrderStatus;
  orderService.markOrderPaid = async (args) => {
    called.push(['markOrderPaid', args]);
    return { order: { ...pendingOrder, payment_status: 'paid' }, lowStock: [] };
  };
  orderService.updateOrderStatus = async (...a) => { called.push(['updateOrderStatus', a]); return null; };

  try {
    const app = express();
    app.use(express.json());
    app.use('/api/orders', orderRoutes);
    const res = await request(app)
      .post('/api/orders/ord-1/mark-paid')
      .set('Authorization', 'Bearer k')
      .send({ method: 'cash' });

    assert.equal(res.status, 200);
    assert.deepEqual(called.map(c => c[0]), ['markOrderPaid']);
    assert.equal(called[0][1].changedBy, 'merchant');
  } finally {
    orderService.markOrderPaid = realMarkPaid;
    orderService.updateOrderStatus = realUpdateStatus;
  }
});

test("PATCH /status cannot set 'paid' — it has no access to payment_status", async () => {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);

  const res = await request(app)
    .patch('/api/orders/ord-1/status')
    .set('Authorization', 'Bearer k')
    .send({ status: 'paid' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /mark-paid/,
    'the error must point the caller at the correct route, not just reject them');
});
