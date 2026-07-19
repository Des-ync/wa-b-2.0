const test = require('node:test');
const assert = require('node:assert/strict');

const { levenshtein, scoreProductName, fuzzyMatchProducts } = require('../src/utils/fuzzyMatch');

test('levenshtein computes edit distance correctly', () => {
  assert.equal(levenshtein('jollof', 'jollof'), 0);
  assert.equal(levenshtein('jollof', 'jalof'), 2);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('scoreProductName gives a top score for an exact match', () => {
  assert.equal(scoreProductName('jollof', 'Jollof'), 100);
});

test('scoreProductName scores a substring match highly', () => {
  const score = scoreProductName('jollof', 'Spicy Jollof Rice');
  assert.ok(score >= 80, `expected >=80, got ${score}`);
});

test('scoreProductName tolerates a typo within budget', () => {
  const score = scoreProductName('waachy', 'Waakye Special');
  assert.ok(score > 0, 'expected a nonzero score for a typo');
});

test('scoreProductName matches through the synonym dictionary', () => {
  const score = scoreProductName('kelly welly', 'Kelewele');
  assert.ok(score > 0, 'expected a synonym match');
});

test('scoreProductName returns 0 for unrelated terms', () => {
  assert.equal(scoreProductName('pizza', 'Waakye Special'), 0);
});

test('scoreProductName does not fuzzy-match very short unrelated words', () => {
  // Short words (<=3 chars) get zero typo budget, so near-miss short terms
  // shouldn't accidentally match unrelated short product names.
  assert.equal(scoreProductName('tea', 'egg'), 0);
});

test('fuzzyMatchProducts ranks best matches first and respects maxResults', () => {
  const products = [
    { id: 1, name: 'Jollof Rice' },
    { id: 2, name: 'Waakye Special' },
    { id: 3, name: 'Fried Rice' },
    { id: 4, name: 'Banku with Tilapia' }
  ];
  const results = fuzzyMatchProducts('jollof', products, { maxResults: 2 });
  assert.ok(results.length <= 2);
  assert.equal(results[0].id, 1);
});

test('fuzzyMatchProducts excludes zero-score products', () => {
  const products = [{ id: 1, name: 'Jollof Rice' }, { id: 2, name: 'Pizza' }];
  const results = fuzzyMatchProducts('jollof', products);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 1);
});
