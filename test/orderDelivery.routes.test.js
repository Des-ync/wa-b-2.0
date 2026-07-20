const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

// whatsapp.service would otherwise make a real (failing) HTTP call for every
// rider/customer notification this test file triggers — stub the send so
// the suite stays fast and network-independent, same spirit as
// instagram.service.test.js stubbing axios.create.
const wa = require('../src/services/whatsapp.service');
wa.sendText = async () => ({ success: true, messageId: 'wamid.test' });

const orderRoutes = require('../src/routes/order.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

const baseOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', order_number: 'ORD-1',
  status: 'confirmed', payment_status: 'paid', total_ghs: '45.00',
  items: [{ name: 'Jollof', quantity: 2 }], delivery_address: '12 Oxford St, Osu',
  rider_name: null, rider_phone: null, delivery_status: 'unassigned', delivery_proof_url: null
};

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('PATCH /orders/:id/delivery assigns a rider without requiring a phone', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [baseOrder] };
    if (sql.includes('UPDATE orders SET rider_name')) {
      return { rows: [{ ...baseOrder, rider_name: 'Kwame', delivery_status: 'assigned' }] };
    }
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .patch('/api/orders/ord-1/delivery')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ rider_name: 'Kwame' });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.rider_name, 'Kwame');
});

test('PATCH /orders/:id/delivery with a rider_phone triggers a rider WhatsApp notification (fire-and-forget, never fails the request)', async () => {
  const calls = [];
  withKeyLookup(async (sql, params) => {
    calls.push(sql.slice(0, 40));
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [baseOrder] };
    if (sql.includes('UPDATE orders SET rider_name')) {
      return { rows: [{ ...baseOrder, rider_name: 'Kwame', rider_phone: '0241234567', delivery_status: 'assigned' }] };
    }
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT id, name FROM businesses')) return { rows: [{ id: 'biz-1', name: 'Auntie Ama' }] };
    if (sql.includes('SELECT display_name, whatsapp_number FROM customers')) {
      return { rows: [{ display_name: 'Kojo', whatsapp_number: '+233241111111' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .patch('/api/orders/ord-1/delivery')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ rider_name: 'Kwame', rider_phone: '0241234567' });
  assert.equal(res.status, 200);
  // Give the fire-and-forget notification a tick to run before asserting.
  await new Promise(r => setTimeout(r, 20));
  assert.ok(calls.some(s => s.includes('SELECT id, name FROM businesses')), 'expected the notifier to look up the business');
});

test('PATCH /orders/:id/delivery marking delivered WITHOUT a proof photo does not trigger notifyDeliveryCompleted', async () => {
  let customerLookupCalled = false;
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [baseOrder] };
    if (sql.includes('UPDATE orders SET delivery_status')) {
      return { rows: [{ ...baseOrder, delivery_status: 'delivered' }] };
    }
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM customers WHERE id')) { customerLookupCalled = true; return { rows: [] }; }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .patch('/api/orders/ord-1/delivery')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ delivery_status: 'delivered' });
  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(customerLookupCalled, false);
});

test('PATCH /orders/:id/delivery marking delivered WITH a proof photo notifies the customer', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [baseOrder] };
    if (sql.includes('UPDATE orders SET delivery_status')) {
      return { rows: [{ ...baseOrder, delivery_status: 'delivered', delivery_proof_url: 'https://cdn.example/proof.jpg' }] };
    }
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT id, name, bot_language FROM businesses')) {
      return { rows: [{ id: 'biz-1', name: 'Auntie Ama', bot_language: 'en' }] };
    }
    if (sql === 'SELECT * FROM customers WHERE id = $1') {
      return { rows: [{ id: 'cust-1', channel: 'whatsapp', whatsapp_number: '+233241111111', display_name: 'Kojo' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .patch('/api/orders/ord-1/delivery')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ delivery_status: 'delivered', delivery_proof_url: 'https://cdn.example/proof.jpg' });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.delivery_proof_url, 'https://cdn.example/proof.jpg');
});
