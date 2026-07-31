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

test('script-src-attr is still the known remaining gap', () => {
  // Documented deliberately: ~86 inline on*= handlers still need it. If this
  // ever tightens, that is a win and this test should be updated to match —
  // it exists so the gap stays visible rather than forgotten.
  assert.ok(directive('script-src-attr').includes("'unsafe-inline'"),
    'script-src-attr no longer needs unsafe-inline — update this test and the comment in server.js');
});
