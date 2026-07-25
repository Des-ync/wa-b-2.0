/**
 * Static guards against the two XSS shapes this frontend has actually shipped.
 *
 * 1. Untrusted values interpolated into innerHTML without esc().
 * 2. esc()'d values placed inside an inline onclick's JS string literal. That
 *    one looks safe and isn't: esc() turns `'` into `&#39;`, and the browser
 *    HTML-decodes the attribute back to `'` BEFORE compiling it as JavaScript,
 *    so the quote is live again by the time it matters. Same for a
 *    JSON.stringify() result, whose own surrounding quotes terminate the
 *    attribute early.
 *
 * The fix in both cases is to carry the value in an escaped data-* attribute
 * and read it back via dataset — so that is what these tests enforce.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGES = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));

function readPage(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

test('no page builds an inline onclick out of an esc()-escaped value', () => {
  // esc(...) inside the double-quoted onclick attribute, i.e. spliced into the
  // handler's own JS source rather than sitting in a data-* attribute.
  const pattern = /onclick="[^"]*\$\{esc\(/;
  for (const page of PAGES) {
    const html = readPage(page);
    const match = html.match(pattern);
    assert.equal(match, null,
      `${page} interpolates esc() into an onclick handler: ${match && match[0]}`);
  }
});

test('no page builds an inline onclick out of a JSON.stringify() result', () => {
  const pattern = /onclick="[^"]*JSON\.stringify\(/;
  for (const page of PAGES) {
    const html = readPage(page);
    const match = html.match(pattern);
    assert.equal(match, null,
      `${page} interpolates JSON.stringify() into an onclick handler: ${match && match[0]}`);
  }
});

test('admin.html escapes every merchant-controlled field in the incomplete-onboarding table', () => {
  const html = readPage('admin.html');
  const body = html.slice(html.indexOf('async function loadIncomplete'));
  const fn = body.slice(0, body.indexOf('\n}\n'));

  assert.ok(fn.includes('${esc(b.name)}'), 'business name must be escaped');
  assert.ok(fn.includes('${esc(b.owner_name)}'), 'owner name must be escaped');
  assert.ok(!/\$\{b\.name\}/.test(fn), 'raw ${b.name} must not reach innerHTML');
  assert.ok(!/\$\{b\.owner_name\}/.test(fn), 'raw ${b.owner_name} must not reach innerHTML');
});

test('admin.html does not persist the admin bearer token in localStorage', () => {
  const html = readPage('admin.html');
  assert.ok(!/localStorage\.setItem\(\s*['"]?wab_admin_key/.test(html),
    'the platform admin key must not be written to localStorage');
  assert.ok(html.includes('sessionStorage'),
    'the admin key should be held in sessionStorage, scoped to the tab');
});

test('storefront.html renders merchant-controlled names without inline handlers', () => {
  const html = readPage('storefront.html');
  // The three sinks the scan flagged: product card, bundle card, category chip.
  assert.ok(!/onclick="addToCart\(/.test(html), 'add-to-cart must be a delegated listener');
  assert.ok(!/onclick="setCategory\(/.test(html), 'category chips must be delegated listeners');
  assert.ok(html.includes('class="add-cart"') || html.includes('add-cart'),
    'expected the delegated add-to-cart hook');
});
