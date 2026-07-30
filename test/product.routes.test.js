const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

/**
 * product.routes.js had NO test suite, and it is where the three hand-rolled
 * validators that `src/utils/validate.js` was generalized from live. This
 * suite is written FIRST, against the routes exactly as they behave today, so
 * that swapping those validators out is a refactor with a safety net rather
 * than a rewrite on faith.
 *
 * Every assertion here therefore describes CURRENT behaviour — including the
 * quirks (truncate-don't-reject on long strings, `stock_qty` implying
 * `in_stock`, semicolon-joined error strings). If a quirk is wrong, that is a
 * separate decision; this file's job is to prove the migration changed
 * nothing.
 */

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
db.query = (...a) => currentQuery(...a);
// product.routes destructures { transaction } at require time, so the stub
// has to delegate to a swappable variable — reassigning db.transaction later
// would not change what the module already captured.
let currentTransaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });
db.transaction = (...a) => currentTransaction(...a);

const automations = require('../src/services/automations');
let restockCalls = [];
automations.notifyProductRestocked = async (p) => { restockCalls.push(p); };

const productRoutes = require('../src/routes/product.routes');

const TENANT_KEY_ROW = {
  id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/products', productRoutes);
  return a;
}

function withQuery(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

const auth = (r) => r.set('Authorization', 'Bearer sk_live_abc');

/** Captures the column/value pairs an INSERT or UPDATE was given. */
function captureWrite() {
  const seen = {};
  withQuery(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM products WHERE id')) {
      return { rows: [{ id: 'p1', business_id: 'biz-1', in_stock: true }] };
    }
    if (sql.includes('INSERT INTO products')) {
      seen.insert = params;
      return { rows: [{ id: 'p1' }] };
    }
    if (sql.startsWith('UPDATE products')) {
      seen.updateSql = sql; seen.updateParams = params;
      return { rows: [{ id: 'p1', in_stock: true }] };
    }
    return { rows: [] };
  });
  return seen;
}

test.beforeEach(() => {
  restockCalls = [];
  currentTransaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });
  withQuery(async () => ({ rows: [] }));
});

// ---------------------------------------------------------------- list/create

test('GET / lists a business products ordered for display', async () => {
  let seenSql;
  withQuery(async (sql) => {
    seenSql = sql;
    return { rows: [{ id: 'p1', name: 'Jollof' }] };
  });

  const res = await auth(request(app()).get('/api/products').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, products: [{ id: 'p1', name: 'Jollof' }] });
  assert.match(seenSql, /ORDER BY sort_order ASC, category ASC, name ASC/);
});

test("GET / refuses another tenant's business_id", async () => {
  const res = await auth(request(app()).get('/api/products').query({ business_id: 'biz-2' }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Key does not match business');
});

test('POST / creates with coerced values and documented defaults', async () => {
  const seen = captureWrite();

  const res = await auth(request(app()).post('/api/products'))
    .send({ name: '  Jollof Rice  ', price_ghs: '35.456', category: '  MEALS ' });

  assert.equal(res.status, 201);
  const [businessId, name, description, price, category, inStock, imageUrl,
    stockQty, lowStockThreshold, featured, hidden, sortOrder] = seen.insert;

  assert.equal(businessId, 'biz-1');
  assert.equal(name, 'Jollof Rice');            // trimmed
  assert.equal(price, 35.46);                   // rounded to pesewas
  assert.equal(category, 'meals');              // trimmed + lower-cased
  assert.equal(description, null);
  assert.equal(inStock, true);                  // default
  assert.equal(imageUrl, null);
  assert.equal(stockQty, null);                 // untracked by default
  assert.equal(lowStockThreshold, 3);           // default
  assert.equal(featured, false);
  assert.equal(hidden, false);
  assert.equal(sortOrder, 0);
});

test('POST / requires a name and a price', async () => {
  const noName = await auth(request(app()).post('/api/products')).send({ price_ghs: 10 });
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /name is required/);

  const noPrice = await auth(request(app()).post('/api/products')).send({ name: 'x' });
  assert.equal(noPrice.status, 400);
  assert.match(noPrice.body.error, /price_ghs must be a non-negative number/);
});

test('POST / rejects a negative price but allows zero', async () => {
  const negative = await auth(request(app()).post('/api/products'))
    .send({ name: 'x', price_ghs: -1 });
  assert.equal(negative.status, 400);

  captureWrite();
  const free = await auth(request(app()).post('/api/products'))
    .send({ name: 'Free sample', price_ghs: 0 });
  assert.equal(free.status, 201, 'a zero-price giveaway is legitimate');
});

test('POST / reports several problems in one response', async () => {
  const res = await auth(request(app()).post('/api/products'))
    .send({ name: '', price_ghs: 'abc', sort_order: 1.5 });

  assert.equal(res.status, 400);
  // Today: prose joined with '; '. The migration must keep this readable
  // string for legacy callers even once field-level errors exist.
  assert.match(res.body.error, /;/);
  assert.match(res.body.error, /name/);
  assert.match(res.body.error, /price_ghs/);
});

test('POST / truncates an over-long description rather than refusing', async () => {
  const seen = captureWrite();

  const res = await auth(request(app()).post('/api/products'))
    .send({ name: 'x', price_ghs: 1, description: 'd'.repeat(5000) });

  assert.equal(res.status, 201, 'a long description must not lose the whole product');
  assert.equal(seen.insert[2].length, 1000);
});

test('POST / rejects an over-long name outright', async () => {
  const res = await auth(request(app()).post('/api/products'))
    .send({ name: 'n'.repeat(201), price_ghs: 1 });

  // Asymmetric with description on purpose: the name is the thing customers
  // match against in chat.
  assert.equal(res.status, 400);
});

test('POST / validates the availability window format', async () => {
  const bad = await auth(request(app()).post('/api/products'))
    .send({ name: 'x', price_ghs: 1, available_from: '25:00' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /HH:MM/);

  captureWrite();
  const good = await auth(request(app()).post('/api/products'))
    .send({ name: 'x', price_ghs: 1, available_from: '08:30', available_to: '20:00' });
  assert.equal(good.status, 201);
});

// ------------------------------------------------------------------- stock_qty

test('setting stock_qty above zero implies in_stock', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ stock_qty: 5 });

  assert.match(seen.updateSql, /in_stock = /);
  assert.ok(seen.updateParams.includes(true));
});

test('setting stock_qty to zero implies out of stock', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ stock_qty: 0 });

  assert.match(seen.updateSql, /in_stock = /);
  assert.ok(seen.updateParams.includes(false));
});

test('an explicit in_stock always beats the stock_qty inference', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ stock_qty: 0, in_stock: true });

  assert.match(seen.updateSql, /in_stock = /);
  assert.ok(seen.updateParams.includes(true),
    'an explicit in_stock:true must survive stock_qty:0');
  assert.ok(!seen.updateParams.includes(false));
});

test('restocking above zero clears the low-stock nudge flag', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ stock_qty: 9 });

  // So a future dip notifies again rather than staying silent.
  assert.match(seen.updateSql, /low_stock_notified = /);
  assert.ok(seen.updateParams.includes(false));
});

test('an empty stock_qty means untracked, not zero', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ stock_qty: '' });

  assert.ok(seen.updateParams.includes(null));
  assert.ok(!seen.updateSql.includes('in_stock'),
    'untracked stock must not flip the in_stock flag either way');
});

test('a fractional or negative stock_qty is rejected', async () => {
  for (const stock_qty of [1.5, -1]) {
    // The product must exist first — these routes 404 before they validate.
    captureWrite();
    const res = await auth(request(app()).patch('/api/products/p1')).send({ stock_qty });
    assert.equal(res.status, 400, `stock_qty=${stock_qty}`);
  }
});

// ----------------------------------------------------------------------- patch

test('PATCH writes only the fields sent', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ name: 'New name' });

  assert.match(seen.updateSql, /name = \$2/);
  assert.ok(!seen.updateSql.includes('price_ghs'));
});

test('PATCH with nothing recognised is a 400', async () => {
  withQuery(async (sql) => (sql.startsWith('SELECT * FROM products WHERE id')
    ? { rows: [{ id: 'p1', business_id: 'biz-1' }] }
    : { rows: [] }));

  const res = await auth(request(app()).patch('/api/products/p1')).send({ nonsense: 1 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'No fields to update');
});

test('PATCH 404s an unknown product and 403s another tenant', async () => {
  const missing = await auth(request(app()).patch('/api/products/nope')).send({ name: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Product not found');

  withQuery(async () => ({ rows: [{ id: 'p1', business_id: 'biz-OTHER' }] }));
  const cross = await auth(request(app()).patch('/api/products/p1')).send({ name: 'x' });
  assert.equal(cross.status, 403);
});

test('coming back into stock fires the back-in-stock automation once', async () => {
  withQuery(async (sql) => {
    if (sql.startsWith('SELECT * FROM products WHERE id')) {
      return { rows: [{ id: 'p1', business_id: 'biz-1', in_stock: false }] };
    }
    if (sql.startsWith('UPDATE products')) return { rows: [{ id: 'p1', in_stock: true }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).patch('/api/products/p1')).send({ in_stock: true });

  assert.equal(res.status, 200);
  assert.equal(restockCalls.length, 1);
  assert.equal(restockCalls[0].id, 'p1');
});

test('staying in stock does not re-fire the automation', async () => {
  withQuery(async (sql) => {
    if (sql.startsWith('SELECT * FROM products WHERE id')) {
      return { rows: [{ id: 'p1', business_id: 'biz-1', in_stock: true }] };
    }
    if (sql.startsWith('UPDATE products')) return { rows: [{ id: 'p1', in_stock: true }] };
    return { rows: [] };
  });

  await auth(request(app()).patch('/api/products/p1')).send({ name: 'x' });

  assert.equal(restockCalls.length, 0);
});

// -------------------------------------------------------------------- variants

/** These routes resolve the parent product before validating the body. */
function withProduct(extra = async () => ({ rows: [] })) {
  withQuery(async (sql, params) => {
    if (sql.includes('FROM products WHERE id')) return { rows: [{ id: 'p1', business_id: 'biz-1' }] };
    return extra(sql, params);
  });
}

test('a variant requires a name and rounds its price delta', async () => {
  withProduct();
  const bad = await auth(request(app()).post('/api/products/p1/variants')).send({ name: '' });
  assert.equal(bad.status, 400);

  let inserted;
  withProduct(async (sql, params) => {
    if (sql.includes('INSERT INTO product_variants')) { inserted = params; return { rows: [{ id: 'v1' }] }; }
    return { rows: [] };
  });

  const ok = await auth(request(app()).post('/api/products/p1/variants'))
    .send({ name: 'Large', price_delta_ghs: '2.567' });

  assert.equal(ok.status, 201);
  assert.ok(inserted.includes(2.57));
});

test('a variant price delta may be negative — a smaller size costs less', async () => {
  withProduct(async (sql, params) => (sql.includes('INSERT INTO product_variants')
    ? { rows: [{ id: 'v1', price_delta_ghs: params[3] }] }
    : { rows: [] }));

  const res = await auth(request(app()).post('/api/products/p1/variants'))
    .send({ name: 'Small', price_delta_ghs: -5 });

  assert.equal(res.status, 201);
});

// ---------------------------------------------------------------------- addons

test('an add-on rejects a negative price, unlike a variant delta', async () => {
  withProduct();
  // Variants adjust a base price and may go down; an add-on IS a price.
  const res = await auth(request(app()).post('/api/products/p1/addons'))
    .send({ name: 'Extra chicken', price_ghs: -1 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /non-negative/);
});

test('an add-on requires a name', async () => {
  withProduct();
  const res = await auth(request(app()).post('/api/products/p1/addons')).send({ price_ghs: 5 });
  assert.equal(res.status, 400);
});

// ----------------------------------------------------------------------- misc

test('an unexpected database error is a 500 that leaks nothing', async () => {
  withQuery(async () => { throw new Error('DSN password=hunter2'); });

  const res = await auth(request(app()).get('/api/products').query({ business_id: 'biz-1' }));

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal server error');
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});

// ---------------------------------------------------------------------- bundles

/**
 * These cover the path that was briefly broken during the validator swap: the
 * bundle routes referenced a `fields` variable their destructure never
 * declared, so any invalid bundle body threw a ReferenceError inside the try,
 * the catch threw again, and the request HUNG. Nothing tested it, so the
 * whole suite stayed green.
 */
test('POST /bundles requires a name, a price and at least one item', async () => {
  const res = await auth(request(app()).post('/api/products/bundles'))
    .send({ business_id: 'biz-1', name: 'Combo', price_ghs: 20 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /items is required/);
});

test('POST /bundles rejects an item with no product_id', async () => {
  const res = await auth(request(app()).post('/api/products/bundles'))
    .send({ business_id: 'biz-1', name: 'Combo', price_ghs: 20, items: [{ quantity: 2 }] });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /every item needs a product_id/);
});

test('POST /bundles rejects an empty items array', async () => {
  const res = await auth(request(app()).post('/api/products/bundles'))
    .send({ business_id: 'biz-1', name: 'Combo', price_ghs: 20, items: [] });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /non-empty array/);
});

test('a bundle item with no quantity defaults to one of each', async () => {
  const inserted = [];
  withQuery(async (sql, params) => {
    // replaceBundleItems verifies every product belongs to this business
    // before writing anything.
    if (sql === 'SELECT id FROM products WHERE business_id = $1') {
      return { rows: [{ id: 'p1' }, { id: 'p2' }] };
    }
    if (sql.includes('INSERT INTO product_bundles')) return { rows: [{ id: 'b1' }] };
    if (sql.includes('INSERT INTO product_bundle_items')) { inserted.push(params); return { rows: [] }; }
    if (sql.includes('FROM product_bundles')) return { rows: [{ id: 'b1' }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/products/bundles')).send({
    business_id: 'biz-1', name: 'Combo', price_ghs: 20,
    items: [{ product_id: 'p1' }, { product_id: 'p2', quantity: 3 }]
  });

  assert.equal(res.status, 201);
  // [bundle_id, product_id, quantity]
  assert.deepEqual(inserted.map(p => [p[1], p[2]]), [['p1', 1], ['p2', 3]]);
});

test('a bundle referencing another business product is refused, not written', async () => {
  withQuery(async (sql) => {
    if (sql === 'SELECT id FROM products WHERE business_id = $1') return { rows: [{ id: 'p1' }] };
    if (sql.includes('INSERT INTO product_bundles')) return { rows: [{ id: 'b1' }] };
    return { rows: [] };
  });

  const res = await auth(request(app()).post('/api/products/bundles')).send({
    business_id: 'biz-1', name: 'Combo', price_ghs: 20,
    items: [{ product_id: 'p1' }, { product_id: 'SOMEONE-ELSES' }]
  });

  // Thrown with a tagged status, so it stays a 400 rather than becoming a
  // 500 — that distinction survives the response migration.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /do not belong to this business/);
});

test('v2 reports which bundle field was wrong', async () => {
  const res = await auth(request(app()).post('/api/products/bundles'))
    .set('X-API-Version', '2')
    .send({ business_id: 'biz-1', name: '', price_ghs: -5, items: [] });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.deepEqual(Object.keys(res.body.error.fields).sort(),
    ['items', 'name', 'price_ghs']);
});

// ------------------------------------------------------------------- import

/**
 * CSV import: the dry run, and the transaction.
 *
 * A merchant pasting a spreadsheet has no way to discover that column 3 is
 * the wrong one until their catalogue is already wrong — and unlike one bad
 * product, a bad import is two hundred of them.
 */
function withImport({ owned = [], onWrite } = {}) {
  const writes = [];
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    if (sql === 'SELECT id FROM products WHERE business_id = $1') {
      return { rows: owned.map(id => ({ id })) };
    }
    writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (onWrite) onWrite(sql);
    return { rows: [], rowCount: 1 };
  };
  return writes;
}

const CSV_HEADER = 'name,price_ghs,category';
const importCsv = (csv, extra = {}) =>
  auth(request(app()).post('/api/products/import'))
    .send({ business_id: 'biz-1', csv, ...extra });

test('a dry run reports what would happen and writes NOTHING', async () => {
  const writes = withImport();

  const res = await importCsv(
    `${CSV_HEADER}\nJollof,40,mains\nWaakye,25,mains`, { dry_run: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.created, 2);
  assert.equal(res.body.updated, 0);
  assert.equal(res.body.preview.length, 2);
  assert.equal(res.body.preview[0].name, 'Jollof');
  assert.equal(res.body.preview[0].action, 'create');
  // Row numbers are 1-based INCLUDING the header, so they match what the
  // merchant sees in their spreadsheet.
  assert.equal(res.body.preview[0].row, 2);

  assert.deepEqual(writes.filter(w => /INSERT INTO products|UPDATE products/.test(w.sql)), [],
    'a dry run that writes is not a dry run');
});

test('a dry run tells the merchant which columns each row would change', async () => {
  withImport();

  const res = await importCsv(`${CSV_HEADER}\nJollof,40,mains`, { dry_run: true });

  // The difference between "200 updates" and "200 updates that all blank
  // your descriptions".
  assert.ok(res.body.preview[0].fields.includes('name'));
  assert.ok(res.body.preview[0].fields.includes('price_ghs'));
});

test('a dry run separates rows it would skip, with the reason', async () => {
  withImport();

  const res = await importCsv(
    `${CSV_HEADER}\nJollof,40,mains\n,notanumber,mains`, { dry_run: true });

  assert.equal(res.body.created, 1);
  assert.equal(res.body.skipped_count, 1);
  assert.equal(res.body.skipped[0].row, 3);
  assert.ok(res.body.skipped[0].errors.length > 0);
});

test('a dry run marks a row with a known id as an update, not a create', async () => {
  withImport({ owned: ['11111111-1111-1111-1111-111111111111'] });

  const res = await importCsv(
    'id,name,price_ghs\n11111111-1111-1111-1111-111111111111,Jollof,45',
    { dry_run: true });

  assert.equal(res.body.updated, 1);
  assert.equal(res.body.created, 0);
  assert.equal(res.body.preview[0].action, 'update');
});

test("a row with another business's id is treated as a create, never an update", async () => {
  // The ownership set is the only thing standing between a crafted CSV and
  // overwriting another tenant's catalogue by guessing UUIDs.
  withImport({ owned: [] });

  const res = await importCsv(
    'id,name,price_ghs\n99999999-9999-9999-9999-999999999999,Hijack,1',
    { dry_run: true });

  assert.equal(res.body.updated, 0);
  assert.equal(res.body.preview[0].action, 'create');
});

test('a large preview is capped but the counts still cover the whole file', async () => {
  withImport();
  const rows = Array.from({ length: 120 }, (_, i) => `Item ${i},10,mains`).join('\n');

  const res = await importCsv(`${CSV_HEADER}\n${rows}`, { dry_run: true });

  assert.equal(res.body.created, 120, 'the count describes the whole file');
  assert.equal(res.body.preview.length, 50, 'the preview is readable');
  assert.equal(res.body.preview_truncated, true);
});

test('a real import writes inside ONE transaction', async () => {
  let transactionUsed = false;
  currentTransaction = async (cb) => {
    transactionUsed = true;
    return cb({ query: (...a) => currentQuery(...a) });
  };
  withImport();

  const res = await importCsv(`${CSV_HEADER}\nJollof,40,mains\nWaakye,25,mains`);

  assert.equal(res.status, 200);
  assert.equal(res.body.created, 2);
  // Row-by-row writes meant a failure on row 150 of 200 left 149 products
  // written, a 500 returned, and no way to tell which.
  assert.equal(transactionUsed, true);
});

test('a failure part-way through rolls the whole file back', async () => {
  currentTransaction = async (cb) => {
    // Model a real transaction: the caller's throw propagates and nothing
    // the callback did is kept.
    return cb({
      query: async (sql) => {
        if (sql.includes('INSERT INTO products')) throw new Error('deadlock detected');
        return { rows: [], rowCount: 1 };
      }
    });
  };
  withImport();

  const res = await importCsv(`${CSV_HEADER}\nJollof,40,mains`);

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal server error');
});

/**
 * Regression tests for the category fallback, found by differential-testing
 * the schema validators against the hand-rolled ones they replaced.
 *
 * The old validator did `String(body.category || 'general')... || 'general'`,
 * so an emptied category became 'general'. The schema returned '' instead.
 * The CREATE paths hid it behind their own `out.category || 'general'`
 * fallback — but PATCH writes the validated object straight into the UPDATE,
 * so clearing the field persisted an empty string, and the product then
 * grouped under nothing and matched no row in `categories`.
 */
test('clearing a category falls back to general, not an empty string', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ category: '' });

  const idx = seen.updateSql.indexOf('category');
  assert.ok(idx > 0, 'category should still be written');
  assert.ok(seen.updateParams.includes('general'),
    `expected the general fallback, got ${JSON.stringify(seen.updateParams)}`);
  assert.ok(!seen.updateParams.includes(''),
    'an empty category groups the product under nothing');
});

test('a real category is still normalized, not replaced', async () => {
  const seen = captureWrite();

  await auth(request(app()).patch('/api/products/p1')).send({ category: '  DRINKS ' });

  assert.ok(seen.updateParams.includes('drinks'));
});

test('creating with an empty category also lands on general', async () => {
  const seen = captureWrite();

  await auth(request(app()).post('/api/products'))
    .send({ name: 'X', price_ghs: 10, category: '' });

  // Position 4 in the INSERT column list.
  assert.equal(seen.insert[4], 'general');
});
