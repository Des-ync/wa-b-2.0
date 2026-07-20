const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const analyticsRoutes = require('../src/routes/analytics.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('GET /analytics/delivery-sla requires business_id in the query (same as the rest of analytics.routes.js)', async () => {
  withKeyLookup(async () => ({ rows: [] }));
  const app = buildApp();
  const res = await request(app).get('/api/analytics/delivery-sla').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 400);
});

test('GET /analytics/delivery-sla computes average minutes, late count, and a per-rider breakdown', async () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const rows = [
    {
      id: 'o1', order_number: 'ORD-1', rider_name: 'Kwame',
      estimated_delivery_at: new Date(now.getTime() - 5 * 60000), // ETA 12 min ago from delivered_at below -> late
      assigned_at: new Date(now.getTime() - 40 * 60000),
      delivered_at: now,
      minutes_to_deliver: 40, late: true
    },
    {
      id: 'o2', order_number: 'ORD-2', rider_name: 'Kwame',
      estimated_delivery_at: new Date(now.getTime() + 30 * 60000), // ETA in future -> on time
      assigned_at: new Date(now.getTime() - 20 * 60000),
      delivered_at: now,
      minutes_to_deliver: 20, late: false
    },
    {
      id: 'o3', order_number: 'ORD-3', rider_name: 'Ama',
      estimated_delivery_at: null,
      assigned_at: new Date(now.getTime() - 15 * 60000),
      delivered_at: now,
      minutes_to_deliver: 15, late: false
    }
  ];
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM orders o')) return { rows };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .get('/api/analytics/delivery-sla?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  const sla = res.body.delivery_sla;
  assert.equal(sla.completed_deliveries, 3);
  assert.equal(sla.avg_minutes_to_deliver, 25); // (40+20+15)/3 = 25
  assert.equal(sla.late_count, 1);
  assert.equal(sla.late_rate_pct, 50); // 1 late out of 2 orders WITH an eta

  const kwame = sla.by_rider.find(r => r.rider_name === 'Kwame');
  assert.equal(kwame.deliveries, 2);
  assert.equal(kwame.avg_minutes, 30); // (40+20)/2
  assert.equal(kwame.late_count, 1);

  const ama = sla.by_rider.find(r => r.rider_name === 'Ama');
  assert.equal(ama.deliveries, 1);
  assert.equal(ama.late_rate_pct, null); // no ETA on file for that order
});

test('GET /analytics/delivery-sla with no completed deliveries returns nulls, not NaN/crash', async () => {
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: [] };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .get('/api/analytics/delivery-sla?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery_sla.completed_deliveries, 0);
  assert.equal(res.body.delivery_sla.avg_minutes_to_deliver, null);
  assert.equal(res.body.delivery_sla.late_rate_pct, null);
});

test('GET /analytics/delivery-sla is blocked for a tenant requesting another business', async () => {
  withKeyLookup(async () => ({ rows: [] }));
  const app = buildApp();
  const res = await request(app)
    .get('/api/analytics/delivery-sla?business_id=biz-OTHER')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});
