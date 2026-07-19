const os = require('os');
const crypto = require('crypto');
const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { alertOps } = require('./alert.service');
const metrics = require('../utils/metrics');
const requestContext = require('../utils/requestContext');

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const LOCK_TTL_SECONDS = 60;
const MAX_ATTEMPTS = 8;

/**
 * Backoff for retries: 5s, 15s, 1m, 5m, 15m, 30m, 1h, 2h.
 */
const BACKOFF_SECONDS = [5, 15, 60, 300, 900, 1800, 3600, 7200];

/**
 * Persist an inbound webhook event. Idempotent on (source, external_id):
 * a duplicate replay is silently absorbed.
 *
 * Returns:
 *   { event, duplicate: boolean }
 */
async function enqueue({ source, externalId, payload, signatureValid = true }) {
  if (!source) throw new Error('source required');
  if (!externalId) {
    // Fall back to a deterministic hash so repeated identical bodies dedupe too.
    externalId = 'sha256:' + crypto
      .createHash('sha256')
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
  }

  const res = await query(
    `INSERT INTO webhook_events
       (source, external_id, payload, signature_valid, status)
     VALUES ($1,$2,$3::jsonb,$4,'pending')
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING *`,
    [source, externalId, JSON.stringify(payload || {}), !!signatureValid]
  );

  if (res.rowCount === 0) {
    const existing = await query(
      `SELECT * FROM webhook_events WHERE source = $1 AND external_id = $2`,
      [source, externalId]
    );
    return { event: existing.rows[0], duplicate: true };
  }
  return { event: res.rows[0], duplicate: false };
}

/**
 * Atomically claim the next due event of a given source. Returns null if none.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple workers can poll safely.
 */
async function claimNext(source) {
  return transaction(async client => {
    const sel = await client.query(
      `SELECT * FROM webhook_events
        WHERE status IN ('pending')
          AND next_attempt_at <= NOW()
          ${source ? 'AND source = $1' : ''}
        ORDER BY next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      source ? [source] : []
    );
    const event = sel.rows[0];
    if (!event) return null;

    const upd = await client.query(
      `UPDATE webhook_events
          SET status = 'processing',
              locked_by = $2,
              locked_at = NOW(),
              attempts = attempts + 1
        WHERE id = $1
        RETURNING *`,
      [event.id, WORKER_ID]
    );
    return upd.rows[0];
  });
}

async function markDone(eventId) {
  await query(
    `UPDATE webhook_events
        SET status = 'done',
            processed_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            last_error = NULL
      WHERE id = $1`,
    [eventId]
  );
}

async function markFailed(eventId, errorMsg, attempts, source) {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_SECONDS.length - 1);
  const delay = BACKOFF_SECONDS[idx];
  const exhausted = attempts >= MAX_ATTEMPTS;

  await query(
    `UPDATE webhook_events
        SET status          = $3,
            last_error      = $2,
            locked_at       = NULL,
            locked_by       = NULL,
            next_attempt_at = NOW() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [eventId, String(errorMsg || '').slice(0, 2000),
     exhausted ? 'failed' : 'pending',
     String(delay)]
  );

  // A webhook that never processes after every retry is real money or a
  // real message stuck in limbo — worth a page, not just a log line.
  if (exhausted) {
    alertOps(
      `Webhook gave up after ${MAX_ATTEMPTS} attempts`,
      `source=${source || 'unknown'} event=${eventId}\n${errorMsg}`
    );
  }
}

/**
 * Re-queue events stuck in 'processing' for longer than the lock TTL
 * (typically because the worker crashed mid-flight). Attempts are counted at
 * claim time, so an event that repeatedly kills its worker still respects
 * MAX_ATTEMPTS: once exhausted it is marked 'failed' instead of re-queued.
 */
async function reclaimStuck() {
  const failed = await query(
    `UPDATE webhook_events
        SET status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            last_error = COALESCE(last_error, 'worker died mid-processing; attempts exhausted')
      WHERE status = 'processing'
        AND locked_at < NOW() - ($1 || ' seconds')::interval
        AND attempts >= $2
      RETURNING id`,
    [String(LOCK_TTL_SECONDS), MAX_ATTEMPTS]
  );
  if (failed.rowCount) {
    logger.error('Gave up on %d stuck webhook event(s) after %d attempts', failed.rowCount, MAX_ATTEMPTS);
    alertOps(
      'Webhook worker kept dying mid-processing',
      `${failed.rowCount} event(s) gave up after ${MAX_ATTEMPTS} attempts (worker crashed before completing them each time)`
    );
  }

  const res = await query(
    `UPDATE webhook_events
        SET status = 'pending',
            locked_at = NULL,
            locked_by = NULL
      WHERE status = 'processing'
        AND locked_at < NOW() - ($1 || ' seconds')::interval
        AND attempts < $2
      RETURNING id`,
    [String(LOCK_TTL_SECONDS), MAX_ATTEMPTS]
  );
  if (res.rowCount) {
    logger.warn('Reclaimed %d stuck webhook event(s)', res.rowCount);
  }
  return res.rowCount + failed.rowCount;
}

/**
 * Drain the queue: claim and process events until empty (or stop on first miss).
 * `processors` is a map: { whatsapp: fn(payload), paystack: fn, hubtel: fn }.
 * Each fn receives the raw payload (parsed JSON) and may throw to trigger retry.
 */
async function drain(processors, { maxBatch = 50 } = {}) {
  let processed = 0;
  for (let i = 0; i < maxBatch; i++) {
    const event = await claimNext();
    if (!event) break;
    processed++;

    if (event.received_at) {
      metrics.recordTiming(`webhook_queue_wait_ms.${event.source}`, Date.now() - new Date(event.received_at).getTime());
    }

    const fn = processors[event.source];
    if (!fn) {
      await markFailed(event.id, `No processor for source=${event.source}`, event.attempts, event.source);
      metrics.increment(`webhook_failed_total.${event.source}`);
      continue;
    }

    const start = Date.now();
    // Correlate every log line this event's processing produces (including
    // deep async work) with the event's own id — the same trick requestId
    // middleware does for HTTP requests, applied to the queue.
    try {
      await requestContext.run({ requestId: `webhook:${event.id}` }, () => fn(event.payload, event));
      await markDone(event.id);
      metrics.recordTiming(`webhook_processing_ms.${event.source}`, Date.now() - start);
      metrics.increment(`webhook_done_total.${event.source}`);
    } catch (err) {
      logger.error('Webhook event %s (%s) failed: %s', event.id, event.source, err.message);
      await markFailed(event.id, err.message, event.attempts, event.source);
      metrics.recordTiming(`webhook_processing_ms.${event.source}`, Date.now() - start);
      metrics.increment(`webhook_failed_total.${event.source}`);
    }
  }
  return processed;
}

module.exports = {
  enqueue,
  claimNext,
  markDone,
  markFailed,
  reclaimStuck,
  drain,
  WORKER_ID
};
