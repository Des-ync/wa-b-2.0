const test = require('node:test');
const assert = require('node:assert/strict');

const { record, getLatencyStats } = require('../src/middleware/latency');

test('getLatencyStats returns nulls when no samples recorded', () => {
  // Uses a far-future cutoff window so any samples from other tests in this
  // process don't leak in — 0 minutes means "only samples from right now".
  const stats = getLatencyStats({ withinMinutes: 0.000001 });
  assert.equal(stats.count, 0);
  assert.equal(stats.p50_ms, null);
  assert.equal(stats.p95_ms, null);
});

test('getLatencyStats computes percentiles over recorded samples', () => {
  const now = Date.now();
  for (let ms = 1; ms <= 100; ms++) {
    record({ path: '/api/test', ms, status: 200, at: now });
  }
  const stats = getLatencyStats({ withinMinutes: 5 });
  assert.ok(stats.count >= 100);
  assert.equal(stats.p50_ms, 50);
  assert.equal(stats.p95_ms, 95);
  assert.equal(stats.max_ms, 100);
});

test('getLatencyStats withinMinutes excludes stale samples', () => {
  const old = Date.now() - 10 * 60_000;
  record({ path: '/api/old', ms: 9999, status: 200, at: old });
  const stats = getLatencyStats({ withinMinutes: 1 });
  // The 9999ms sample is 10 minutes old and must not show up in max_ms
  // within a 1-minute window (unless another test's fresh samples exceed it).
  assert.notEqual(stats.max_ms, 9999);
});
