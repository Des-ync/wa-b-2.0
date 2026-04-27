require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../utils/logger');

if (!process.env.DATABASE_URL) {
  logger.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
}

const useSsl = process.env.DATABASE_SSL === 'true' || /sslmode=require/i.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

pool.on('error', err => {
  logger.error('Unexpected PostgreSQL pool error: %s', err.message, { stack: err.stack });
});

/**
 * Run a parameterized query against the pool.
 * Always pass values via the second argument — never interpolate into SQL.
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      logger.warn('Slow query (%dms): %s', duration, text.replace(/\s+/g, ' ').slice(0, 160));
    }
    return result;
  } catch (err) {
    logger.error('Query failed: %s | %s', text.replace(/\s+/g, ' ').slice(0, 160), err.message);
    throw err;
  }
}

/**
 * Run a callback inside a single transaction. Commits on success, rolls back on error.
 *
 *   await transaction(async (client) => {
 *     await client.query('UPDATE ...', [...]);
 *     await client.query('INSERT ...', [...]);
 *   });
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rbErr) {
      logger.error('Rollback failed: %s', rbErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, transaction, close };
