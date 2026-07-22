const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// receipt.routes.js is deliberately public (no auth) — no key-lookup stub needed.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const receiptRoutes = require('../src/routes/receipt.routes');

function buildApp() {
  const app = express();
  app.use('/api/receipts', receiptRoutes);
  return app;
}

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function baseRow(overrides = {}) {
  return {
    id: ORDER_ID, order_number: 'ORD-2026-AB12', created_at: new Date().toISOString(),
    status: 'delivered', payment_status: 'paid', payment_method: 'momo',
    items: [{ name: 'Jollof', quantity: 2, price_ghs: 20 }],
    subtotal_ghs: '40.00', delivery_fee: '5.00', discount_ghs: '0.00', promo_code: null, total_ghs: '45.00',
    delivery_address: 'East Legon', estimated_ready_at: null, estimated_delivery_at: null,
    rider_name: 'Kojo', rider_phone: '+233241111111', delivery_status: 'out_for_delivery',
    delivery_proof_url: null,
    business_name: 'Auntie Ama Kitchen', support_phone: '+233201234567', business_whatsapp: '+233201234567',
    business_logo_url: 'https://cdn.example.com/logo.png', refund_policy: null,
    customer_name: 'Kwame', customer_phone: '+233241234567',
    ...overrides
  };
}

function stub(row, historyRows = []) {
  currentQuery = async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: row ? [row] : [] };
    if (sql.includes('FROM order_status_history')) return { rows: historyRows };
    throw new Error(`Unmocked query: ${sql}`);
  };
}

test('GET /receipts/:id returns the rider phone unmasked, unlike the customer phone', async () => {
  stub(baseRow());
  const res = await request(buildApp()).get(`/api/receipts/${ORDER_ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.rider_phone, '+233241111111');
  assert.equal(res.body.receipt.customer_phone_masked, '•••••••••4567');
});

test('GET /receipts/:id surfaces the merchant logo', async () => {
  stub(baseRow());
  const res = await request(buildApp()).get(`/api/receipts/${ORDER_ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.business_logo_url, 'https://cdn.example.com/logo.png');
});

test('GET /receipts/:id falls back to a default refund policy when the merchant has not set one', async () => {
  stub(baseRow({ refund_policy: null }));
  const res = await request(buildApp()).get(`/api/receipts/${ORDER_ID}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.receipt.refund_policy.length > 0);
});

test('GET /receipts/:id returns the merchant\'s own refund policy text when set', async () => {
  stub(baseRow({ refund_policy: 'No refunds after 24 hours.' }));
  const res = await request(buildApp()).get(`/api/receipts/${ORDER_ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.refund_policy, 'No refunds after 24 hours.');
});

test('GET /receipts/:id 404s on a malformed id without hitting the database', async () => {
  currentQuery = async () => { throw new Error('should not query for a malformed id'); };
  const res = await request(buildApp()).get('/api/receipts/not-a-uuid');
  assert.equal(res.status, 404);
});

test('GET /receipts/:id 404s when no order matches', async () => {
  stub(null);
  const res = await request(buildApp()).get(`/api/receipts/${ORDER_ID}`);
  assert.equal(res.status, 404);
});
