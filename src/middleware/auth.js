const crypto = require('crypto');
const { verifyToken } = require('@clerk/backend');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const { setBusinessId } = require('../utils/requestContext');
const { can } = require('../utils/permissions');
const { recordAudit } = require('../utils/auditLog');

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
// A Clerk session token is a JWT: three base64url segments separated by dots.
// Our own API keys (sk_live_.../sk_admin_...) never contain a dot, so this is
// an unambiguous way to tell the two apart on the same Authorization header.
const JWT_SHAPE_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Verify a Clerk session token and resolve it to a linked business.
 * Returns { clerkUserId, business } on success.
 * Throws with a `.code` of 'invalid_token' or 'not_linked' on failure —
 * callers use the code to return the right HTTP status/message.
 */
async function verifyClerkSession(token) {
  if (!CLERK_SECRET_KEY) {
    const err = new Error('CLERK_SECRET_KEY is not configured');
    err.code = 'invalid_token';
    throw err;
  }
  let payload;
  try {
    payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
  } catch (err) {
    const wrapped = new Error('Invalid or expired Clerk session');
    wrapped.code = 'invalid_token';
    throw wrapped;
  }
  const clerkUserId = payload.sub;
  const res = await query('SELECT * FROM businesses WHERE clerk_user_id = $1', [clerkUserId]);
  if (!res.rows[0]) {
    const err = new Error('No business linked to this Clerk account yet');
    err.code = 'not_linked';
    err.clerkUserId = clerkUserId;
    throw err;
  }
  return { clerkUserId, business: res.rows[0] };
}

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

const VALID_ROLES = ['owner', 'manager', 'support', 'accountant'];

/**
 * Create a new API key row. business_id=null means admin-scoped. `role`
 * only matters for tenant-scoped keys (admin keys are always full-platform)
 * and defaults to 'owner' — the same default the DB column carries, so
 * every pre-existing key kept its original full access when this shipped.
 */
async function issueKey({ name, businessId = null, scope = 'tenant', role = 'owner', expiresAt = null, rotatedFrom = null }) {
  if (!name) throw new Error('name required');
  if (!['admin', 'tenant'].includes(scope)) throw new Error('invalid scope');
  if (scope === 'tenant' && !businessId) throw new Error('tenant scope requires business_id');
  if (!VALID_ROLES.includes(role)) throw new Error(`invalid role: ${role}`);

  const prefix = scope === 'admin' ? 'sk_admin' : 'sk_live';
  const { plaintext, hash } = generateKey(prefix);

  const res = await query(
    `INSERT INTO api_keys (business_id, name, key_hash, scope, role, expires_at, rotated_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, business_id, name, scope, role, expires_at, created_at`,
    [businessId, name, hash, scope, role, expiresAt, rotatedFrom]
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

/**
 * Rotation: revoke the old key and issue a fresh one carrying the same
 * name/business/scope/role — the new plaintext is shown exactly once, same
 * as issueKey. The old key stops working immediately (no overlap window),
 * which is the right default for "I think this key leaked."
 */
async function rotateKey(oldKeyId) {
  const oldRes = await query('SELECT * FROM api_keys WHERE id = $1', [oldKeyId]);
  const old = oldRes.rows[0];
  if (!old) throw new Error('Key not found');
  if (old.revoked_at) throw new Error('Key is already revoked');

  const fresh = await issueKey({
    name: old.name, businessId: old.business_id, scope: old.scope,
    role: old.role, expiresAt: old.expires_at, rotatedFrom: old.id
  });
  await revokeKey(old.id);
  return fresh;
}

function extractKey(req) {
  const h = req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}

/**
 * `meta.ip`/`meta.userAgent`, when passed, update last_used_* (device
 * metadata) and flag a suspicious-looking access: the key was already seen
 * from a DIFFERENT IP before this request. Best-effort — never blocks.
 */
async function lookupKey(plaintext, meta = {}) {
  if (!plaintext) return null;
  const hash = hashKey(plaintext);
  const res = await query(
    `SELECT id, business_id, scope, revoked_at, role, expires_at, last_used_ip
       FROM api_keys WHERE key_hash = $1`,
    [hash]
  );
  const row = res.rows[0];
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  if (meta.ip && row.last_used_ip && row.last_used_ip !== meta.ip) {
    logger.warn('api key %s used from a new IP (%s -> %s)', row.id, row.last_used_ip, meta.ip);
    recordAudit({
      actorType: row.scope === 'admin' ? 'admin' : 'merchant', actorId: row.id, businessId: row.business_id,
      action: 'auth.suspicious_new_ip', detail: { previous_ip: row.last_used_ip, new_ip: meta.ip }
    });
  }

  // Best-effort touch — ignore failures, never block the request.
  query(
    `UPDATE api_keys SET last_used_at = NOW(), last_used_ip = COALESCE($2, last_used_ip),
            last_used_user_agent = COALESCE($3, last_used_user_agent)
      WHERE id = $1`,
    [row.id, meta.ip || null, meta.userAgent ? String(meta.userAgent).slice(0, 300) : null]
  ).catch(() => {});
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

      // Clerk session tokens are JWTs; our own API keys never are. Route to
      // the right verifier based on shape, entirely transparent to routes —
      // any handler using requireAuth() accepts either credential type.
      if (JWT_SHAPE_RE.test(plaintext)) {
        try {
          const { clerkUserId, business } = await verifyClerkSession(plaintext);
          if (requiredScope === 'admin') {
            return res.status(403).json({ success: false, error: 'Admin scope required' });
          }
          // Same guarantee as the API-key path below: on tenant-scoped routes
          // a :businessId path param must match the caller's own business.
          if (requiredScope === 'tenant') {
            const pathBiz = req.params.businessId;
            if (pathBiz && pathBiz !== business.id) {
              return res.status(403).json({ success: false, error: 'Session does not match business' });
            }
          }
          // A Clerk session only ever belongs to the business owner today
          // (businesses.clerk_user_id is a single column) — role is always
          // 'owner' on this path.
          req.auth = { keyId: null, businessId: business.id, scope: 'tenant', clerkUserId, role: 'owner' };
          setBusinessId(business.id);
          return next();
        } catch (err) {
          if (err.code === 'not_linked') {
            return res.status(409).json({
              success: false,
              error: 'not_linked',
              message: 'No business is linked to this account yet.'
            });
          }
          return res.status(401).json({ success: false, error: 'Invalid or expired session' });
        }
      }

      const row = await lookupKey(plaintext, { ip: req.ip, userAgent: req.headers['user-agent'] });
      if (!row) {
        return res.status(401).json({ success: false, error: 'Invalid, expired, or revoked API key' });
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
      req.auth = { keyId: row.id, businessId: row.business_id, scope: row.scope, role: row.role || 'owner' };
      if (row.business_id) setBusinessId(row.business_id);
      return next();
    } catch (err) {
      logger.error('auth middleware error: %s', err.message);
      return res.status(500).json({ success: false, error: 'Auth error' });
    }
  };
}

/**
 * Gate a route on the caller's role having `capability` at `mode`
 * ('read' | 'write', default 'write'). Mount AFTER requireAuth() — reads
 * req.auth.role, which requireAuth always sets (defaulting to 'owner' for
 * every credential type that predates roles, so this is purely additive).
 * Admin-scoped keys always pass — role-based capabilities are a tenant
 * concept, admins already have their own scope check.
 */
function requirePermission(capability, mode = 'write') {
  return (req, res, next) => {
    if (req.auth?.scope === 'admin') return next();
    const role = req.auth?.role || 'owner';
    if (!can(role, capability, mode)) {
      return res.status(403).json({
        success: false,
        error: `Your role (${role}) does not have ${mode} access to ${capability}`
      });
    }
    next();
  };
}

module.exports = {
  hashKey,
  generateKey,
  issueKey,
  revokeKey,
  rotateKey,
  requireAuth,
  requirePermission,
  lookupKey,
  verifyClerkSession,
  JWT_SHAPE_RE,
  VALID_ROLES
};
