const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'product.routes.js'), 'utf8');

/**
 * Bulk product edit.
 *
 * Three things here are load-bearing and none of them are visible at a glance,
 * so they are asserted against the source rather than left to review:
 *
 *  1. `/bulk` must be declared BEFORE `/:id`, or Express matches it as a
 *     product whose id is the literal string "bulk" and the endpoint 404s.
 *  2. The statement must be scoped by `business_id`, not just by the ids the
 *     caller sent — otherwise a tenant could edit another tenant's products by
 *     naming their ids.
 *  3. Only a short list of fields may be set in bulk. One `name` or
 *     `image_url` across a selection is not an edit, it is data loss.
 */

function indexOfRoute(pathLiteral) {
  return SRC.indexOf(`router.patch('${pathLiteral}'`);
}

test("/bulk is declared before /:id, or it would never be reached", () => {
  const bulk = indexOfRoute('/bulk');
  const byId = indexOfRoute('/:id');
  assert.ok(bulk > -1, 'no PATCH /bulk route');
  assert.ok(byId > -1, 'no PATCH /:id route');
  assert.ok(bulk < byId,
    'PATCH /bulk must come before PATCH /:id — otherwise "bulk" is read as a product id');
});

test('the update is scoped by business_id in the statement itself', () => {
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /UPDATE products SET[\s\S]*WHERE business_id = \$1 AND id = ANY/,
    'bulk UPDATE must filter on business_id, not only on the supplied ids');
});

test('the pre-read is scoped by business_id too', () => {
  // It decides who gets a back-in-stock message. Unscoped, another tenant's
  // ids could influence that.
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /SELECT id, in_stock FROM products WHERE business_id = \$1 AND id = ANY/);
});

test('only safe fields are bulk-editable', () => {
  const m = SRC.match(/const BULK_EDITABLE = \[([^\]]*)\]/);
  assert.ok(m, 'BULK_EDITABLE not found');
  const allowed = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);

  assert.deepEqual(allowed.sort(), [
    'category', 'featured', 'hidden', 'in_stock', 'low_stock_threshold', 'supplier_id'
  ]);

  // The ones whose absence is the point. Applying a single value for any of
  // these across a selection destroys per-product data.
  for (const forbidden of ['name', 'image_url', 'description', 'price_ghs', 'stock_qty', 'sort_order']) {
    assert.ok(!allowed.includes(forbidden),
      `${forbidden} must NOT be bulk-editable — one value across a selection is data loss`);
  }
});

test('unknown fields are rejected rather than silently dropped', () => {
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /rejected[\s\S]*BULK_EDITABLE\.includes/);
  assert.match(body, /cannot be changed in bulk/);
});

test('changes go through the same validator as a single edit', () => {
  // Bulk must not become a way to write a value the single path would refuse.
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /validateProductBody\(req\.body\?\.changes \|\| \{\}, \{ partial: true \}\)/);
});

test('the selection is capped', () => {
  const m = SRC.match(/const BULK_MAX_IDS = (\d+)/);
  assert.ok(m, 'BULK_MAX_IDS not found');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 500);
});

test('back-in-stock notifications fire, and their count is reported', () => {
  // Those customers asked to be told, so suppressing would mean they never
  // hear. Reporting the count is what stops it being a silent surprise with a
  // WhatsApp bill attached.
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /notifyProductRestocked/);
  assert.match(body, /notified/);
  // Only for products that were actually out of stock before.
  assert.match(body, /wasOut/);
});

test('a failing notification does not fail the whole edit', () => {
  const body = SRC.slice(indexOfRoute('/bulk'), indexOfRoute('/:id'));
  assert.match(body, /catch \(err\) \{[\s\S]*bulk restock notify failed/);
});

test('requires products:write, like every other mutating product route', () => {
  assert.match(SRC, /router\.patch\('\/bulk', requirePermission\('products', 'write'\)/);
});
