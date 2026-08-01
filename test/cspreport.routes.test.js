const test = require('node:test');
const assert = require('node:assert/strict');

const { _testing } = require('../src/routes/cspreport.routes');
const { normalize, isIgnorable, signatureOf } = _testing;

/**
 * CSP violation reporting.
 *
 * This endpoint exists because a real regression — a tightened style-src
 * blocking the <style> element Clerk injects, leaving the login form
 * unstyled in production — produced no server-side signal at all. Nothing
 * threw, nothing 500'd, the HTML was byte-perfect. Only the browser could
 * see it.
 *
 * The risk in an endpoint like this is the opposite failure: it is
 * unauthenticated, every visitor's browser can post to it, and a single bad
 * directive fires on every page view. So most of what is tested here is
 * restraint — that noise is filtered and that one violation produces one
 * alert, not thousands.
 */

test('parses the legacy application/csp-report shape', () => {
  const out = normalize({
    'csp-report': {
      'effective-directive': 'style-src',
      'blocked-uri': 'inline',
      'document-uri': 'https://skes.tech/wa-b/login.html',
      'source-file': 'https://clerk.skes.tech/clerk.browser.js'
    }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].directive, 'style-src');
  assert.equal(out[0].blockedUri, 'inline');
});

test('falls back to violated-directive when effective-directive is absent', () => {
  const out = normalize({ 'csp-report': { 'violated-directive': 'script-src-elem' } });
  assert.equal(out[0].directive, 'script-src-elem');
});

test('parses the Reporting API array shape', () => {
  const out = normalize([
    { type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'https://evil.test/x.js', documentURL: 'https://skes.tech/wa-b/dashboard.html' } },
    { type: 'deprecation', body: { id: 'something-else' } }
  ]);
  // The non-CSP report in the same batch is dropped rather than mangled.
  assert.equal(out.length, 1);
  assert.equal(out[0].blockedUri, 'https://evil.test/x.js');
});

test('a body of the wrong shape yields nothing rather than throwing', () => {
  for (const body of [null, undefined, {}, [], 'nonsense', { unrelated: true }]) {
    assert.deepEqual(normalize(body), []);
  }
});

test('browser-extension noise is ignored', () => {
  // A password manager restyling a login form is the single most common real
  // CSP report and says nothing about this app. If these got through, the
  // endpoint would alert constantly and be muted within a day.
  for (const uri of [
    'chrome-extension://abcdef/inject.js',
    'moz-extension://1234/content.css',
    'safari-web-extension://x/y.js',
    'about:blank'
  ]) {
    assert.equal(isIgnorable(uri, null), true, `${uri} should be ignored`);
  }
});

test('an extension named only as the source file is still ignored', () => {
  assert.equal(isIgnorable('inline', 'chrome-extension://abc/content.js'), true);
});

test('a real violation from our own origin is NOT ignored', () => {
  assert.equal(isIgnorable('inline', 'https://clerk.skes.tech/clerk.browser.js'), false);
  assert.equal(isIgnorable('https://evil.test/x.js', null), false);
});

test('the signature ignores query strings, which carry order ids and slugs', () => {
  const a = signatureOf({ directive: 'style-src', blockedUri: 'inline', documentUri: 'https://skes.tech/wa-b/storefront.html?shop=ama' });
  const b = signatureOf({ directive: 'style-src', blockedUri: 'inline', documentUri: 'https://skes.tech/wa-b/storefront.html?shop=kofi' });
  // Two shops hitting the same bug is one bug, not two alerts.
  assert.equal(a, b);
});

test('different directives or pages are different signatures', () => {
  const base = { directive: 'style-src', blockedUri: 'inline', documentUri: 'https://skes.tech/wa-b/login.html' };
  assert.notEqual(signatureOf(base), signatureOf({ ...base, directive: 'script-src' }));
  assert.notEqual(signatureOf(base), signatureOf({ ...base, documentUri: 'https://skes.tech/wa-b/dashboard.html' }));
});

test('a malformed document URI still produces a usable signature', () => {
  const sig = signatureOf({ directive: 'style-src', blockedUri: 'inline', documentUri: 'not a url' });
  assert.ok(sig.includes('style-src'));
  assert.ok(sig.length > 0);
});

test('the regression that motivated this would be reported', () => {
  // The exact shape a browser sent when style-src blocked Clerk's injected
  // <style>. It must survive normalisation and not be filtered as noise.
  const [v] = normalize({
    'csp-report': {
      'effective-directive': 'style-src-elem',
      'blocked-uri': 'inline',
      'document-uri': 'https://skes.tech/wa-b/login.html',
      'source-file': 'https://clerk.skes.tech/npm/@clerk/clerk-js@5/dist/clerk.browser.js'
    }
  });
  assert.equal(isIgnorable(v.blockedUri, v.sourceFile), false);
  assert.ok(signatureOf(v).startsWith('style-src-elem|inline|/wa-b/login.html'));
});
