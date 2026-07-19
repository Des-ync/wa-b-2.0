const test = require('node:test');
const assert = require('node:assert/strict');

const { pickFrequentlyBoughtSuggestion, pickVariantUpgrade } = require('../src/utils/upsell');

const visibleProducts = [
  { id: 'p1', name: 'Jollof Rice' },
  { id: 'p2', name: 'Coca Cola' },
  { id: 'p3', name: 'Waakye Special' }
];

test('pickFrequentlyBoughtSuggestion resolves the top co-occurring name to a live product', () => {
  const rows = [{ name: 'Coca Cola', co_count: 10 }];
  const pick = pickFrequentlyBoughtSuggestion(rows, visibleProducts, []);
  assert.equal(pick.id, 'p2');
});

test('pickFrequentlyBoughtSuggestion skips items already in the cart', () => {
  const rows = [{ name: 'Coca Cola', co_count: 10 }, { name: 'Jollof Rice', co_count: 5 }];
  const pick = pickFrequentlyBoughtSuggestion(rows, visibleProducts, ['coca cola']);
  assert.equal(pick.id, 'p1');
});

test('pickFrequentlyBoughtSuggestion skips a discontinued product with no confident match', () => {
  const rows = [{ name: 'Discontinued Snack Bar', co_count: 20 }, { name: 'Coca Cola', co_count: 3 }];
  const pick = pickFrequentlyBoughtSuggestion(rows, visibleProducts, []);
  assert.equal(pick.id, 'p2');
});

test('pickFrequentlyBoughtSuggestion returns null when nothing qualifies', () => {
  assert.equal(pickFrequentlyBoughtSuggestion([], visibleProducts, []), null);
  assert.equal(pickFrequentlyBoughtSuggestion([{ name: 'Unrelated Thing', co_count: 1 }], visibleProducts, []), null);
});

test('pickVariantUpgrade suggests the next pricier variant', () => {
  const chosen = { name: 'Medium', price_delta_ghs: 2 };
  const all = [
    { name: 'Small', price_delta_ghs: 0 },
    { name: 'Medium', price_delta_ghs: 2 },
    { name: 'Large', price_delta_ghs: 5 },
    { name: 'XL', price_delta_ghs: 8 }
  ];
  const upgrade = pickVariantUpgrade(chosen, all);
  assert.equal(upgrade.name, 'Large');
});

test('pickVariantUpgrade returns null when the customer already picked the priciest option', () => {
  const chosen = { name: 'XL', price_delta_ghs: 8 };
  const all = [{ name: 'Small', price_delta_ghs: 0 }, { name: 'XL', price_delta_ghs: 8 }];
  assert.equal(pickVariantUpgrade(chosen, all), null);
});

test('pickVariantUpgrade handles no variant chosen or no variant list', () => {
  assert.equal(pickVariantUpgrade(null, [{ name: 'Large', price_delta_ghs: 5 }]), null);
  assert.equal(pickVariantUpgrade({ name: 'Small', price_delta_ghs: 0 }, null), null);
});
