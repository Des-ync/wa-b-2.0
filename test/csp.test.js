const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * The Content-Security-Policy is configuration, not code, so nothing else
 * would notice it loosening. These read src/server.js directly rather than
 * booting the app, which needs a database.
 */
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

function directive(name) {
  const m = SERVER.match(new RegExp(`'${name}':\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `CSP directive ${name} not found in server.js`);
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('script-src does not allow unsafe-inline', () => {
  // Every page loads its JS from a file, so an injected <script> payload must
  // not execute. frontend.smoke.test.js asserts the other half of this.
  assert.ok(!directive('script-src').includes("'unsafe-inline'"),
    "script-src allows 'unsafe-inline' again — an injected <script> would execute");
});

test('script-src does not allow unsafe-eval', () => {
  assert.ok(!directive('script-src').includes("'unsafe-eval'"),
    "script-src allows 'unsafe-eval' — runtime code generation is back");
});

test('object-src and base-uri stay locked down', () => {
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('base-uri'), ["'self'"]);
});

test('script-src-attr blocks inline event handlers', () => {
  // The 86 inline on*= handlers became data-* attributes dispatched by
  // actions.js, so an injected `<img onerror=…>` does not execute. Loosening
  // this back to 'unsafe-inline' would reopen that without breaking anything
  // visible, which is why it is asserted.
  assert.deepEqual(directive('script-src-attr'), ["'none'"]);
});

test('style-src does not allow unsafe-inline', () => {
  // The ten inline <style> blocks moved to .css files, so an injected <style>
  // block cannot restyle the page.
  assert.ok(!directive('style-src').includes("'unsafe-inline'"),
    "style-src allows 'unsafe-inline' again — an injected <style> block would apply");
});

test('style-src-attr is stated explicitly, not left to fall back', () => {
  // This is the load-bearing one. An ABSENT style-src-attr inherits style-src,
  // which now has no 'unsafe-inline' — that would silently drop all 819
  // style="…" attributes across the markup and the innerHTML templates and
  // break the layout on every page. Deleting this line looks like tidying up.
  assert.deepEqual(directive('style-src-attr'), ["'unsafe-inline'"]);
});
