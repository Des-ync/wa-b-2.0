const test = require('node:test');
const assert = require('node:assert/strict');

const { detectProductQuery } = require('../src/utils/productQuery');

test('detects "anything below X cedis" as a price_below query', () => {
  const q = detectProductQuery('Anything below 50 cedis?');
  assert.deepEqual(q, { type: 'price_below', max: 50 });
});

test('detects "under X" and "less than X" as price_below', () => {
  assert.equal(detectProductQuery('under 30').type, 'price_below');
  assert.equal(detectProductQuery('less than 30').type, 'price_below');
});

test('detects "over X" / "above X" as price_above', () => {
  const q = detectProductQuery('what do you have above 100 cedis');
  assert.deepEqual(q, { type: 'price_above', min: 100 });
});

test('detects "between X and Y" as price_between regardless of order', () => {
  assert.deepEqual(detectProductQuery('Between 20 and 50 cedis'), { type: 'price_between', min: 20, max: 50 });
  assert.deepEqual(detectProductQuery('between 50 and 20'), { type: 'price_between', min: 20, max: 50 });
});

test('detects "do you have X" as an availability query', () => {
  const q = detectProductQuery('Do you have spicy rice?');
  assert.equal(q.type, 'availability');
  assert.equal(q.term, 'spicy rice');
});

test('detects "do you sell X" and "is there X"', () => {
  assert.equal(detectProductQuery('Do you sell waakye').term, 'waakye');
  assert.equal(detectProductQuery('Is there jollof').term, 'jollof');
});

test('strips a leading "any"/"some" from the availability term', () => {
  assert.equal(detectProductQuery('any chicken?').term, 'chicken');
});

test('returns null for plain product-name or command text', () => {
  assert.equal(detectProductQuery('Jollof'), null);
  assert.equal(detectProductQuery('2x Jollof'), null);
  assert.equal(detectProductQuery('checkout'), null);
  assert.equal(detectProductQuery(''), null);
  assert.equal(detectProductQuery(null), null);
});

test('detects delivery-fee questions', () => {
  assert.deepEqual(detectProductQuery('How much is delivery?'), { type: 'delivery_fee' });
  assert.deepEqual(detectProductQuery('what is the delivery fee'), { type: 'delivery_fee' });
  assert.deepEqual(detectProductQuery('delivery cost'), { type: 'delivery_fee' });
  assert.deepEqual(detectProductQuery('shipping fee?'), { type: 'delivery_fee' });
  assert.deepEqual(detectProductQuery('do you deliver'), { type: 'delivery_fee' });
  assert.deepEqual(detectProductQuery('cost of delivery'), { type: 'delivery_fee' });
});

test('price questions still win over the delivery-fee pattern when both could apply', () => {
  // "below 50" is a much stronger, unambiguous signal — numeric filters are
  // checked first so they can never be shadowed by the delivery-fee phrase.
  assert.equal(detectProductQuery('anything below 50 cedis for delivery').type, 'price_below');
});
