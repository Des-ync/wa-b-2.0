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

/**
 * Ghanaian phrasing regressions for quantity extraction.
 *
 * The original bug this guards was WhatsApp silently dropping the quantity
 * from "I want 2 fried rice" — the customer got one plate and the merchant
 * got a complaint. The channel gate is long gone; these pin the phrasings a
 * real customer actually types, in the register they type them in.
 */
test('quantity survives the phrasings Ghanaian customers actually use', () => {
  const cases = [
    ['I want 2 fried rice', 2, 'fried rice'],
    ['gimme 2 jollof', 2, 'jollof'],
    ['give me 2 jollof', 2, 'jollof'],
    ['2 pieces of the fried rice', 2, 'fried rice'],
    ['two waakye', 2, 'waakye'],
    ['I want two waakye please', 2, 'waakye'],
    ['can I get 3 banku', 3, 'banku'],
    ['let me get 4 kelewele', 4, 'kelewele'],
    ['3x jollof', 3, 'jollof'],
    ['jollof x2', 2, 'jollof'],
    ['I would like 5 meat pie', 5, 'meat pie']
  ];

  for (const [text, qty, name] of cases) {
    const r = detectIntent(text, { allowProduct: true });
    assert.equal(r?.intent, 'PRODUCT', `"${text}" should read as a product`);
    assert.equal(r.quantity, qty, `"${text}" quantity`);
    assert.match(r.name.toLowerCase(), new RegExp(name.replace(/ /g, '\\s*')),
      `"${text}" product name`);
  }
});

test('a BARE product name is left to the caller, by design', () => {
  // detectIntent deliberately returns null here rather than force-matching
  // random chatter as a product; conversation.handler's own fuzzy matcher
  // (tryTypedProductAdd) handles bare names while browsing, where the context
  // makes it safe.
  assert.equal(detectIntent('waakye', { allowProduct: true }), null);
  assert.equal(detectIntent('hows the weather', { allowProduct: true }), null);
});

test('a quantity with no plausible ceiling is not treated as one', () => {
  // "1000 jollof" does not parse as a quantity at all (the matcher accepts at
  // most two digits), so it falls through rather than telling the shop to
  // cook a thousand plates.
  const r = detectIntent('I want 1000 jollof', { allowProduct: true });
  assert.equal(r.intent, 'PRODUCT');
  assert.equal(r.quantity, 1, 'the digits stay part of the name, not the count');
});

/**
 * The self-service commands added in Phase 5. Each replaces a question the
 * shop was answering by hand.
 */
test('self-service commands are recognised in the words customers use', () => {
  const cases = [
    ['receipt', 'RECEIPT'], ['my receipt', 'RECEIPT'], ['send me the receipt', 'RECEIPT'],
    ['proof of payment', 'RECEIPT'],
    ['points', 'POINTS'], ['my points', 'POINTS'], ['how many points', 'POINTS'],
    ['my stamps', 'POINTS'], ['rewards', 'POINTS'],
    ['hours', 'HOURS'], ['are you open', 'HOURS'], ['what time do you close', 'HOURS'],
    ['when do you open', 'HOURS'],
    ['location', 'LOCATION'], ['where are you', 'LOCATION'], ['your address', 'LOCATION'],
    ['where is your shop', 'LOCATION'], ['can I pick up', 'LOCATION'], ['directions', 'LOCATION'],
    ['how do I pay', 'PAYMENT_METHODS'],
    ['can I pay with vodafone cash', 'PAYMENT_METHODS'],
    ['do you accept momo', 'PAYMENT_METHODS'],
    ['cash on delivery', 'PAYMENT_METHODS']
  ];

  for (const [text, intent] of cases) {
    assert.equal(detectIntent(text)?.intent, intent, `"${text}"`);
  }
});

test('the new commands do not swallow longer phrases containing them', () => {
  // Vocabulary matching is whole-phrase, so "open sandwich" is not HOURS.
  // With no filler and no quantity it falls through to the caller's own
  // matcher, exactly like any other bare name.
  for (const text of ['open sandwich', 'points chocolate', 'receipt paper']) {
    assert.notEqual(detectIntent(text, { allowProduct: true })?.intent, 'HOURS', text);
    assert.notEqual(detectIntent(text, { allowProduct: true })?.intent, 'POINTS', text);
    assert.notEqual(detectIntent(text, { allowProduct: true })?.intent, 'RECEIPT', text);
  }
  // With a filler lead-in they resolve as products, quantity and all.
  const r = detectIntent('I want 2 open sandwich', { allowProduct: true });
  assert.equal(r.intent, 'PRODUCT');
  assert.equal(r.quantity, 2);
});

test('spoken register carries a quantity as well as digits do', () => {
  const cases = [
    ['gimme 2 jollof', 2], ['make I get 3 banku', 3], ['bring me two fried rice', 2],
    ['abeg give me jollof', 1], ['I need 4 kelewele', 4], ['a waakye', 1]
  ];
  for (const [text, qty] of cases) {
    const r = detectIntent(text, { allowProduct: true });
    assert.equal(r?.intent, 'PRODUCT', `"${text}"`);
    assert.equal(r.quantity, qty, `"${text}" quantity`);
  }
});
