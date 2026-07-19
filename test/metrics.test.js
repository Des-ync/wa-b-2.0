const test = require('node:test');
const assert = require('node:assert/strict');

const { increment, recordTiming, timingStats, getMetricsSnapshot, _reset } = require('../src/utils/metrics');

test('increment accumulates counts, defaulting to +1', () => {
  _reset();
  increment('wa_send_success');
  increment('wa_send_success');
  increment('wa_send_success', 3);
  assert.equal(getMetricsSnapshot().counters.wa_send_success, 5);
});

test('separate counter keys stay independent', () => {
  _reset();
  increment('a');
  increment('b', 2);
  const snap = getMetricsSnapshot().counters;
  assert.equal(snap.a, 1);
  assert.equal(snap.b, 2);
});

test('timingStats computes avg/p95/max over recorded timings', () => {
  _reset();
  for (let ms = 1; ms <= 100; ms++) recordTiming('payment_verification_ms', ms);
  const stats = timingStats('payment_verification_ms');
  assert.equal(stats.count, 100);
  assert.equal(stats.avg_ms, 51); // rounded mean of 1..100
  assert.equal(stats.p95_ms, 95);
  assert.equal(stats.max_ms, 100);
});

test('timingStats returns nulls for a name with no recorded timings', () => {
  _reset();
  const stats = timingStats('nothing_recorded');
  assert.equal(stats.count, 0);
  assert.equal(stats.avg_ms, null);
});

test('getMetricsSnapshot includes both counters and timings', () => {
  _reset();
  increment('webhook_processed_total');
  recordTiming('webhook_processing_ms', 42);
  const snap = getMetricsSnapshot();
  assert.equal(snap.counters.webhook_processed_total, 1);
  assert.equal(snap.timings.webhook_processing_ms.count, 1);
  assert.equal(snap.timings.webhook_processing_ms.max_ms, 42);
});
