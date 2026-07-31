const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPage(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/**
 * Every inline <script> block must be syntactically valid JS.
 *
 * A page with no inline blocks is fine — dashboard.html's moved to
 * dashboard.js — so this no longer demands that at least one exists. The
 * guard that its JS parses did not go away, it followed the code; see
 * assertScriptFileParses below.
 */
function assertInlineScriptsParse(html, pageName) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const [i, src] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(src), `${pageName} inline script #${i} has a syntax error`);
  }
}

/** An extracted script file must parse, and must actually be referenced. */
function assertScriptFileParses(pageName, scriptName) {
  const src = readPage(scriptName);
  assert.doesNotThrow(() => new Function(src), `${scriptName} has a syntax error`);
  assert.match(readPage(pageName), new RegExp(`<script src="${scriptName}"`),
    `${pageName} does not load ${scriptName}`);
}

const PAGES = ['dashboard.html', 'admin.html', 'receipt.html', 'login.html', 'signup.html'];

test('every dashboard-family page exists and parses as HTML with a <title>', () => {
  for (const page of PAGES) {
    const html = readPage(page);
    assert.match(html, /<title>.*<\/title>/i, `${page} missing a <title>`);
    assert.match(html, /<html/i, `${page} missing <html>`);
  }
});

test('every dashboard-family page\'s inline JS is syntactically valid', () => {
  for (const page of PAGES) {
    assertInlineScriptsParse(readPage(page), page);
  }
});

test('dashboard.js parses and is loaded by dashboard.html', () => {
  assertScriptFileParses('dashboard.html', 'dashboard.js');
});

test('dashboard.html declares its core section navigation and API helper', () => {
  const html = readPage('dashboard.html');
  for (const id of ['sideNav', 'app', 'orderModalOverlay', 'searchOverlay', 'notifPanel']) {
    assert.match(html, new RegExp('id="' + id + '"'), `dashboard.html missing #${id}`);
  }
  // The behaviour lives in dashboard.js now; the markup still has to be able
  // to reach it, so these are asserted where they actually are.
  const js = readPage('dashboard.js');
  assert.match(js, /async function api\(/, 'dashboard.js missing its api() fetch helper');
  assert.match(js, /function showSection\(/, 'dashboard.js missing showSection()');
});

test('every function dashboard.html calls from an inline handler exists in dashboard.js', () => {
  // The extraction only stays safe while the markup can still reach the
  // code: inline on*= handlers resolve against globals, so a function that
  // stopped being global would fail silently at click time, not load time.
  const html = readPage('dashboard.html');
  const js = readPage('dashboard.js');
  const called = new Set(
    [...html.matchAll(/\bon[a-z]+="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
  );
  assert.ok(called.size > 30, `expected many inline handlers, found ${called.size}`);
  const missing = [...called].filter(fn =>
    !new RegExp(`(function\\s+${fn}\\b|\\b(?:const|let|var)\\s+${fn}\\s*=|\\bwindow\\.${fn}\\s*=)`).test(js)
    && !/^(if|for|while|return|event|this|document|window|alert|confirm)$/.test(fn)
  );
  assert.deepEqual(missing, [], `dashboard.html calls these but dashboard.js does not define them: ${missing.join(', ')}`);
});

test('admin.html declares its ops/webhook/audit sections and key-gated boot flow', () => {
  const html = readPage('admin.html');
  for (const id of ['keyCard', 'opsBox', 'webhookTable', 'auditTable', 'alertsTable']) {
    assert.match(html, new RegExp('id="' + id + '"'), `admin.html missing #${id}`);
  }
  assert.match(html, /function saveKeyAndLoad\(/, 'admin.html missing its key-save flow');
});

test('receipt.html reads the order id from the query string and renders a card', () => {
  const html = readPage('receipt.html');
  assert.match(html, /URLSearchParams/);
  assert.match(html, /id="card"/);
  assert.match(html, /\/api\/receipts\//);
});

test('every page references only same-origin or well-known CDN assets (no stray localhost/dev URLs)', () => {
  for (const page of PAGES) {
    const html = readPage(page);
    const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    for (const url of urls) {
      assert.ok(!/localhost|127\.0\.0\.1/.test(url), `${page} references a local dev URL: ${url}`);
    }
  }
});

/**
 * Storefront variant/add-on selection and the pickup-vs-delivery choice
 * (Phase 6). These are static assertions rather than a rendered-DOM test —
 * matching how this file already works — but they pin the parts that would
 * silently stop working: the escaping, and the wiring between the page and
 * the fields the checkout endpoint validates.
 */
test('storefront.html offers product options and a fulfilment choice', () => {
  const html = readPage('storefront.html');

  assertInlineScriptsParse(html, 'storefront.html');

  // A variant is a choice, an add-on is an extra — radios and checkboxes.
  assert.match(html, /name="sf-variant"[^>]*type="radio"|type="radio"[^>]*name="sf-variant"/);
  assert.match(html, /name="sf-addon"[^>]*type="checkbox"|type="checkbox"[^>]*name="sf-addon"/);

  // Pickup must be reachable without inventing an address.
  assert.match(html, /name="sf-fulfil"/);
  assert.match(html, /I'll collect it myself/);

  // The zone selector the checkout endpoint now requires when a shop uses zones.
  assert.match(html, /id="custZone"/);
  assert.match(html, /delivery_zone: zone \|\| undefined/);

  // The configuration has to reach the server, or the price silently reverts
  // to the base product.
  assert.match(html, /variant_id: l\.variant_id/);
  assert.match(html, /addon_ids: l\.addon_ids/);
});

test('storefront escapes every merchant-controlled option string', () => {
  const html = readPage('storefront.html');

  // Variant, add-on and zone names are merchant-entered and land in innerHTML.
  for (const expr of ['esc(v.id)', 'esc(v.name)', 'esc(a.id)', 'esc(a.name)', 'esc(z.name)']) {
    assert.ok(html.includes(expr), `expected ${expr} — unescaped merchant text reaches innerHTML`);
  }
  // ...and never raw.
  for (const raw of ['${v.name}', '${a.name}', '${z.name}']) {
    assert.ok(!html.includes(raw), `${raw} is interpolated without esc()`);
  }
});

test('the options dialog is reachable and labelled for assistive tech', () => {
  const html = readPage('storefront.html');

  assert.match(html, /id="optsModal"[\s\S]{0,200}role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="optsTitle"/);
  // Quantity steppers are icon-only buttons; without a label a screen reader
  // announces them as "minus" with no object.
  assert.match(html, /aria-label="Remove one/);
  assert.match(html, /aria-label="Add one/);
});
