const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * SHA-256 of the plaintext key. We never store plaintext; only the hash.
 */
function hashKey(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

/**
 * Generate a new key. Returns { plaintext, hash }. Show plaintext to the
 * caller exactly once — only `hash` ends up in the DB.
 */
function generateKey(prefix = 'sk_live') {
  const random = crypto.randomBytes(32).toString('base64url');
  const plaintext = `${prefix}_${random}`;
  return { plaintext, hash: hashKey(plaintext) };
}

/**
 * Create a new API key row. business_id=null means admin-scoped.
 */
async function issueKey({ name, businessId = null, scope = 'tenant' }) {
  if (!name) throw new Error('name required');
  if (!['admin', 'tenant'].includes(scope)) throw new Error('invalid scope');
  if (scope === 'tenant' && !businessId) throw new Error('tenant scope requires business_id');

  const prefix = scope === 'admin' ? 'sk_admin' : 'sk_live';
  const { plaintext, hash } = generateKey(prefix);

  const res = await query(
    `INSERT INTO api_keys (business_id, name, key_hash, scope)
     VALUES ($1,$2,$3,$4) RETURNING id, business_id, name, scope, created_at`,
    [businessId, name, hash, scope]
  );
  return { ...res.rows[0], plaintext };
}

async function revokeKey(id) {
  const res = await query(
    `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id]
  );
  return res.rowCount > 0;
}

function extractKey(req) {
  const h = req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

async function lookupKey(plaintext) {
  if (!plaintext) return null;
  const hash = hashKey(plaintext);
  const res = await query(
    `SELECT id, business_id, scope, revoked_at FROM api_keys WHERE key_hash = $1`,
    [hash]
  );
  const row = res.rows[0];
  if (!row || row.revoked_at) return null;
  // Best-effort touch — ignore failures, never block the request.
  query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});
  return row;
}

/**
 * Express middleware factory. Pass `requiredScope` ('admin' | 'tenant' | 'any').
 * On success, `req.auth = { keyId, businessId, scope }`. Tenant routes also
 * enforce that any `:businessId` route param matches the key's business_id.
 */
function requireAuth(requiredScope = 'any') {
  return async (req, res, next) => {
    try {
      const plaintext = extractKey(req);
      if (!plaintext) {
        return res.status(401).json({ success: false, error: 'Missing API key' });
      }
      const row = await lookupKey(plaintext);
      if (!row) {
        return res.status(401).json({ success: false, error: 'Invalid or revoked API key' });
      }
      if (requiredScope === 'admin' && row.scope !== 'admin') {
        return res.status(403).json({ success: false, error: 'Admin scope required' });
      }
      // Tenant-scope route: tenant key must match businessId in path.
      if (requiredScope === 'tenant' && row.scope === 'tenant') {
        const pathBiz = req.params.businessId;
        if (pathBiz && row.business_id && pathBiz !== row.business_id) {
          return res.status(403).json({ success: false, error: 'Key does not match business' });
        }
      }
      req.auth = { keyId: row.id, businessId: row.business_id, scope: row.scope };
      return next();
    } catch (err) {
      logger.error('auth middleware error: %s', err.message);
      return res.status(500).json({ success: false, error: 'Auth error' });
    }
  };
}

module.exports = {
  hashKey,
  generateKey,
  issueKey,
  revokeKey,
  requireAuth,
  lookupKey
};
