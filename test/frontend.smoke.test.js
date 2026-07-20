const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPage(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/** Every inline <script> block must be syntactically valid JS. */
function assertInlineScriptsParse(html, pageName) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, `${pageName} has no inline <script> blocks — expected at least one`);
  for (const [i, src] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(src), `${pageName} inline script #${i} has a syntax error`);
  }
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

test('dashboard.html declares its core section navigation and API helper', () => {
  const html = readPage('dashboard.html');
  for (const id of ['sideNav', 'app', 'orderModalOverlay', 'searchOverlay', 'notifPanel']) {
    assert.match(html, new RegExp('id="' + id + '"'), `dashboard.html missing #${id}`);
  }
  assert.match(html, /async function api\(/, 'dashboard.html missing its api() fetch helper');
  assert.match(html, /function showSection\(/, 'dashboard.html missing showSection()');
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
