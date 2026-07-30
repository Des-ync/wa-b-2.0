const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * Characterisation tests for device.routes.js and search.routes.js, written
 * before migrating either onto the shared response layer. Both were
 * untested; both are small enough that one file covers them.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
db.query = (...a) => currentQuery(...a);

const push = require('../src/services/push.service');
let registered = [];
let unregistered = [];
let listArgs = null;
push.registerDevice = async (args) => { registered.push(args); };
push.unregisterDevice = async (token, opts) => { unregistered.push({ token, opts }); return 1; };
push.listDevices = async (args) => { listArgs = args; return [{ id: 'dev-1', platform: 'android' }]; };

const deviceRoutes = require('../src/routes/device.routes');
const searchRoutes = require('../src/routes/search.routes');

const TENANT_KEY = { id: 'k1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };
const ADMIN_KEY = { id: 'k2', business_id: null, scope: 'admin', role: 'owner', revoked_at: null };
let keyRow = TENANT_KEY;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/devices', deviceRoutes);
  a.use('/api/search', searchRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [keyRow] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');

test.beforeEach(() => {
  keyRow = TENANT_KEY;
  registered = []; unregistered = []; listArgs = null;
  withQuery(async () => ({ rows: [] }));
});

// ------------------------------------------------------------------- devices

test('a tenant key registers a device scoped to its own business', async () => {
  const res = await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 'tok-1', platform: 'android', device_name: 'Kojo Pixel' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(registered[0], {
    businessId: 'biz-1', scope: 'tenant', fcmToken: 'tok-1',
    platform: 'android', deviceName: 'Kojo Pixel'
  });
});

test('an admin key registers a platform-scoped device with no business', async () => {
  keyRow = ADMIN_KEY;

  await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 'tok-2', platform: 'ios' });

  // An admin device must not be pinned to a business, or platform alerts
  // would leak into one tenant's feed.
  assert.equal(registered[0].businessId, null);
  assert.equal(registered[0].scope, 'admin');
});

test('register requires a token and a known platform', async () => {
  const noToken = await auth(request(app()).post('/api/devices/register'))
    .send({ platform: 'ios' });
  assert.equal(noToken.status, 400);
  assert.match(noToken.body.error, /fcm_token required/);

  const badPlatform = await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 'tok', platform: 'windows' });
  assert.equal(badPlatform.status, 400);
  assert.match(badPlatform.body.error, /'ios' or 'android'/);

  // An absurd token is refused rather than stored — it is an FCM key, not
  // free text.
  const huge = await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 'x'.repeat(5000), platform: 'ios' });
  assert.equal(huge.status, 400);
});

test('a device name is capped, and blank becomes null', async () => {
  await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 't', platform: 'ios', device_name: 'n'.repeat(200) });
  assert.equal(registered[0].deviceName.length, 80);

  await auth(request(app()).post('/api/devices/register'))
    .send({ fcm_token: 't', platform: 'ios' });
  assert.equal(registered[1].deviceName, null);
});

test('GET /devices scopes the listing to the caller', async () => {
  await auth(request(app()).get('/api/devices'));
  assert.deepEqual(listArgs, { businessId: 'biz-1' });

  keyRow = ADMIN_KEY;
  await auth(request(app()).get('/api/devices'));
  assert.deepEqual(listArgs, { scope: 'admin' });
});

test('unregister requires a token and reports what it removed', async () => {
  const res = await auth(request(app()).post('/api/devices/unregister'))
    .send({ fcm_token: 'tok-1' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, removed: 1 });
  assert.equal(unregistered[0].token, 'tok-1');
  // Scoped, so one tenant cannot unregister another's device by guessing.
  assert.deepEqual(unregistered[0].opts, { scope: 'tenant', businessId: 'biz-1' });

  const missing = await auth(request(app()).post('/api/devices/unregister')).send({});
  assert.equal(missing.status, 400);
});

// -------------------------------------------------------------------- search

test('search returns matches across orders, customers and products', async () => {
  const seen = [];
  withQuery(async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM orders')) return { rows: [{ id: 'o1', order_number: 'ORD-7' }] };
    if (sql.includes('FROM customers')) return { rows: [{ id: 'c1', display_name: 'Kojo' }] };
    if (sql.includes('FROM products')) return { rows: [{ id: 'p1', name: 'Jollof' }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).get('/api/search').query({ business_id: 'biz-1', q: 'jol' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true,
    orders: [{ id: 'o1', order_number: 'ORD-7' }],
    customers: [{ id: 'c1', display_name: 'Kojo' }],
    products: [{ id: 'p1', name: 'Jollof' }]
  });
  // Every branch is capped, so a one-letter-ish term cannot pull the catalog.
  assert.ok(seen.filter(s => s.sql.includes('LIMIT 6')).length >= 3);
});

test('a term under two characters short-circuits to empty', async () => {
  const seen = [];
  // Scoped to the search queries themselves — the auth layer issues its own
  // before the handler ever runs.
  withQuery(async (sql) => { seen.push(sql); return { rows: [] }; });

  const res = await auth(request(app()).get('/api/search').query({ business_id: 'biz-1', q: 'j' }));

  assert.deepEqual(res.body, { success: true, orders: [], customers: [], products: [] });
  assert.equal(seen.filter(s2 => /FROM (orders|customers|products)/.test(s2)).length, 0,
    'a one-character search must not run the three search queries');
});

test('ILIKE metacharacters are escaped, not treated as wildcards', async () => {
  let like;
  withQuery(async (sql, params) => {
    if (sql.includes('FROM orders')) like = params[1];
    return { rows: [] };
  });

  await auth(request(app()).get('/api/search').query({ business_id: 'biz-1', q: '100%_off' }));

  // Unescaped, '%' and '_' would let a search term match every row.
  assert.equal(like, '%100\\%\\_off%');
});

test('search requires a business_id and refuses another tenant', async () => {
  const missing = await auth(request(app()).get('/api/search').query({ q: 'jollof' }));
  assert.equal(missing.status, 400);

  const cross = await auth(request(app()).get('/api/search')
    .query({ business_id: 'biz-2', q: 'jollof' }));
  assert.equal(cross.status, 403);
});

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('DSN password=hunter2'); });

  const res = await auth(request(app()).get('/api/search').query({ business_id: 'biz-1', q: 'jollof' }));

  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});
