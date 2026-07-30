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

/**
 * Broadcast safety rails (Phase 7).
 *
 * A broadcast fans out the moment it is created and cannot be recalled, so
 * everything here exists to answer one question before that happens: who is
 * actually going to receive this, and does it read the way I think it does.
 */

const wa = require('../src/services/whatsapp.service');
let testSends = [];
wa.sendText = async (to, body) => { testSends.push({ to, body }); return { success: true }; };

test.beforeEach(() => { testSends = []; });

test('preview counts exactly who the fan-out would reach', async () => {
  const seen = [];
  withQuery(async (sql) => {
    seen.push(sql.replace(/\s+/g, ' '));
    if (sql.includes('opted_out = FALSE') && sql.includes('COUNT')) return { rows: [{ n: 847 }] };
    if (sql.includes('opted_out = TRUE')) return { rows: [{ n: 12 }] };
    return { rows: [{ display_name: 'Kojo', whatsapp_number: '+233241234567' }] };
  });

  const res = await auth(request(app()).post('/api/broadcasts/preview'))
    .send({ business_id: 'biz-1', audience: { segment: 'inactive_60d' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.recipient_count, 847);
  // The difference between 4 people and 4,000 is the difference between a
  // nudge and a reputational incident.
  assert.equal(res.body.opted_out_count, 12);
  assert.match(res.body.audience_desc, /Inactive/);
  assert.equal(res.body.sample[0].display_name, 'Kojo');
});

test('preview excludes opted-out customers, same as the real fan-out', async () => {
  const seen = [];
  withQuery(async (sql) => {
    seen.push(sql);
    return { rows: [{ n: 0 }] };
  });

  await auth(request(app()).post('/api/broadcasts/preview'))
    .send({ business_id: 'biz-1' });

  const countQuery = seen.find(s => s.includes('COUNT') && s.includes('opted_out = FALSE'));
  assert.ok(countQuery, 'the reachable count must exclude opted-out customers');
});

test('the opted-out count is scoped to the SAME audience filter', async () => {
  // Otherwise it answers "how many overall", which is a different and
  // misleading number next to a filtered recipient count.
  const seen = [];
  withQuery(async (sql, params) => {
    seen.push({ sql: sql.replace(/\s+/g, ' '), params });
    return { rows: [{ n: 1 }] };
  });

  await auth(request(app()).post('/api/broadcasts/preview'))
    .send({ business_id: 'biz-1', audience: { tag: 'vip' } });

  const optedOut = seen.find(c => c.sql.includes('opted_out = TRUE'));
  assert.match(optedOut.sql, /ANY\(c\.tags\)/, 'the tag filter must apply to both counts');
  assert.ok(optedOut.params.includes('vip'));
});

test('preview needs a business_id and refuses another tenant', async () => {
  const missing = await auth(request(app()).post('/api/broadcasts/preview')).send({});
  assert.equal(missing.status, 400);

  const cross = await auth(request(app()).post('/api/broadcasts/preview'))
    .send({ business_id: 'biz-2' });
  assert.equal(cross.status, 403);
});

test('a test send goes to the shop own number, clearly marked', async () => {
  withQuery(async (sql) => (sql.includes('FROM businesses')
    ? { rows: [{ id: 'biz-1', name: 'Auntie Ama', whatsapp_number: '+233241110000' }] }
    : { rows: [] }));

  const res = await auth(request(app()).post('/api/broadcasts/test'))
    .send({ business_id: 'biz-1', body: 'Fresh jollof today!' });

  assert.equal(res.status, 200);
  assert.equal(testSends.length, 1);
  assert.equal(testSends[0].to, '+233241110000');
  // A merchant reading it on their phone must not mistake it for a campaign
  // that already went out.
  assert.match(testSends[0].body, /TEST/);
  assert.match(testSends[0].body, /Only you received it/);
  assert.match(testSends[0].body, /Fresh jollof today!/);
});

test('a test is NOT recorded as a broadcast', async () => {
  const seen = [];
  withQuery(async (sql) => {
    seen.push(sql);
    if (sql.includes('FROM businesses')) {
      return { rows: [{ id: 'biz-1', name: 'A', whatsapp_number: '+233241110000' }] };
    }
    return { rows: [] };
  });

  await auth(request(app()).post('/api/broadcasts/test'))
    .send({ business_id: 'biz-1', body: 'hi' });

  // Counting it would corrupt the history and the delivery stats.
  assert.ok(!seen.some(s => s.includes('INSERT INTO broadcasts')));
  assert.ok(!seen.some(s => s.includes('INSERT INTO broadcast_recipients')));
});

test('a test needs a body, and respects the same length cap as a real send', async () => {
  withQuery(async () => ({ rows: [{ id: 'biz-1', whatsapp_number: '+233241110000' }] }));

  const empty = await auth(request(app()).post('/api/broadcasts/test'))
    .send({ business_id: 'biz-1', body: '  ' });
  assert.equal(empty.status, 400);

  const long = await auth(request(app()).post('/api/broadcasts/test'))
    .send({ business_id: 'biz-1', body: 'x'.repeat(1025) });
  assert.equal(long.status, 400);
});

test('a shop with no WhatsApp number gets a clear reason, not a crash', async () => {
  withQuery(async (sql) => (sql.includes('FROM businesses')
    ? { rows: [{ id: 'biz-1', name: 'A', whatsapp_number: null }] }
    : { rows: [] }));

  const res = await auth(request(app()).post('/api/broadcasts/test'))
    .send({ business_id: 'biz-1', body: 'hi' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /no WhatsApp number/);
});
