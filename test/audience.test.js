const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAudienceClauses, describeAudience, SEGMENTS } = require('../src/utils/audience');

test('buildAudienceClauses returns no clauses for an empty filter', () => {
  const params = [];
  assert.deepEqual(buildAudienceClauses(null, params), []);
  assert.deepEqual(buildAudienceClauses({}, params), []);
  assert.deepEqual(params, []);
});

test('buildAudienceClauses adds a tag clause and lowercases the value', () => {
  const params = ['seed'];
  const clauses = buildAudienceClauses({ tag: 'VIP' }, params);
  assert.equal(clauses.length, 1);
  assert.match(clauses[0], /\$2 = ANY\(c\.tags\)/);
  assert.equal(params[1], 'vip');
});

test('buildAudienceClauses adds a min-spend clause with correct placeholder numbering', () => {
  const params = ['seed'];
  const clauses = buildAudienceClauses({ min_spend_ghs: 100 }, params);
  assert.match(clauses[0], /\$2/);
  assert.equal(params[1], 100);
});

test('buildAudienceClauses ignores an invalid min_spend_ghs', () => {
  const params = [];
  assert.deepEqual(buildAudienceClauses({ min_spend_ghs: 'not-a-number' }, params), []);
  assert.deepEqual(buildAudienceClauses({ min_spend_ghs: -5 }, params), []);
});

test('buildAudienceClauses adds a known segment clause and ignores unknown segments', () => {
  const params = [];
  const clauses = buildAudienceClauses({ segment: 'ordered_30d' }, params);
  assert.equal(clauses.length, 1);
  assert.match(clauses[0], /orders o/);

  const unknown = buildAudienceClauses({ segment: 'not_a_real_segment' }, []);
  assert.deepEqual(unknown, []);
});

test('buildAudienceClauses combines tag + segment + min_spend_ghs with correct numbering', () => {
  const params = [];
  const clauses = buildAudienceClauses({ tag: 'wholesale', segment: 'inactive_60d', min_spend_ghs: 50 }, params);
  assert.equal(clauses.length, 3);
  assert.equal(params.length, 2);
  assert.equal(params[0], 'wholesale');
  assert.equal(params[1], 50);
});

test('describeAudience falls back to "All opted-in customers" for no filter', () => {
  assert.equal(describeAudience(null), 'All opted-in customers');
  assert.equal(describeAudience({}), 'All opted-in customers');
});

test('describeAudience composes a readable summary', () => {
  const desc = describeAudience({ segment: 'ordered_30d', tag: 'vip', min_spend_ghs: 200 });
  assert.match(desc, /Ordered in last 30 days/);
  assert.match(desc, /tag "vip"/);
  assert.match(desc, /GH₵200\.00/);
});

test('every SEGMENTS entry has a label and sql', () => {
  for (const [key, def] of Object.entries(SEGMENTS)) {
    assert.ok(def.label, `${key} missing label`);
    assert.ok(def.sql, `${key} missing sql`);
  }
});
