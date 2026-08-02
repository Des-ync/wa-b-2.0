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

test('script-src-attr may only be tightened once NO file builds an inline handler', () => {
  // The relationship this asserts is the one that was missed. The .html files
  // were converted to data-* attributes and script-src-attr was set to 'none'
  // — but the page scripts BUILD another 61 inline handlers into markup they
  // assign via innerHTML, and those are subject to script-src-attr exactly
  // like static ones. 49 dashboard controls and 5 on the storefront stopped
  // working, silently, because nothing throws when a handler is refused.
  //
  // So the policy is tied to the actual state of the files rather than to
  // anyone remembering: tighten it and this test tells you what still builds
  // handlers.
  const fs2 = require('fs');
  const dir = path.join(__dirname, '..', 'public');
  const offenders = [];
  for (const f of fs2.readdirSync(dir).filter(n => n.endsWith('.js') || n.endsWith('.html'))) {
    const matches = fs2.readFileSync(path.join(dir, f), 'utf8').match(/\son[a-z]+="/g);
    if (matches) offenders.push(`${f} (${matches.length})`);
  }
  const tightened = !directive('script-src-attr').includes("'unsafe-inline'");
  if (tightened) {
    assert.deepEqual(offenders, [],
      `script-src-attr is tightened but these files still build inline handlers, which will silently stop working:\n  ${offenders.join('\n  ')}`);
  } else {
    assert.ok(offenders.length > 0,
      'nothing builds inline handlers any more — script-src-attr can now be set to \'none\'');
  }
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

test('img-src allows blob:, which the photo upload depends on', () => {
  // The picker resizes through a canvas, so the chosen file is loaded into an
  // <img> via URL.createObjectURL. Without blob: that load is refused and the
  // merchant sees "not an image we can read" for a perfectly good photo —
  // caught by the CSP report endpoint while building the feature, not by a
  // user.
  assert.ok(directive('img-src').includes('blob:'),
    'img-src dropped blob: — photo upload resizing will fail silently');
});
