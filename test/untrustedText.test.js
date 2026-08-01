const test = require('node:test');
const assert = require('node:assert/strict');

const { safeForAlert, defangLinks } = require('../src/utils/untrustedText');

/**
 * Browser-supplied text on its way to an ops phone.
 *
 * /api/csp-report and /api/client-error are unauthenticated by necessity, so
 * anyone can POST a crafted message and have it delivered as a WhatsApp alert
 * and an admin push. The risk is not execution — a WhatsApp message is not
 * code — it is phishing: an alert arriving through the company's own
 * monitoring channel is far more credible than a cold email, and a tappable
 * link inside one is the whole attack.
 */

test('the phishing payload this exists for is defanged', () => {
  const out = safeForAlert('URGENT: dashboard compromised, reset at https://wa-b-secure.test/reset');
  assert.ok(!out.includes('https://'), 'a tappable https link survived');
  assert.match(out, /hxxps:\/\/wa-b-secure\.test\/reset/);
  // Still readable — an admin can see exactly what was claimed.
  assert.match(out, /dashboard compromised/);
});

test('http, https and bare www are all defanged', () => {
  assert.equal(defangLinks('http://a.test'), 'hxxp://a.test');
  assert.equal(defangLinks('https://a.test'), 'hxxps://a.test');
  assert.equal(defangLinks('www.a.test'), 'www[.]a.test');
  assert.equal(defangLinks('HTTPS://A.TEST'), 'hxxps://A.TEST');
});

test('several links in one message are all defanged', () => {
  const out = defangLinks('see https://a.test then http://b.test and www.c.test');
  assert.ok(!/https?:\/\//.test(out));
  assert.ok(!/\bwww\./.test(out));
});

test('a legitimate report is left readable', () => {
  // The common case must not be mangled into uselessness.
  const out = safeForAlert("Cannot read properties of undefined (reading 'id')");
  assert.equal(out, "Cannot read properties of undefined (reading 'id')");
});

test('invisible characters are stripped', () => {
  // Written as escapes, not literal bytes: a zero-width character in source is
  // invisible to a reviewer and to anyone editing this later.
  const ZWSP = '\u200B';   // zero-width space, can split a domain visually
  const RLO  = '\u202E';   // right-to-left override, can reverse how one reads
  const out = safeForAlert(`evi${ZWSP}l.test${RLO}`);
  assert.ok(!out.includes(ZWSP), 'a zero-width space survived');
  assert.ok(!out.includes(RLO), 'a bidi override survived');
  assert.match(out, /evil\.test/);
});

test('control characters cannot forge the alert structure', () => {
  // Newlines separate fields in the alert body; injected ones could fake a
  // "page:" line that never came from the browser.
  const out = safeForAlert('boom\npage: https://real.test\rmore');
  assert.ok(!out.includes('\n'), 'a newline survived and can forge a field');
  assert.ok(!out.includes('\r'));
});

test('truncation happens after defanging, never re-exposing a link', () => {
  // Truncating first could cut "hxxps://" back into something a client
  // re-links, or leave a raw prefix at the boundary.
  const long = 'x'.repeat(290) + 'https://evil.test/very/long/path';
  const out = safeForAlert(long, 300);
  assert.ok(out.length <= 300);
  assert.ok(!out.includes('https://'), 'truncation re-exposed a live link');
});

test('null and undefined are handled', () => {
  assert.equal(safeForAlert(null), '');
  assert.equal(safeForAlert(undefined), '');
});
