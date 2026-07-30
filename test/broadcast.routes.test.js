const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * Characterisation tests written before migrating broadcast.routes.js.
 *
 * This is the highest-blast-radius route in the product: one POST fans out to
 * every matching customer's WhatsApp. The rules that matter most are the ones
 * that stop a merchant sending something they cannot recall — opt-out
 * enforcement, the atomic create+fan-out, and the empty-audience case.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...a) => currentQuery(...a);
db.transaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });

const broadcastRoutes = require('../src/routes/broadcast.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/broadcasts', broadcastRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');

/** Models a successful create + fan-out to `recipientCount` customers. */
function withFanout(recipientCount = 3) {
  const seen = {};
  withQuery(async (sql, params) => {
    if (sql.includes('INSERT INTO broadcasts')) {
      seen.create = params;
      return { rows: [{ id: 'bc-1' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO broadcast_recipients')) {
      seen.recipientSql = sql; seen.recipientParams = params;
      return { rows: [], rowCount: recipientCount };
    }
    if (sql.includes('UPDATE broadcasts')) { seen.update = params; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return seen;
}

test.beforeEach(() => { withQuery(async () => ({ rows: [], rowCount: 0 })); });

test('GET / lists recent broadcasts with their delivery counters', async () => {
  let seenSql;
  withQuery(async (sql) => {
    seenSql = sql;
    return { rows: [{ id: 'bc-1', status: 'done', sent_count: 40, failed_count: 2 }] };
  });

  const res = await auth(request(app()).get('/api/broadcasts').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true,
    broadcasts: [{ id: 'bc-1', status: 'done', sent_count: 40, failed_count: 2 }]
  });
  assert.match(seenSql, /ORDER BY created_at DESC/);
  assert.match(seenSql, /LIMIT 50/);
});

test('GET / requires a business_id and refuses another tenant', async () => {
  const missing = await auth(request(app()).get('/api/broadcasts'));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'business_id required');

  const cross = await auth(request(app()).get('/api/broadcasts').query({ business_id: 'biz-2' }));
  assert.equal(cross.status, 403);
});

test('POST / creates the broadcast and fans out to matching customers', async () => {
  const seen = withFanout(3);

  const res = await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-1', body: '  Fresh jollof today!  ' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { success: true, broadcast_id: 'bc-1', target_count: 3 });
  assert.equal(seen.create[1], 'Fresh jollof today!', 'the body is trimmed');
  assert.equal(seen.create[2] !== undefined, true, 'an audience description is stored');
});

test('opted-out customers are NEVER included, whatever the audience filter', async () => {
  const seen = withFanout(2);

  await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-1', body: 'hi', audience: { tag: 'vip' } });

  // The single most important line in this file: a customer who replied STOP
  // must not receive a broadcast, regardless of what the merchant targeted.
  assert.match(seen.recipientSql, /opted_out = FALSE/);
  assert.equal(seen.recipientParams[1], 'biz-1', 'and scoped to this business');
});

test('an empty audience completes immediately instead of hanging pending', async () => {
  const seen = withFanout(0);

  const res = await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-1', body: 'hi' });

  assert.equal(res.status, 201);
  assert.equal(res.body.target_count, 0);
  // The sender job only ever completes a broadcast by draining recipients, so
  // one with none would otherwise sit 'pending' forever.
  assert.deepEqual(seen.update, ['bc-1', 0]);
});

test('POST / requires a non-empty body', async () => {
  for (const body of ['', '   ', undefined]) {
    const res = await auth(request(app()).post('/api/broadcasts'))
      .send({ business_id: 'biz-1', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /body is required/);
  }
});

test('POST / caps the body at the WhatsApp message limit', async () => {
  const res = await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-1', body: 'x'.repeat(1025) });

  // Rejected rather than truncated: a broadcast silently cut mid-sentence
  // goes to every customer at once and cannot be recalled.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too long/);
});

test('POST / requires a business_id and refuses another tenant', async () => {
  const missing = await auth(request(app()).post('/api/broadcasts')).send({ body: 'hi' });
  assert.equal(missing.status, 400);

  const cross = await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-2', body: 'hi' });
  assert.equal(cross.status, 403);
});

test('a failure mid-fan-out leaves no half-created broadcast', async () => {
  withQuery(async (sql) => {
    if (sql.includes('INSERT INTO broadcasts')) return { rows: [{ id: 'bc-1' }], rowCount: 1 };
    if (sql.includes('INSERT INTO broadcast_recipients')) throw new Error('deadlock detected');
    return { rows: [], rowCount: 0 };
  });

  const res = await auth(request(app()).post('/api/broadcasts'))
    .send({ business_id: 'biz-1', body: 'hi' });

  // The whole thing runs in one transaction precisely so a crash here cannot
  // leave a broadcast with no recipient rows.
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal server error');
});
