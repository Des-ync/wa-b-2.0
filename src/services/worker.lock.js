const os = require('os');
const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Try to acquire a named lock for `ttlSeconds`. Returns true if this process
 * now holds the lock. Use a cooperative DB row to ensure only one instance
 * (across many web servers / pods) runs a given cron job.
 */
async function acquire(jobName, ttlSeconds = 300) {
  // Insert if absent.
  await query(
    `INSERT INTO worker_locks (job_name, locked_by, locked_at, expires_at)
     VALUES ($1, $2, NOW(), NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (job_name) DO NOTHING`,
    [jobName, WORKER_ID, String(ttlSeconds)]
  );

  // Take it if expired or unowned.
  const res = await query(
    `UPDATE worker_locks
        SET locked_by = $2,
            locked_at = NOW(),
            expires_at = NOW() + ($3 || ' seconds')::interval
      WHERE job_name = $1
        AND (expires_at < NOW() OR locked_by = $2)
      RETURNING locked_by`,
    [jobName, WORKER_ID, String(ttlSeconds)]
  );
  return res.rowCount > 0 && res.rows[0].locked_by === WORKER_ID;
}

async function release(jobName) {
  await query(
    `DELETE FROM worker_locks WHERE job_name = $1 AND locked_by = $2`,
    [jobName, WORKER_ID]
  );
}

/**
 * Run `fn` only if we acquire the named lock. Releases on completion.
 */
async function withLock(jobName, ttlSeconds, fn) {
  const got = await acquire(jobName, ttlSeconds);
  if (!got) {
    logger.info('[lock] Skipping %s — another worker holds the lock', jobName);
    return { ran: false };
  }
  try {
    await fn();
    return { ran: true };
  } finally {
    // Never let a lock-release failure mask the real error from fn().
    try {
      await release(jobName);
    } catch (releaseErr) {
      logger.warn('[lock] Failed to release %s: %s', jobName, releaseErr.message);
    }
  }
}

module.exports = { acquire, release, withLock, WORKER_ID };
