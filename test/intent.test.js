const test = require('node:test');
const assert = require('node:assert/strict');

// conversation.handler pulls in db/config at require time; the other service
// tests already run in this environment, so the same require works here.
const { normalizeIntent, titleMatches } = require('../src/services/conversation.handler');

test('normalizeIntent uppercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeIntent('  order   now '), 'ORDER NOW');
  assert.equal(normalizeIntent('Order Now!'), 'ORDER NOW');
  assert.equal(normalizeIntent('“Order Now” 🙏'), 'ORDER NOW');
});

test('normalizeIntent folds Twi vowels so plain-keyboard typing matches', () => {
  assert.equal(normalizeIntent('Tɔ Seesei'), 'TO SEESEI');
  assert.equal(normalizeIntent('to seesei'), 'TO SEESEI');
  assert.equal(normalizeIntent('Kasa yɛn'), 'KASA YEN');
});

test('titleMatches matches typed button labels in either language', () => {
  // btn_order_now: en 'Order Now', tw 'Tɔ Seesei'
  assert.ok(titleMatches('order now', 'btn_order_now'));
  assert.ok(titleMatches('Order Now', 'btn_order_now'));
  assert.ok(titleMatches('to seesei', 'btn_order_now'));
  assert.ok(titleMatches('Tɔ Seesei', 'btn_order_now'));
  // btn_talk_to_us: en 'Talk to us', tw 'Kasa yɛn'
  assert.ok(titleMatches('talk to us', 'btn_talk_to_us'));
  assert.ok(titleMatches('kasa yen', 'btn_talk_to_us'));
  // multiple keys in one call
  assert.ok(titleMatches('checkout', 'btn_add_more', 'btn_checkout'));
});

test('titleMatches rejects unrelated text and empty input', () => {
  assert.equal(titleMatches('jollof rice', 'btn_order_now'), false);
  assert.equal(titleMatches('', 'btn_order_now'), false);
  assert.equal(titleMatches(null, 'btn_order_now'), false);
  // partial label is not a match — "order" alone must fall to other triggers
  assert.equal(titleMatches('order', 'btn_order_now'), false);
});
