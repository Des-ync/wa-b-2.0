const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cartSubtotal, checkMinOrder, cartHasProduct, cartHasCategory,
  checkProductScope, computeDiscountForPromo, pickBestCandidate
} = require('../src/utils/promoEligibility');

const cart = [
  { product_id: 'p1', name: 'Jollof', price_ghs: 25, quantity: 2 },
  { product_id: 'p2', name: 'Coke', price_ghs: 5, quantity: 1 }
];

test('cartSubtotal sums price * quantity', () => {
  assert.equal(cartSubtotal(cart), 55);
  assert.equal(cartSubtotal([]), 0);
});

test('checkMinOrder passes when no minimum is set', () => {
  assert.deepEqual(checkMinOrder({ min_order_ghs: null }, cart), { eligible: true });
});

test('checkMinOrder enforces the minimum against cart subtotal', () => {
  assert.deepEqual(checkMinOrder({ min_order_ghs: 100 }, cart), { eligible: false, reason: 'min_order_not_met' });
  assert.deepEqual(checkMinOrder({ min_order_ghs: 50 }, cart), { eligible: true });
});

test('cartHasProduct checks by product_id', () => {
  assert.equal(cartHasProduct(cart, 'p1'), true);
  assert.equal(cartHasProduct(cart, 'p9'), false);
});

test('cartHasCategory matches case-insensitively via the category map', () => {
  const map = new Map([['p1', 'Mains'], ['p2', 'Drinks']]);
  assert.equal(cartHasCategory(cart, 'mains', map), true);
  assert.equal(cartHasCategory(cart, 'DRINKS', map), true);
  assert.equal(cartHasCategory(cart, 'desserts', map), false);
  assert.equal(cartHasCategory(cart, null, map), true); // no restriction = always passes
});

test('checkProductScope requires both product and category rules to pass when both are set', () => {
  const map = new Map([['p1', 'Mains'], ['p2', 'Drinks']]);
  assert.deepEqual(checkProductScope({ product_id: 'p1', category: null }, cart, map), { eligible: true });
  assert.deepEqual(checkProductScope({ product_id: 'p9', category: null }, cart, map), { eligible: false, reason: 'product_not_in_cart' });
  assert.deepEqual(checkProductScope({ product_id: null, category: 'Desserts' }, cart, map), { eligible: false, reason: 'category_not_in_cart' });
  assert.deepEqual(checkProductScope({ product_id: null, category: null }, cart, map), { eligible: true });
});

test('computeDiscountForPromo handles percent and fixed types', () => {
  assert.equal(computeDiscountForPromo({ type: 'percent', value: 10 }, 100), 10);
  assert.equal(computeDiscountForPromo({ type: 'fixed', value: 15 }, 100), 15);
});

test('computeDiscountForPromo caps a fixed discount at the subtotal', () => {
  assert.equal(computeDiscountForPromo({ type: 'fixed', value: 500 }, 40), 40);
});

test('pickBestCandidate returns the highest-value option', () => {
  const candidates = [
    { promo: { code: 'A' }, discountGhs: 5 },
    { promo: { code: 'B' }, discountGhs: 20 },
    { promo: { code: 'C' }, discountGhs: 12 }
  ];
  assert.equal(pickBestCandidate(candidates).promo.code, 'B');
});

test('pickBestCandidate returns null for an empty list', () => {
  assert.equal(pickBestCandidate([]), null);
  assert.equal(pickBestCandidate(null), null);
});
