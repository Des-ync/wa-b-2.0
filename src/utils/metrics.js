/**
 * Minimal in-process metrics: counters and timing histograms, snapshotted
 * for the admin ops dashboard. Same philosophy as middleware/latency.js —
 * no external metrics backend, no DB writes per event, just enough to
 * answer "is this healthy right now" without adding infrastructure.
 */

const counters = new Map(); // key -> count
const timings = new Map();  // key -> [{ ms, at }] ring buffer, capped per key

const TIMING_WINDOW = 500;

function increment(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

function recordTiming(name, ms) {
  if (!timings.has(name)) timings.set(name, []);
  const arr = timings.get(name);
  arr.push({ ms, at: Date.now() });
  if (arr.length > TIMING_WINDOW) arr.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function timingStats(name) {
  const arr = timings.get(name) || [];
  const sorted = arr.map(s => s.ms).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, avg_ms: null, p95_ms: null, max_ms: null };
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    avg_ms: Math.round(avg),
    p95_ms: percentile(sorted, 95),
    max_ms: sorted[sorted.length - 1]
  };
}

/** Snapshot of every counter and every timing series recorded so far. */
function getMetricsSnapshot() {
  const countersOut = Object.fromEntries(counters);
  const timingsOut = {};
  for (const name of timings.keys()) timingsOut[name] = timingStats(name);
  return { counters: countersOut, timings: timingsOut };
}

/** Test/dev helper — resets all in-memory state. */
function _reset() {
  counters.clear();
  timings.clear();
}

module.exports = { increment, recordTiming, timingStats, getMetricsSnapshot, _reset };
