const test = require('node:test');
const assert = require('node:assert/strict');

const { _testing } = require('../src/routes/clienterror.routes');
const { normalize, isNoise, signatureOf, pathOnly } = _testing;

/**
 * Client-side error reporting.
 *
 * Two things are being defended against, and they pull in opposite
 * directions. A real exception must get through — that is the entire point,
 * since a TypeError in dashboard.js is otherwise completely invisible. But an
 * error inside a render loop fires on every frame for every visitor, and an
 * endpoint that alerts on each one takes the ops phone down instead of the
 * dashboard.
 *
 * The third constraint is privacy: these pages carry order ids and shop slugs
 * in their query strings, and the reports must not.
 */

test('a real exception survives normalisation', () => {
  const r = normalize({
    kind: 'error',
    message: "Cannot read properties of undefined (reading 'id')",
    source: '/wa-b/dashboard.js',
    line: 412,
    stack: 'TypeError: ...',
    page: '/wa-b/dashboard.html'
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.line, 412);
  assert.match(r.message, /Cannot read properties/);
});

test('query strings are stripped, because they carry order ids and slugs', () => {
  assert.equal(pathOnly('/wa-b/storefront.html?shop=ama'), '/wa-b/storefront.html');
  assert.equal(pathOnly('/wa-b/receipt.html?order=ORD-1042#top'), '/wa-b/receipt.html');
  // Stripped server-side too, not merely trusted to have been stripped by the
  // browser — the body is untrusted input like any other.
  const r = normalize({ message: 'boom', page: '/wa-b/storefront.html?shop=ama&phone=233241234567' });
  assert.equal(r.page, '/wa-b/storefront.html');
});

test('an unknown kind is coerced rather than echoed back', () => {
  assert.equal(normalize({ message: 'x', kind: '<script>' }).kind, 'error');
  assert.equal(normalize({ message: 'x', kind: 'unhandledrejection' }).kind, 'unhandledrejection');
});

test('a body of the wrong shape yields nothing rather than throwing', () => {
  for (const body of [null, undefined, [], 'nonsense', 42, {}, { message: '   ' }]) {
    assert.equal(normalize(body), null);
  }
});

test('long fields are truncated', () => {
  const r = normalize({ message: 'x'.repeat(5000), stack: 'y'.repeat(5000), page: '/p' });
  assert.ok(r.message.length <= 300);
  assert.ok(r.stack.length <= 1000);
});

test('"Script error." is dropped as structurally unactionable', () => {
  // A cross-origin script without CORS headers reports exactly this: no file,
  // no line, no stack. Alerting on it only teaches people to ignore alerts.
  assert.equal(isNoise({ message: 'Script error.' }), true);
  assert.equal(isNoise({ message: 'Script error' }), true);
});

test('benign browser and network noise is dropped', () => {
  for (const message of [
    'ResizeObserver loop completed with undelivered notifications.',
    'NetworkError when attempting to fetch resource.',
    'AbortError: The operation was aborted.',
    'Load failed',
    'TypeError: Failed to fetch'
  ]) {
    assert.equal(isNoise({ message }), true, `${message} should be noise`);
  }
});

test('extension frames are dropped', () => {
  assert.equal(isNoise({ message: 'boom', source: 'chrome-extension://abc/inject.js' }), true);
  assert.equal(isNoise({ message: 'boom', source: 'moz-extension://abc/inject.js' }), true);
});

test('a genuine app error is NOT dropped', () => {
  assert.equal(isNoise({
    message: "Cannot read properties of undefined (reading 'id')",
    source: '/wa-b/dashboard.js'
  }), false);
});

test('the same error on different pages is different, same page is one', () => {
  const base = { kind: 'error', message: 'boom', source: '/wa-b/dashboard.js', line: 10, page: '/wa-b/dashboard.html' };
  assert.equal(signatureOf(base), signatureOf({ ...base }));
  assert.notEqual(signatureOf(base), signatureOf({ ...base, page: '/wa-b/orders.html' }));
  assert.notEqual(signatureOf(base), signatureOf({ ...base, line: 11 }));
});

test('two shops hitting one bug is one signature', () => {
  // Because page is already path-only, the shop slug cannot split it.
  const a = normalize({ message: 'boom', source: '/wa-b/storefront.js', line: 5, page: '/wa-b/storefront.html?shop=ama' });
  const b = normalize({ message: 'boom', source: '/wa-b/storefront.js', line: 5, page: '/wa-b/storefront.html?shop=kofi' });
  assert.equal(signatureOf(a), signatureOf(b));
});

test('the bug class this exists for would be reported', () => {
  // The 18 hanging endpoints were invisible because a hung request produces no
  // log and no 5xx. Their client-side symptom is a rejected fetch that nothing
  // catches — which is precisely an unhandledrejection.
  const r = normalize({
    kind: 'unhandledrejection',
    message: 'ApiError: request timed out after 25000ms',
    stack: 'at api (/wa-b/dashboard.js:88)',
    page: '/wa-b/dashboard.html'
  });
  assert.equal(isNoise(r), false);
  assert.equal(r.kind, 'unhandledrejection');
});
