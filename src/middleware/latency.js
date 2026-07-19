/**
 * Lightweight in-process request-latency tracker for the admin ops
 * dashboard's p95 figure. Deliberately not persisted to the DB — a rolling
 * in-memory window is enough for "is this thing slow right now" and avoids
 * writing a row per request.
 */
const WINDOW_SIZE = 2000;
const samples = []; // ring buffer of { path, ms, status, at }

function record(sample) {
  samples.push(sample);
  if (samples.length > WINDOW_SIZE) samples.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Stats over the current window, optionally restricted to the last N minutes. */
function getLatencyStats({ withinMinutes } = {}) {
  const cutoff = withinMinutes ? Date.now() - withinMinutes * 60_000 : 0;
  const durations = samples.filter(s => s.at >= cutoff).map(s => s.ms).sort((a, b) => a - b);
  if (!durations.length) return { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  return {
    count: durations.length,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    p99_ms: percentile(durations, 99),
    max_ms: durations[durations.length - 1]
  };
}

/** Express middleware — attach once, near the top of the stack. */
function latencyMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    // Skip static assets / health polling noise so the percentile reflects
    // actual API work, not the marketing site's asset requests.
    if (!req.path.startsWith('/api/')) return;
    record({ path: req.path, ms: Date.now() - start, status: res.statusCode, at: Date.now() });
  });
  next();
}

module.exports = { latencyMiddleware, getLatencyStats, record };
