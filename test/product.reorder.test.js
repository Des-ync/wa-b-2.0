const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'product.routes.js'), 'utf8');
const REORDER = SRC.slice(SRC.indexOf("router.post('/reorder'"),
                          SRC.indexOf("router.post('/:id/duplicate'"));

/**
 * Catalogue ordering.
 *
 * Worth building only because both customer-facing surfaces honour
 * `products.sort_order` — a reorder that rearranged nothing but the admin
 * table would be close to pointless. These tests pin that relationship, so a
 * future change to either ORDER BY does not quietly make the feature cosmetic.
 */

test('the storefront orders products by sort_order', () => {
  const sf = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'storefront.routes.js'), 'utf8');
  assert.match(sf, /ORDER BY featured DESC, sort_order ASC, name ASC/,
    'storefront no longer honours sort_order — reordering would be cosmetic');
});

test("the bot's catalogue orders by sort_order too", () => {
  const bot = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'conversation.handler.js'), 'utf8');
  assert.match(bot, /p\.sort_order ASC/,
    'the WhatsApp catalogue no longer honours sort_order');
});

test('sort_order ranks BELOW featured and popularity in the bot', () => {
  // Not a defect — but it is why the UI warns that dragging to the top does
  // not necessarily put an item first in WhatsApp. If this ever changes, the
  // hint in dashboard.html is wrong and should change with it.
  const bot = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'conversation.handler.js'), 'utf8');
  const m = bot.match(/ORDER BY p\.featured DESC, COALESCE\(pop\.order_count, 0\) DESC,[\s\S]{0,120}?p\.sort_order ASC/);
  assert.ok(m, 'expected featured and popularity to precede p.sort_order');
});

test('the dashboard says so, rather than letting it surprise a merchant', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /Featured products\s*\n?\s*still come first/);
  assert.match(html, /what sells most is shown before your/);
});

test('reorder is declared before any /:id-shaped POST route', () => {
  const reorder = SRC.indexOf("router.post('/reorder'");
  const byId = SRC.indexOf("router.post('/:id/duplicate'");
  assert.ok(reorder > -1 && byId > -1);
  assert.ok(reorder < byId, '"reorder" must not be reachable as a product id');
});

test('the update is scoped by business_id, not just the supplied ids', () => {
  assert.match(REORDER,
    /UPDATE products SET sort_order = \$3 WHERE business_id = \$1 AND id = \$2/);
});

test('the whole reorder is one transaction', () => {
  // A failure partway leaves the catalogue in an order the merchant never
  // chose and cannot reconstruct.
  assert.match(REORDER, /await transaction\(async client =>/);
});

test('the list is capped', () => {
  assert.match(SRC, /const REORDER_MAX = \d+/);
  assert.match(REORDER, /order\.length > REORDER_MAX/);
});

test('an empty order is rejected rather than silently doing nothing', () => {
  assert.match(REORDER, /order must be a non-empty array of product ids/);
});

test('requires products:write', () => {
  assert.match(SRC, /router\.post\('\/reorder', requirePermission\('products', 'write'\)/);
});

test('reordering is reachable without a mouse', () => {
  // HTML5 drag-and-drop does not work on touch, and this dashboard is used on
  // phones; drag alone is also unreachable from a keyboard.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  assert.match(js, /data-click="moveProduct"/, 'no arrow-button fallback for touch/keyboard');
  assert.match(js, /aria-label="Move \$\{esc\(p\.name\)\} up"/);
});
