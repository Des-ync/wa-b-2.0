const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeGhanaPhone,
  detectNetwork,
  formatGhs,
  decayedTypingDelay,
  buildMenuPage,
  ORDER_NUMBER_RE
} = require('../src/utils/helpers');
const { computeTotals } = require('../src/services/order.service');

test('normalizeGhanaPhone accepts common formats', () => {
  assert.equal(normalizeGhanaPhone('0241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('+233241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('233 24 123 4567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('00233241234567'), '+233241234567');
});

test('normalizeGhanaPhone rejects garbage', () => {
  assert.equal(normalizeGhanaPhone('12345'), null);
  assert.equal(normalizeGhanaPhone('not a phone'), null);
  assert.equal(normalizeGhanaPhone(''), null);
  assert.equal(normalizeGhanaPhone('02412345678'), null); // too long
});

test('detectNetwork maps NCA prefixes', () => {
  assert.equal(detectNetwork('+233241234567'), 'mtn');
  assert.equal(detectNetwork('+233201234567'), 'vodafone');
  assert.equal(detectNetwork('+233271234567'), 'airteltigo');
});

test('formatGhs uses the cedi sign', () => {
  assert.equal(formatGhs(45), 'GH₵45.00');
  assert.equal(formatGhs(1234.5), 'GH₵1,234.50');
  assert.equal(formatGhs(0), 'GH₵0.00');
});

test('computeTotals sums carts with quantities and rounds to pesewas', () => {
  const totals = computeTotals(
    [{ price_ghs: 45, quantity: 2 }, { price_ghs: 10.006, quantity: 1 }],
    5
  );
  assert.equal(totals.subtotal_ghs, 100.01);
  assert.equal(totals.delivery_fee, 5);
  assert.equal(totals.total_ghs, 105.01);
  // Classic float trap: 0.1 + 0.2 must not leak 0.30000000000000004
  assert.equal(computeTotals([{ price_ghs: 0.1, quantity: 1 }, { price_ghs: 0.2, quantity: 1 }]).subtotal_ghs, 0.3);
});

test('decayedTypingDelay shrinks per reply down to a floor', () => {
  const d0 = decayedTypingDelay(0);
  const d1 = decayedTypingDelay(1);
  const d2 = decayedTypingDelay(2);
  assert.equal(d0, 750);
  assert.ok(d1 < d0, 'second reply is faster than the first');
  assert.ok(d2 < d1, 'third reply is faster than the second');
  assert.equal(decayedTypingDelay(50), 150, 'never drops below the floor');
});

test('buildMenuPage never exceeds the 10-row WhatsApp limit', () => {
  const products = Array.from({ length: 25 }, (_, i) => ({
    id: `p${i}`, name: `Product ${i}`, price_ghs: 10 + i, description: 'desc'
  }));
  for (let page = 0; page < 4; page++) {
    const menu = buildMenuPage(products, page);
    assert.ok(menu.rows.length <= 10, `page ${page} has ${menu.rows.length} rows`);
  }
  const first = buildMenuPage(products, 0);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);
  assert.ok(first.rows.some(r => r.id.startsWith('menu_page_')), 'first page has a next-page row');
  const last = buildMenuPage(products, first.totalPages - 1);
  assert.equal(last.hasNext, false);
  assert.equal(last.hasPrev, true);
});

test('buildMenuPage with a small catalog has no nav rows', () => {
  const products = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, price_ghs: 5 }));
  const menu = buildMenuPage(products, 0);
  assert.equal(menu.rows.length, 6);
  assert.equal(menu.totalPages, 1);
  assert.ok(!menu.rows.some(r => r.id.startsWith('menu_page_')));
});

test('ORDER_NUMBER_RE matches order numbers in free text', () => {
  assert.ok(ORDER_NUMBER_RE.test('ORD-2026-4821'));
  assert.ok(ORDER_NUMBER_RE.test('please update ord-2026-4821 to ready'));
  assert.ok(!ORDER_NUMBER_RE.test('ORD-26-48'));
  assert.ok(!ORDER_NUMBER_RE.test('no order here'));
});
