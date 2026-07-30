const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validate, summarize, str, strExact, num, int, bool, oneOf, pattern, arrayOf
} = require('../src/utils/validate');

test('a valid body coerces and reports no fields', () => {
  const { valid, value, fields } = validate(
    { name: '  Jollof Rice  ', price_ghs: '35.456', in_stock: 1 },
    { name: str({ required: true, max: 200 }), price_ghs: num({ required: true, min: 0, round: 2 }), in_stock: bool() }
  );

  assert.equal(valid, true);
  assert.deepEqual(fields, {});
  assert.equal(value.name, 'Jollof Rice');   // trimmed
  assert.equal(value.price_ghs, 35.46);      // rounded to pesewas
  assert.equal(value.in_stock, true);        // truthy-coerced, as the routes do
});

test('errors are keyed by field so a form can mark the right input', () => {
  const { valid, fields } = validate(
    { name: '', price_ghs: 'abc' },
    { name: str({ required: true }), price_ghs: num({ required: true }) }
  );

  assert.equal(valid, false);
  // The whole point of this layer: not a flat array of prose.
  assert.deepEqual(fields, { name: 'is required', price_ghs: 'must be a number' });
});

test('every bad field is reported, not just the first', () => {
  const { fields } = validate(
    { a: '', b: 'x', c: -1 },
    { a: str({ required: true }), b: num({ required: true }), c: int({ min: 0 }) }
  );
  assert.equal(Object.keys(fields).length, 3);
});

test('a missing required field is reported as missing', () => {
  const { valid, fields } = validate({}, { name: str({ required: true }) });
  assert.equal(valid, false);
  assert.equal(fields.name, 'is required');
});

test('partial mode skips absent fields entirely — PATCH semantics', () => {
  const schema = { name: str({ required: true }), price_ghs: num({ required: true }) };

  const { valid, value } = validate({ price_ghs: 10 }, schema, { partial: true });

  assert.equal(valid, true, 'an absent required field is fine on a PATCH');
  assert.deepEqual(value, { price_ghs: 10 });
  assert.ok(!('name' in value), 'absent means leave alone, not set to empty');
});

test('partial mode still validates fields that ARE present', () => {
  const { valid, fields } = validate(
    { name: '' },
    { name: str({ required: true }) },
    { partial: true }
  );
  assert.equal(valid, false);
  assert.equal(fields.name, 'is required');
});

test('defaults apply only when a field is absent on a full validate', () => {
  const schema = { category: str({ default: 'general' }) };

  assert.equal(validate({}, schema).value.category, 'general');
  assert.equal(validate({ category: 'drinks' }, schema).value.category, 'drinks');
  // A PATCH that omits the key must not silently reset it to the default.
  assert.ok(!('category' in validate({}, schema, { partial: true }).value));
});

test('str truncates over-length input instead of rejecting it', () => {
  // Matches the existing product routes: keeping the first N characters of a
  // long description is friendlier than refusing the whole product.
  const { valid, value } = validate({ d: 'x'.repeat(50) }, { d: str({ max: 10 }) });
  assert.equal(valid, true);
  assert.equal(value.d, 'x'.repeat(10));
});

test('strExact rejects over-length input instead of truncating', () => {
  const { valid, fields } = validate({ code: 'x'.repeat(50) }, { code: strExact({ max: 10 }) });
  assert.equal(valid, false);
  assert.match(fields.code, /10 characters or fewer/);
});

test('str applies lower-casing and a minimum length', () => {
  assert.equal(validate({ c: '  DRINKS ' }, { c: str({ lower: true }) }).value.c, 'drinks');
  assert.match(validate({ c: 'ab' }, { c: str({ min: 3 }) }).fields.c, /at least 3/);
});

test('nullable distinguishes "clear this" from "invalid"', () => {
  const schema = { stock_qty: int({ min: 0, nullable: true }) };

  // Empty string and null both mean untracked — the product routes' existing
  // rule, where null stock_qty is "unlimited" rather than zero.
  assert.equal(validate({ stock_qty: '' }, schema).value.stock_qty, null);
  assert.equal(validate({ stock_qty: null }, schema).value.stock_qty, null);
  assert.equal(validate({ stock_qty: 0 }, schema).value.stock_qty, 0);
  assert.equal(validate({ stock_qty: 5 }, schema).value.stock_qty, 5);
});

test('int rejects a non-integer, num accepts it', () => {
  assert.match(validate({ n: 1.5 }, { n: int() }).fields.n, /whole number/);
  assert.equal(validate({ n: 1.5 }, { n: num() }).valid, true);
});

test('numeric bounds are inclusive and report the limit', () => {
  assert.equal(validate({ n: 0 }, { n: num({ min: 0 }) }).valid, true);
  assert.equal(validate({ n: 100 }, { n: num({ max: 100 }) }).valid, true);
  assert.match(validate({ n: -1 }, { n: num({ min: 0 }) }).fields.n, /0 or more/);
  assert.match(validate({ n: 101 }, { n: num({ max: 100 }) }).fields.n, /100 or less/);
});

test('oneOf lists the valid options in its message', () => {
  const schema = { network: oneOf(['mtn', 'vodafone', 'airteltigo'], { lower: true }) };

  assert.equal(validate({ network: 'MTN' }, schema).value.network, 'mtn');
  assert.match(validate({ network: 'glo' }, schema).fields.network, /mtn, vodafone, airteltigo/);
});

test('pattern carries a caller-supplied message', () => {
  const schema = { open_time: pattern(/^([01]?\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM (24h)' }) };

  assert.equal(validate({ open_time: '08:30' }, schema).valid, true);
  assert.equal(validate({ open_time: '25:00' }, schema).fields.open_time, 'must be HH:MM (24h)');
});

test('arrayOf points at the offending element by position', () => {
  const schema = { qtys: arrayOf(int({ min: 1 })) };

  assert.deepEqual(validate({ qtys: [1, 2, 3] }, schema).value.qtys, [1, 2, 3]);
  // "item 2 must be 1 or more" is actionable; "must be a list of ints" is not.
  assert.match(validate({ qtys: [1, 0, 3] }, schema).fields.qtys, /item 2 must be 1 or more/);
  assert.match(validate({ qtys: 'nope' }, schema).fields.qtys, /must be a list/);
});

test('arrayOf caps length rather than rejecting', () => {
  const { value } = validate({ tags: ['a', 'b', 'c'] }, { tags: arrayOf(str(), { max: 2 }) });
  assert.deepEqual(value.tags, ['a', 'b']);
});

test('refine runs only once every field is individually valid', () => {
  let ran = false;
  const schema = { a: num({ required: true }) };
  validate({ a: 'x' }, schema, { refine: () => { ran = true; } });

  assert.equal(ran, false,
    'cross-field rules cannot be trusted to run against unparsed values');
});

test('refine can express the products stock_qty / in_stock rule', () => {
  // The real cross-field case this escape hatch exists for.
  const schema = { stock_qty: int({ min: 0, nullable: true }), in_stock: bool() };
  const refine = (value, source) => {
    if (value.stock_qty != null && source.in_stock === undefined) {
      value.in_stock = value.stock_qty > 0;
    }
  };

  assert.equal(validate({ stock_qty: 5 }, schema, { refine }).value.in_stock, true);
  assert.equal(validate({ stock_qty: 0 }, schema, { refine }).value.in_stock, false);
  // An explicit in_stock from the merchant always wins over the inference.
  assert.equal(validate({ stock_qty: 0, in_stock: true }, schema, { refine }).value.in_stock, true);
});

test('refine can add its own field errors', () => {
  const { valid, fields } = validate(
    { from: 10, to: 5 },
    { from: num(), to: num() },
    { refine: v => (v.to < v.from ? { to: 'must be after from' } : null) }
  );

  assert.equal(valid, false);
  assert.equal(fields.to, 'must be after from');
});

test('a non-object body is treated as empty, not a crash', () => {
  // Express gives {} for an empty body, but a malformed or absent one can
  // arrive as undefined/null/a string; validation must not throw on it.
  for (const body of [undefined, null, 'string', 42, []]) {
    const { valid, fields } = validate(body, { name: str({ required: true }) });
    assert.equal(valid, false);
    assert.equal(fields.name, 'is required');
  }
});

test('unknown keys in the body are ignored, never passed through', () => {
  // Straight into a SQL builder downstream — anything not in the schema must
  // not survive.
  const { value } = validate(
    { name: 'x', is_admin: true, business_id: 'other-tenant' },
    { name: str() }
  );
  assert.deepEqual(value, { name: 'x' });
});

test('summarize gives the legacy envelope something human to show', () => {
  assert.equal(summarize({ name: 'is required' }), 'name is required');
  assert.equal(summarize({ name: 'is required', price_ghs: 'must be a number' }),
    'name is required (and 1 more)');
  assert.equal(summarize({}), 'Invalid request');
});
