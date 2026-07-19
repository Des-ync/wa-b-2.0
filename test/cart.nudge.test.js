const test = require('node:test');
const assert = require('node:assert/strict');

const { variantFor, renderTemplate } = require('../src/services/cart.nudge');

test('variantFor is deterministic for the same customer id', () => {
  const id = 'cust-abc-123';
  assert.equal(variantFor(id), variantFor(id));
});

test('variantFor only ever returns a or b', () => {
  for (const id of ['a', 'bb', 'ccc-1', 'cust-9999-xyz', '']) {
    assert.ok(['a', 'b'].includes(variantFor(id)));
  }
});

test('variantFor splits a batch of ids roughly evenly', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `customer-${i}`);
  const counts = { a: 0, b: 0 };
  for (const id of ids) counts[variantFor(id)]++;
  // Not a statistical guarantee, but any reasonable hash should keep both
  // arms within a wide band for 200 distinct ids.
  assert.ok(counts.a > 50 && counts.b > 50, `uneven split: ${JSON.stringify(counts)}`);
});

test('renderTemplate substitutes {shop} and {count}', () => {
  const out = renderTemplate('Hey! Your cart at {shop} has {count} items waiting.', { shop: 'Auntie Ama', count: 3 });
  assert.equal(out, 'Hey! Your cart at Auntie Ama has 3 items waiting.');
});

test('renderTemplate handles repeated placeholders and missing ones gracefully', () => {
  const out = renderTemplate('{shop} {shop} - {count}', { shop: 'X', count: 1 });
  assert.equal(out, 'X X - 1');
});

test('renderTemplate truncates to 1024 chars', () => {
  const long = 'a'.repeat(2000);
  const out = renderTemplate(long, { shop: 'X', count: 1 });
  assert.equal(out.length, 1024);
});
