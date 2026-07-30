const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * Characterisation tests written before migrating promo.routes.js.
 *
 * Promos discount real money, so the validation boundaries matter more than
 * usual: a percent above 100 would pay the customer to order, and a promo
 * scoped to another business's product would let one merchant discount
 * another's catalog.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...a) => currentQuery(...a);

const promoRoutes = require('../src/routes/promo.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/promos', promoRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');

/** A create that reaches the INSERT, capturing its params. */
function withCreate() {
  const seen = {};
  withQuery(async (sql, params) => {
    if (sql.includes('FROM products WHERE id')) return { rows: [{ id: 'p1' }], rowCount: 1 };
    if (sql.includes('INSERT INTO promos')) {
      seen.params = params;
      return { rows: [{ id: 'promo-1', code: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return seen;
}

const create = (body) =>
  auth(request(app()).post('/api/promos')).send({ business_id: 'biz-1', ...body });

const VALID = { code: 'SAVE10', type: 'percent', value: 10 };

test.beforeEach(() => { withQuery(async () => ({ rows: [], rowCount: 0 })); });

test('GET / lists a business promos, newest first', async () => {
  let seenSql;
  withQuery(async (sql) => { seenSql = sql; return { rows: [{ id: 'promo-1', code: 'SAVE10' }] }; });

  const res = await auth(request(app()).get('/api/promos').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, promos: [{ id: 'promo-1', code: 'SAVE10' }] });
  assert.match(seenSql, /ORDER BY created_at DESC/);
});

test('GET / requires a business_id and refuses another tenant', async () => {
  const missing = await auth(request(app()).get('/api/promos'));
  assert.equal(missing.status, 400);

  const cross = await auth(request(app()).get('/api/promos').query({ business_id: 'biz-2' }));
  assert.equal(cross.status, 403);
});

test('POST / upper-cases and stores a valid code', async () => {
  const seen = withCreate();

  const res = await create({ ...VALID, code: '  save10  ' });

  assert.equal(res.status, 201);
  assert.equal(seen.params[1], 'SAVE10', 'codes are case-insensitive to the customer');
});

test('a promo code must be 2-32 chars of letters, numbers, hyphen or underscore', async () => {
  for (const code of ['', 'X', 'A'.repeat(33), 'SAVE 10', 'SAVE!', 'SAVÉ']) {
    const res = await create({ ...VALID, code });
    assert.equal(res.status, 400, `code=${JSON.stringify(code)}`);
    assert.match(res.body.error, /code must be 2-32 chars/);
  }

  for (const code of ['AB', 'SAVE_10', 'NEW-YEAR', 'A'.repeat(32)]) {
    withCreate();
    const res = await create({ ...VALID, code });
    assert.equal(res.status, 201, `code=${code}`);
  }
});

test("type must be 'percent' or 'fixed'", async () => {
  const bad = await create({ ...VALID, type: 'freebie' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /'percent' or 'fixed'/);

  for (const type of ['percent', 'fixed']) {
    withCreate();
    assert.equal((await create({ ...VALID, type })).status, 201);
  }
});

test('value must be positive, and a percent cannot exceed 100', async () => {
  for (const value of [0, -5, 'abc']) {
    const res = await create({ ...VALID, value });
    assert.equal(res.status, 400, `value=${value}`);
  }

  // Above 100% the shop would owe the customer money.
  const over = await create({ ...VALID, type: 'percent', value: 150 });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /cannot exceed 100/);

  // A FIXED discount above 100 is just GH¢150 off — legitimate.
  withCreate();
  assert.equal((await create({ ...VALID, type: 'fixed', value: 150 })).status, 201);
});

test('max_uses, when given, must be a positive integer', async () => {
  for (const max_uses of [0, -1]) {
    const res = await create({ ...VALID, max_uses });
    assert.equal(res.status, 400, `max_uses=${max_uses}`);
  }

  // Absent or blank means unlimited, not zero.
  const seen = withCreate();
  assert.equal((await create({ ...VALID, max_uses: '' })).status, 201);
  assert.ok(seen.params.includes(null));
});

test('an unparseable expiry is rejected here, not left to Postgres', async () => {
  const res = await create({ ...VALID, expires_at: 'next tuesday' });

  // Otherwise it surfaces as a generic 500 with no useful message.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid date/);

  withCreate();
  assert.equal((await create({ ...VALID, expires_at: '2026-12-31' })).status, 201);
});

test('min_order_ghs must be non-negative', async () => {
  const res = await create({ ...VALID, min_order_ghs: -1 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /non-negative/);
});

test('customer_segment must be a known segment', async () => {
  const res = await create({ ...VALID, customer_segment: 'made_up' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /customer_segment must be one of/);
});

test("a promo cannot be scoped to another business's product", async () => {
  withQuery(async (sql) => {
    // The ownership probe finds nothing for this tenant.
    if (sql.includes('FROM products WHERE id')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });

  const res = await create({ ...VALID, product_id: 'someone-elses-product' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not belong to this business/);
});

test('a duplicate code is a 409, not a 500', async () => {
  withQuery(async (sql) => {
    if (sql.includes('INSERT INTO promos')) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    return { rows: [], rowCount: 0 };
  });

  const res = await create(VALID);

  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('PATCH toggles active and requires a boolean', async () => {
  let updated;
  withQuery(async (sql, params) => {
    // rowCount matters: the route 404s on a promo the UPDATE did not match,
    // which is also how it enforces business_id ownership in the WHERE.
    if (sql.includes('UPDATE promos')) {
      updated = params;
      return { rows: [{ id: 'promo-1', active: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const ok = await auth(request(app()).patch('/api/promos/promo-1'))
    .send({ business_id: 'biz-1', active: false });
  assert.equal(ok.status, 200);
  assert.ok(updated.includes(false));

  const bad = await auth(request(app()).patch('/api/promos/promo-1'))
    .send({ business_id: 'biz-1', active: 'yes' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /active \(boolean\) is required/);
});

test("PATCH 404s a promo that is not this business's", async () => {
  // Ownership is enforced by the UPDATE's own WHERE business_id clause, so a
  // cross-tenant id simply matches nothing.
  withQuery(async (sql) => (sql.includes('UPDATE promos')
    ? { rows: [], rowCount: 0 }
    : { rows: [], rowCount: 0 }));

  const res = await auth(request(app()).patch('/api/promos/someone-elses'))
    .send({ business_id: 'biz-1', active: false });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Promo not found');
});

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('DSN password=hunter2'); });

  const res = await auth(request(app()).get('/api/promos').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});
