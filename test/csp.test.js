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

test('style-src still allows unsafe-inline, because Clerk requires it', () => {
  // Tightening this was tried and reverted. Clerk injects a <style> element at
  // runtime to style the sign-in widget; without 'unsafe-inline' the whole
  // login form renders as unstyled browser defaults. The widget only appears
  // with a live Clerk key, so this cannot be caught locally — it reached
  // production before it was seen. Asserted so the next attempt starts here
  // rather than rediscovering it the same way.
  assert.ok(directive('style-src').includes("'unsafe-inline'"),
    'style-src dropped unsafe-inline — this breaks the Clerk sign-in widget');
});

test('style-src-attr is stated explicitly, not left to fall back', () => {
  // This is the load-bearing one. An ABSENT style-src-attr inherits style-src,
  // which now has no 'unsafe-inline' — that would silently drop all 819
  // style="…" attributes across the markup and the innerHTML templates and
  // break the layout on every page. Deleting this line looks like tidying up.
  assert.deepEqual(directive('style-src-attr'), ["'unsafe-inline'"]);
});

test('the policy names a report endpoint', () => {
  // Without report-uri the browser has nowhere to say that it blocked
  // something, which is how a broken login page shipped unnoticed.
  assert.deepEqual(directive('report-uri'), ['/api/csp-report']);
});

test('an unparseable report body is swallowed, not turned into a 500', () => {
  // express.json() throws before the route runs, so the route's own
  // "always answer 204" never gets the chance and the generic handler makes
  // it a 500. A reporting endpoint that answers 5xx manufactures the errors
  // it exists to surface. Asserted structurally because booting the app
  // needs a database.
  const m = SERVER.match(/app\.use\('\/api\/csp-report',\s*\(err[^)]*\)\s*=>\s*\{[\s\S]{0,200}?\}\);/);
  assert.ok(m, 'no error handler mounted for /api/csp-report');
  assert.match(m[0], /res\.status\(204\)/, 'the csp-report error handler must answer 204');
});
