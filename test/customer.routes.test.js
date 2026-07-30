const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * Characterisation tests for customer.routes.js, written BEFORE it is
 * migrated onto the shared response layer — the rule established after two
 * hanging-route bugs slipped through on groups that had no coverage.
 *
 * Every assertion describes behaviour as it is today. The migration's job is
 * to leave all of it untouched.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
db.query = (...a) => currentQuery(...a);

const channel = require('../src/services/channel.adapter');
let sentMessages = [];
channel.getAdapter = () => ({
  sendText: async (dest, text) => { sentMessages.push({ dest, text }); }
});
channel.destOf = (c) => c.whatsapp_number;

const customerRoutes = require('../src/routes/customer.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/customers', customerRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');
const CUSTOMER = {
  id: 'cust-1', business_id: 'biz-1', whatsapp_number: '233241234567',
  display_name: 'Kojo', loyalty_points: 120, tags: []
};

/** Most routes resolve the customer first and 404 before validating. */
function withCustomer(extra = async () => ({ rows: [] }), customer = CUSTOMER) {
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [customer] };
    return extra(sql, params);
  });
}

test.beforeEach(() => { sentMessages = []; withQuery(async () => ({ rows: [] })); });

// ------------------------------------------------------------------------ list

test('GET / lists customers by lifetime spend by default', async () => {
  let seenSql;
  withQuery(async (sql) => { seenSql = sql; return { rows: [{ id: 'cust-1' }] }; });

  const res = await auth(request(app()).get('/api/customers').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, customers: [{ id: 'cust-1' }] });
  assert.match(seenSql, /ORDER BY c\.total_spent_ghs DESC/);
});

test('GET /?sort=recent orders by last seen instead', async () => {
  let seenSql;
  withQuery(async (sql) => { seenSql = sql; return { rows: [] }; });

  await auth(request(app()).get('/api/customers').query({ business_id: 'biz-1', sort: 'recent' }));

  assert.match(seenSql, /ORDER BY c\.last_seen_at DESC/);
});

test('GET / clamps the limit', async () => {
  const seen = [];
  withQuery(async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; });

  await auth(request(app()).get('/api/customers').query({ business_id: 'biz-1', limit: 9999 }));
  const q = seen.find(c => c.sql.includes('FROM customers c'));
  assert.equal(q.params[q.params.length - 1], 200);

  seen.length = 0;
  await auth(request(app()).get('/api/customers').query({ business_id: 'biz-1' }));
  const d = seen.find(c => c.sql.includes('FROM customers c'));
  assert.equal(d.params[d.params.length - 1], 50, 'default page size');
});

test('GET / requires a business_id and refuses another tenant', async () => {
  // A tenant key falls back to its own business only where the route says so;
  // this one reads business_id straight off the query.
  const missing = await auth(request(app()).get('/api/customers'));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'business_id required');

  const cross = await auth(request(app()).get('/api/customers').query({ business_id: 'biz-2' }));
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error, 'Key does not match business');
});

// ------------------------------------------------------------------------ tags

test('PATCH /tags normalizes, dedupes and caps the list', async () => {
  let written;
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.startsWith('UPDATE customers SET tags')) { written = params[1]; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  const res = await auth(request(app()).patch('/api/customers/cust-1/tags'))
    .send({ tags: ['  VIP  ', 'vip', 'Wholesale', ''] });

  assert.equal(res.status, 200);
  // lower-cased, trimmed, blanks dropped, duplicates collapsed
  assert.deepEqual(written, ['vip', 'wholesale']);
});

test('PATCH /tags rejects anything that is not an array', async () => {
  withCustomer();
  const res = await auth(request(app()).patch('/api/customers/cust-1/tags')).send({ tags: 'vip' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /array/);
});

test('PATCH /tags caps at 20 tags and 40 characters each', async () => {
  let written;
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.startsWith('UPDATE customers SET tags')) { written = params[1]; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/customers/cust-1/tags'))
    .send({ tags: Array.from({ length: 30 }, (_, i) => `tag${i}`).concat('x'.repeat(60)) });

  assert.equal(written.length, 20);
  assert.ok(written.every(t => t.length <= 40));
});

// ---------------------------------------------------------------- address note

test('PATCH /address-note trims, caps and stores the note', async () => {
  let written;
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('SET address_note')) { written = params[1]; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/customers/cust-1/address-note'))
    .send({ address_note: '  Blue gate opposite the mosque  ' });
  assert.equal(written, 'Blue gate opposite the mosque');

  await auth(request(app()).patch('/api/customers/cust-1/address-note'))
    .send({ address_note: 'n'.repeat(500) });
  assert.equal(written.length, 300, 'the note is pasted into a WhatsApp message');
});

test('PATCH /address-note accepts null to clear it, rejects a non-string', async () => {
  let written = 'unset';
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('SET address_note')) { written = params[1]; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/customers/cust-1/address-note')).send({ address_note: null });
  assert.equal(written, null);

  // An empty string clears rather than storing '' — the column means
  // "no standing directions", not "directions that are blank".
  await auth(request(app()).patch('/api/customers/cust-1/address-note')).send({ address_note: '   ' });
  assert.equal(written, null);

  withCustomer();
  const bad = await auth(request(app()).patch('/api/customers/cust-1/address-note'))
    .send({ address_note: { nope: 1 } });
  assert.equal(bad.status, 400);
});

test('a merchant note can never rewrite the customer own address', async () => {
  let updateSql;
  withQuery(async (sql) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('SET address_note')) { updateSql = sql; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/customers/cust-1/address-note'))
    .send({ address_note: 'x', address: 'somewhere else' });

  assert.ok(!/SET address =|address =/.test(updateSql.replace('address_note', '')),
    'checkout owns `address`; this route must only touch address_note');
});

// -------------------------------------------------------------- points redeem

test('redeeming points debits the balance and issues a coded reward', async () => {
  const writes = [];
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('loyalty_points_redemption_rate_ghs')) {
      return { rows: [{ name: 'Auntie Ama', loyalty_points_redemption_rate_ghs: 0.1 }] };
    }
    writes.push({ sql, params });
    if (sql.includes('INSERT INTO customer_rewards')) {
      return { rows: [{ id: 'rw-1', code: params[2], discount_value: params[4] }] };
    }
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/customers/cust-1/loyalty/redeem-points'))
    .send({ points: 100 });

  assert.equal(res.status, 201);
  assert.ok(writes.some(w => w.sql.includes('loyalty_points = loyalty_points - $2')));
  assert.equal(res.body.reward.discount_value, 10);   // 100 points x 0.1
  // The customer is told, on their own channel.
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /redeemed 100 points/);
});

test('redeeming more points than the customer has is refused', async () => {
  withCustomer();
  const res = await auth(request(app()).post('/api/customers/cust-1/loyalty/redeem-points'))
    .send({ points: 5000 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /only has 120 points/);
});

test('a non-positive or unparseable points value is refused', async () => {
  for (const points of [0, -5, 'abc', null]) {
    withCustomer();
    const res = await auth(request(app()).post('/api/customers/cust-1/loyalty/redeem-points'))
      .send({ points });
    assert.equal(res.status, 400, `points=${points}`);
  }
});

test('a fractional points value is truncated down, not rejected', async () => {
  // parseInt(1.5) === 1. Documented rather than "fixed": truncating DOWN
  // debits the customer fewer points than they asked for, so the leniency
  // cannot cost them anything. Changing it is a product decision, not a
  // migration one.
  let debited;
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('loyalty_points_redemption_rate_ghs')) {
      return { rows: [{ name: 'A', loyalty_points_redemption_rate_ghs: 0.1 }] };
    }
    if (sql.includes('loyalty_points = loyalty_points - $2')) { debited = params[1]; return { rows: [] }; }
    if (sql.includes('INSERT INTO customer_rewards')) return { rows: [{ id: 'rw-1' }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/customers/cust-1/loyalty/redeem-points'))
    .send({ points: 1.5 });

  assert.equal(res.status, 201);
  assert.equal(debited, 1);
});

test('redemption is refused when the business has no rate configured', async () => {
  withCustomer(async (sql) => (sql.includes('loyalty_points_redemption_rate_ghs')
    ? { rows: [{ name: 'Auntie Ama', loyalty_points_redemption_rate_ghs: 0 }] }
    : { rows: [] }));

  const res = await auth(request(app()).post('/api/customers/cust-1/loyalty/redeem-points'))
    .send({ points: 10 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not configured/);
  assert.equal(sentMessages.length, 0, 'nothing was issued, so say nothing');
});

// -------------------------------------------------------------------- birthday

test('birthday accepts YYYY-MM-DD or null and rejects anything else', async () => {
  let written = 'unset';
  withQuery(async (sql, params) => {
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [CUSTOMER] };
    if (sql.includes('SET date_of_birth')) { written = params[1]; return { rows: [CUSTOMER] }; }
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/customers/cust-1/birthday')).send({ date_of_birth: '1990-04-12' });
  assert.equal(written, '1990-04-12');

  await auth(request(app()).patch('/api/customers/cust-1/birthday')).send({ date_of_birth: null });
  assert.equal(written, null);

  withCustomer();
  const bad = await auth(request(app()).patch('/api/customers/cust-1/birthday'))
    .send({ date_of_birth: '12/04/1990' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /YYYY-MM-DD/);
});

// ----------------------------------------------------------------- 404 and 403

test('every :id route 404s an unknown customer', async () => {
  withQuery(async () => ({ rows: [] }));

  for (const [method, path, body] of [
    ['patch', '/api/customers/nope/tags', { tags: [] }],
    ['patch', '/api/customers/nope/address-note', { address_note: 'x' }],
    ['patch', '/api/customers/nope/birthday', { date_of_birth: null }],
    ['post', '/api/customers/nope/loyalty/redeem-points', { points: 1 }]
  ]) {
    const res = await auth(request(app())[method](path)).send(body);
    assert.equal(res.status, 404, path);
    assert.equal(res.body.error, 'Customer not found');
  }
});

test("every :id route refuses another tenant's customer", async () => {
  withQuery(async () => ({ rows: [{ ...CUSTOMER, business_id: 'biz-OTHER' }] }));

  const res = await auth(request(app()).patch('/api/customers/cust-1/tags')).send({ tags: [] });
  assert.equal(res.status, 403);
});

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('DSN password=hunter2'); });

  const res = await auth(request(app()).get('/api/customers').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal server error');
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});
