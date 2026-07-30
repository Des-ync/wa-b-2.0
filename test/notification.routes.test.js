const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * Second group migrated to the shared response layer. Same contract as
 * category.routes: the legacy assertions describe the behaviour BEFORE the
 * migration and must keep passing while public/dashboard.html and deployed
 * mobile builds are in the field.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
db.query = (...a) => currentQuery(...a);

const notificationRoutes = require('../src/routes/notification.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/notifications', notificationRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');
const v2 = (r) => auth(r).set('X-API-Version', '2');

const feed = async (sql) => (sql.includes('COUNT(*)')
  ? { rows: [{ n: 4 }] }
  : { rows: [{ id: 'n1', type: 'new_order', title: 'New order' }] });

test.beforeEach(() => { withQuery(async () => ({ rows: [] })); });

test('GET / legacy keeps unread_count flat beside notifications', async () => {
  withQuery(feed);

  const res = await auth(request(app()).get('/api/notifications').query({ business_id: 'biz-1' }));

  // Exactly the old shape. mobile home.dart reads res['unread_count'].
  assert.deepEqual(res.body, {
    success: true,
    notifications: [{ id: 'n1', type: 'new_order', title: 'New order' }],
    unread_count: 4
  });
});

test('GET / v2 moves unread_count into meta, where it belongs', async () => {
  withQuery(feed);

  const res = await v2(request(app()).get('/api/notifications').query({ business_id: 'biz-1' }));

  assert.deepEqual(res.body, {
    success: true,
    data: { notifications: [{ id: 'n1', type: 'new_order', title: 'New order' }] },
    meta: { unread_count: 4 }
  });
});

test('GET / clamps limit to a sane range', async () => {
  const seen = [];
  withQuery(async (sql, params) => { seen.push({ sql, params }); return feed(sql); });

  // Filter to the feed query itself — the auth layer issues its own queries
  // first, so indexing seen[0] would assert against the wrong one.
  const feedQuery = () => seen.find(c => c.sql.includes('FROM dashboard_notifications')
    && c.sql.includes('LIMIT'));

  await auth(request(app()).get('/api/notifications').query({ business_id: 'biz-1', limit: 5000 }));
  assert.equal(feedQuery().params[1], 100, 'an absurd limit must be capped');

  seen.length = 0;
  await auth(request(app()).get('/api/notifications').query({ business_id: 'biz-1', limit: 0 }));
  assert.equal(feedQuery().params[1], 30, 'a zero/absent limit falls back to the default');
});

test('GET / honours unread_only', async () => {
  const seen = [];
  withQuery(async (sql) => { seen.push(sql); return feed(sql); });

  await auth(request(app()).get('/api/notifications').query({ business_id: 'biz-1', unread_only: 'true' }));

  const feedSql = seen.find(s2 => s2.includes('FROM dashboard_notifications') && s2.includes('LIMIT'));
  assert.match(feedSql, /read_at IS NULL/);
});

test('GET / refuses another tenant and reports the missing business_id', async () => {
  const cross = await auth(request(app()).get('/api/notifications').query({ business_id: 'biz-2' }));
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error, 'Key does not match business');

  const missing = await v2(request(app()).get('/api/notifications'));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.fields.business_id, 'is required');
});

test('marking one read is idempotent and scoped to the owner', async () => {
  let updated = null;
  withQuery(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM dashboard_notifications')) {
      return { rows: [{ id: 'n1', business_id: 'biz-1' }] };
    }
    if (sql.startsWith('UPDATE dashboard_notifications')) { updated = { sql, params }; return { rows: [] }; }
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/notifications/n1/read'));

  assert.deepEqual(res.body, { success: true });
  // AND read_at IS NULL — re-reading an already-read notification must not
  // move its timestamp.
  assert.match(updated.sql, /read_at IS NULL/);
});

test("marking another tenant's notification read is refused", async () => {
  withQuery(async () => ({ rows: [{ id: 'n1', business_id: 'biz-OTHER' }] }));

  const res = await auth(request(app()).post('/api/notifications/n1/read'));
  assert.equal(res.status, 403);
});

test('an unknown notification is a 404 in both envelopes', async () => {
  const legacy = await auth(request(app()).post('/api/notifications/nope/read'));
  assert.equal(legacy.status, 404);
  assert.equal(legacy.body.error, 'Notification not found');

  const modern = await v2(request(app()).post('/api/notifications/nope/read'));
  assert.equal(modern.body.error.code, 'not_found');
});

test('mark-all-read falls back to the key own business', async () => {
  let updated = null;
  withQuery(async (sql, params) => {
    if (sql.startsWith('UPDATE dashboard_notifications')) { updated = params; return { rows: [] }; }
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/notifications/mark-all-read')).send({});

  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(updated, ['biz-1']);
});

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('DSN password=hunter2'); });

  const res = await v2(request(app()).get('/api/notifications').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});
