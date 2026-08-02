const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { _testing } = require('../src/routes/product.routes');
const { copyNameFor } = _testing;

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'product.routes.js'), 'utf8');
const DUP = SRC.slice(SRC.indexOf("router.post('/:id/duplicate'"),
                      SRC.indexOf("router.patch('/bulk'"));

/**
 * Duplicating a product.
 *
 * The value is the variants and add-ons — re-keying a few fields is a minute's
 * work, re-entering eight sizes and four extras is what makes a merchant not
 * bother. So the tests are mostly about what must NOT be carried over, because
 * copying too much is the failure that is hard to notice.
 */

test('the copy gets a distinguishable name', () => {
  assert.equal(copyNameFor('Jollof Rice', ['Jollof Rice']), 'Jollof Rice (copy)');
});

test('duplicating repeatedly counts up rather than colliding', () => {
  const taken = ['Jollof Rice', 'Jollof Rice (copy)'];
  assert.equal(copyNameFor('Jollof Rice', taken), 'Jollof Rice (copy 2)');
  assert.equal(copyNameFor('Jollof Rice', [...taken, 'Jollof Rice (copy 2)']),
    'Jollof Rice (copy 3)');
});

test('name matching is case-insensitive', () => {
  // Two products differing only in case read as identical in a list.
  assert.equal(copyNameFor('Shito', ['shito', 'SHITO (COPY)']), 'Shito (copy 2)');
});

test('a long name still yields a name the edit form would accept', () => {
  // `name` is capped at 200 by PRODUCT_SCHEMA. A copy the normal form then
  // refuses to save would be a trap.
  const long = 'x'.repeat(250);
  assert.ok(copyNameFor(long, []).length <= 200);
});

test('a missing name does not produce "undefined (copy)"', () => {
  assert.equal(copyNameFor(null, []), 'Product (copy)');
  assert.equal(copyNameFor('', []), 'Product (copy)');
});

test('the copy is created hidden', () => {
  // It shares the original's name stem, price and photo. Publishing it the
  // instant it exists puts two near-identical items in front of customers
  // while the merchant is still editing.
  assert.match(DUP, /\/\/ Hidden regardless of the original/);
  assert.match(DUP, /hidden: true/);
});

test('stock tracking is copied but the COUNT is not', () => {
  // A copy of "Large, 7 in stock" made to become "Small" has not got seven of
  // anything. Inheriting the number invents inventory the bot then decrements
  // on payment.
  assert.match(DUP, /original\.stock_qty === null \? null : 0/);
  // Same rule for variants, which carry their own counts.
  assert.match(DUP, /CASE WHEN stock_qty IS NULL THEN NULL ELSE 0 END/);
});

test('variants and add-ons are copied', () => {
  assert.match(DUP, /INSERT INTO product_variants/);
  assert.match(DUP, /INSERT INTO product_addons/);
});

test('the whole copy is one transaction', () => {
  // A product that arrives without its variants is worse than no copy at all,
  // because the gap is easy to miss.
  assert.match(DUP, /await transaction\(async client =>/);
});

test('low_stock_notified is not carried over', () => {
  // It is a "we already warned you" flag. Copied as true, the merchant never
  // gets the first low-stock warning for the new product.
  assert.ok(!/low_stock_notified/.test(DUP),
    'low_stock_notified must not be copied — it would suppress the first warning');
});

test('identity columns are not copied', () => {
  for (const col of ['created_at', 'updated_at']) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(DUP),
      `${col} must not be copied — the copy is a new row`);
  }
});

test('the duplicate route is scoped to the caller\'s business', () => {
  assert.match(DUP, /tenantBlocksBusinessId\(req, original\.business_id\)/);
});

test('requires products:write', () => {
  assert.match(SRC, /router\.post\('\/:id\/duplicate', requirePermission\('products', 'write'\)/);
});
