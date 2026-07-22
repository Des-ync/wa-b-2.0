const test = require('node:test');
const assert = require('node:assert/strict');

const { detectIntent, normalizeIntent, stripFiller } = require('../src/services/nl.intent');

test('exact vocabulary matches in English', () => {
  assert.deepEqual(detectIntent('menu'), { intent: 'MENU' });
  assert.deepEqual(detectIntent('What do you have?'), { intent: 'MENU' });
  assert.deepEqual(detectIntent('checkout'), { intent: 'CHECKOUT' });
  assert.deepEqual(detectIntent("that's all"), { intent: 'CHECKOUT' });
  assert.deepEqual(detectIntent('cancel'), { intent: 'CANCEL' });
  assert.deepEqual(detectIntent('help'), { intent: 'HELP' });
  assert.deepEqual(detectIntent('hi'), { intent: 'GREET' });
  assert.deepEqual(detectIntent('yes'), { intent: 'YES' });
  assert.deepEqual(detectIntent('no'), { intent: 'NO' });
});

test('exact vocabulary matches in Twi, with plain-keyboard vowel folding', () => {
  assert.deepEqual(detectIntent('maakye'), { intent: 'GREET' });
  assert.deepEqual(detectIntent('ɛte sɛn'), { intent: 'GREET' });
  assert.deepEqual(detectIntent('ete sen'), { intent: 'GREET' });
  assert.deepEqual(detectIntent('aduane'), { intent: 'MENU' });
  assert.deepEqual(detectIntent('metua'), { intent: 'CHECKOUT' });
  assert.deepEqual(detectIntent('gyae'), { intent: 'CANCEL' });
  assert.deepEqual(detectIntent('boa me'), { intent: 'HELP' });
  assert.deepEqual(detectIntent('aane'), { intent: 'YES' });
  assert.deepEqual(detectIntent('daabi'), { intent: 'NO' });
});

test('filler stripping isolates the product request', () => {
  assert.equal(stripFiller(normalizeIntent('I want 2 jollof')), '2 JOLLOF');
  assert.equal(stripFiller(normalizeIntent('me pɛ waakye')), 'WAAKYE');
  assert.equal(stripFiller(normalizeIntent('can i get banku please')), 'BANKU');
  assert.equal(stripFiller(normalizeIntent('I want')), '');
});

test('product extraction needs allowProduct and filler or quantity', () => {
  // filler + name
  assert.deepEqual(detectIntent('I want jollof', { allowProduct: true }),
    { intent: 'PRODUCT', name: 'JOLLOF', quantity: 1 });
  // Twi filler + name
  assert.deepEqual(detectIntent('me pɛ waakye', { allowProduct: true }),
    { intent: 'PRODUCT', name: 'WAAKYE', quantity: 1 });
  // bare quantity forms
  assert.deepEqual(detectIntent('2 jollof', { allowProduct: true }),
    { intent: 'PRODUCT', name: 'JOLLOF', quantity: 2 });
  assert.deepEqual(detectIntent('2x jollof', { allowProduct: true }),
    { intent: 'PRODUCT', name: 'JOLLOF', quantity: 2 });
  // filler + quantity + name
  assert.deepEqual(detectIntent('give me 3 waakye', { allowProduct: true }),
    { intent: 'PRODUCT', name: 'WAAKYE', quantity: 3 });
  // bare unknown word: NOT claimed as a product (caller's matcher decides)
  assert.equal(detectIntent('jollof', { allowProduct: true }), null);
  // product extraction off: filler phrases resolve to nothing, not products
  assert.equal(detectIntent('I want jollof'), null);
});

test('filler followed by vocabulary resolves to the inner intent', () => {
  assert.deepEqual(detectIntent('I want to pay', { allowProduct: true }), { intent: 'CHECKOUT' });
  assert.deepEqual(detectIntent('me pɛ', { allowProduct: true }), { intent: 'MENU' });
});

test('unknown chatter returns null — the bot stays in business context', () => {
  assert.equal(detectIntent('what is the capital of France', { allowProduct: true }), null);
  assert.equal(detectIntent('tell me a joke'), null);
  assert.equal(detectIntent(''), null);
  assert.equal(detectIntent(null), null);
});

test('TRACK vocabulary matches order-status keywords and synonyms', () => {
  assert.deepEqual(detectIntent('track'), { intent: 'TRACK' });
  assert.deepEqual(detectIntent('my order'), { intent: 'TRACK' });
  assert.deepEqual(detectIntent('order status'), { intent: 'TRACK' });
  assert.deepEqual(detectIntent('where is my order'), { intent: 'TRACK' });
  assert.deepEqual(detectIntent("wheres my order"), { intent: 'TRACK' });
  assert.deepEqual(detectIntent('Track My Order'), { intent: 'TRACK' });
  // doesn't need allowProduct — TRACK is an exact vocabulary match
  assert.deepEqual(detectIntent('track order', { allowProduct: false }), { intent: 'TRACK' });
});
