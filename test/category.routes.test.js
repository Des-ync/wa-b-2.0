const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * category.routes is the first group migrated to the shared response +
 * validation layer. The contract this suite defends is that the migration is
 * INVISIBLE to existing clients: every legacy assertion below describes the
 * behaviour of the route BEFORE it was touched, and must keep passing for as
 * long as public/dashboard.html and any deployed mobile build are in the
 * field. The v2 assertions describe what a client gets once it opts in.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
db.query = (...a) => currentQuery(...a);
db.transaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });

const categoryRoutes = require('../src/routes/category.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};
// An admin key is pinned to no business, so it is the only caller that can
// actually reach the "business_id required" branch — a tenant key always
// falls back to its own.
const ADMIN_KEY_ROW = {
  id: 'key2', business_id: null, scope: 'admin', role: 'owner', revoked_at: null
};
let keyRow = TENANT_KEY_ROW;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/categories', categoryRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [keyRow] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');
const v2 = (r) => auth(r).set('X-API-Version', '2');

// Default: the key lookup resolves, everything else returns nothing. Tests
// that need real rows call withQuery to override.
test.beforeEach(() => { keyRow = TENANT_KEY_ROW; withQuery(async () => ({ rows: [] })); });

test('GET / legacy shape is unchanged by the migration', async () => {
  withQuery(async () => ({ rows: [{ id: 'c1', name: 'drinks', sort_order: 0, hidden: false }] }));

  const res = await auth(request(app()).get('/api/categories').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true,
    categories: [{ id: 'c1', name: 'drinks', sort_order: 0, hidden: false }]
  });
});

test('GET / v2 nests the same data under data', async () => {
  withQuery(async () => ({ rows: [{ id: 'c1', name: 'drinks', sort_order: 0, hidden: false }] }));

  const res = await v2(request(app()).get('/api/categories').query({ business_id: 'biz-1' }));

  assert.deepEqual(res.body, {
    success: true,
    data: { categories: [{ id: 'c1', name: 'drinks', sort_order: 0, hidden: false }] }
  });
});

test('a tenant key with no business_id in the query falls back to its own', async () => {
  withQuery(async () => ({ rows: [] }));
  const res = await auth(request(app()).get('/api/categories'));
  assert.equal(res.status, 200, 'a tenant key is already pinned to a business');
});

test('a missing business_id is a 400 in both envelopes', async () => {
  keyRow = ADMIN_KEY_ROW;
  const legacy = await auth(request(app()).get('/api/categories'));
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.error, 'business_id required');

  const modern = await v2(request(app()).get('/api/categories'));
  assert.equal(modern.status, 400);
  assert.equal(modern.body.error.code, 'validation_error');
  assert.equal(modern.body.error.fields.business_id, 'is required');
});

test("another tenant's business_id is refused with the same message as before", async () => {
  const res = await auth(request(app()).get('/api/categories').query({ business_id: 'biz-2' }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Key does not match business');
});

test('POST / normalizes the name and returns 201', async () => {
  let inserted;
  withQuery(async (sql, params) => {
    if (sql.includes('INSERT INTO categories')) {
      inserted = params;
      return { rows: [{ id: 'c1', name: params[1], sort_order: params[2], hidden: params[3] }] };
    }
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/categories'))
    .send({ business_id: 'biz-1', name: '  DRINKS  ', sort_order: 3 });

  assert.equal(res.status, 201);
  // Trimmed and lower-cased, exactly as before — the name is the join key
  // against products.category free text.
  assert.deepEqual(inserted, ['biz-1', 'drinks', 3, false]);
  assert.equal(res.body.category.name, 'drinks');
});

test('POST / defaults sort_order and hidden when omitted', async () => {
  let inserted;
  withQuery(async (sql, params) => {
    if (sql.includes('INSERT INTO categories')) { inserted = params; return { rows: [{}] }; }
    return { rows: [] };
  });

  await auth(request(app()).post('/api/categories')).send({ business_id: 'biz-1', name: 'meals' });

  assert.deepEqual(inserted, ['biz-1', 'meals', 0, false]);
});

test('POST / rejects an empty name, and v2 says which field', async () => {
  const legacy = await auth(request(app()).post('/api/categories'))
    .send({ business_id: 'biz-1', name: '   ' });
  assert.equal(legacy.status, 400);
  assert.equal(typeof legacy.body.error, 'string');

  const modern = await v2(request(app()).post('/api/categories'))
    .send({ business_id: 'biz-1', name: '   ' });
  assert.equal(modern.body.error.fields.name, 'is required');
});

test('POST / rejects a non-integer sort_order', async () => {
  const res = await v2(request(app()).post('/api/categories'))
    .send({ business_id: 'biz-1', name: 'meals', sort_order: 1.5 });

  assert.equal(res.status, 400);
  assert.match(res.body.error.fields.sort_order, /whole number/);
});

test('POST / reports every bad field at once, not just the first', async () => {
  const res = await v2(request(app()).post('/api/categories'))
    .send({ business_id: 'biz-1', name: '', sort_order: 'x' });

  // The concrete win of the validation layer: a form can mark both inputs.
  assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['name', 'sort_order']);
});

test('PATCH updates only the fields sent', async () => {
  let updateSql; let updateParams;
  withQuery(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM categories')) {
      return { rows: [{ id: 'c1', business_id: 'biz-1', name: 'drinks' }] };
    }
    if (sql.startsWith('UPDATE categories')) {
      updateSql = sql; updateParams = params;
      return { rows: [{ id: 'c1', hidden: true }] };
    }
    return { rows: [] };
  });

  const res = await auth(request(app()).patch('/api/categories/c1')).send({ hidden: true });

  assert.equal(res.status, 200);
  assert.match(updateSql, /SET hidden = \$2/);
  assert.ok(!updateSql.includes('name ='), 'an omitted field must not be written');
  assert.deepEqual(updateParams, ['c1', true]);
});

test('PATCH with no recognised fields is a 400', async () => {
  withQuery(async (sql) => (sql.startsWith('SELECT * FROM categories')
    ? { rows: [{ id: 'c1', business_id: 'biz-1' }] }
    : { rows: [] }));

  const res = await auth(request(app()).patch('/api/categories/c1')).send({ nonsense: 1 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'No fields to update');
});

test('PATCH rejects an explicitly emptied name but allows omitting it', async () => {
  withQuery(async (sql) => (sql.startsWith('SELECT * FROM categories')
    ? { rows: [{ id: 'c1', business_id: 'biz-1' }] }
    : { rows: [{ id: 'c1' }] }));

  const emptied = await v2(request(app()).patch('/api/categories/c1')).send({ name: '' });
  assert.equal(emptied.status, 400);
  assert.equal(emptied.body.error.fields.name, 'is required');

  const omitted = await auth(request(app()).patch('/api/categories/c1')).send({ sort_order: 2 });
  assert.equal(omitted.status, 200);
});

test('PATCH and DELETE 404 on an unknown id', async () => {
  withQuery(async () => ({ rows: [] }));

  const patched = await auth(request(app()).patch('/api/categories/nope')).send({ hidden: true });
  assert.equal(patched.status, 404);
  assert.equal(patched.body.error, 'Category not found');

  const deleted = await auth(request(app()).delete('/api/categories/nope'));
  assert.equal(deleted.status, 404);
});

test("DELETE refuses another tenant's category", async () => {
  withQuery(async () => ({ rows: [{ id: 'c1', business_id: 'biz-OTHER' }] }));

  const res = await auth(request(app()).delete('/api/categories/c1'));
  assert.equal(res.status, 403);
});

test('DELETE legacy returns a bare success envelope', async () => {
  withQuery(async (sql) => (sql.startsWith('SELECT * FROM categories')
    ? { rows: [{ id: 'c1', business_id: 'biz-1' }] }
    : { rows: [] }));

  const res = await auth(request(app()).delete('/api/categories/c1'));

  assert.deepEqual(res.body, { success: true });
});

test('reorder writes each name at its index, inside one transaction', async () => {
  const upserts = [];
  withQuery(async (sql, params) => {
    if (sql.includes('INSERT INTO categories')) { upserts.push(params); return { rows: [] }; }
    if (sql.startsWith('SELECT * FROM categories')) return { rows: [{ id: 'c1' }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/categories/reorder'))
    .send({ business_id: 'biz-1', order: ['Meals', ' DRINKS ', 'sides'] });

  assert.equal(res.status, 200);
  assert.deepEqual(upserts, [
    ['biz-1', 'meals', 0],
    ['biz-1', 'drinks', 1],
    ['biz-1', 'sides', 2]
  ]);
});

test('reorder rejects an empty, non-array, or over-long list', async () => {
  for (const order of [[], 'nope', undefined]) {
    const res = await auth(request(app()).post('/api/categories/reorder'))
      .send({ business_id: 'biz-1', order });
    assert.equal(res.status, 400, `order=${JSON.stringify(order)}`);
  }

  // Over-long must be REFUSED, not silently truncated — reordering the first
  // 200 of 250 categories and reporting success is worse than saying no.
  const tooMany = await auth(request(app()).post('/api/categories/reorder'))
    .send({ business_id: 'biz-1', order: Array.from({ length: 201 }, (_, i) => `c${i}`) });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /max 200/);
});

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('password=hunter2 in connection string'); });

  const res = await v2(request(app()).get('/api/categories').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 500);
  assert.equal(res.body.error.message, 'Internal server error');
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});
