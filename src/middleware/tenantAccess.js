/**
 * Centralized tenant/business access control — the single source of truth
 * for "may this caller touch this business's data", replacing what used to
 * be a hand-copied `tenantBlocksBusinessId` function pasted into every
 * route file (12+ copies, one per route module). Fixing an isolation bug
 * here now fixes it everywhere at once instead of needing a sweep across
 * every route file.
 */

/**
 * True if this caller must NOT be allowed to touch `businessId`.
 * Admin-scoped callers can touch anything. A tenant-scoped caller with no
 * businessId on their own auth (shouldn't happen, but fail closed) is
 * always blocked. Otherwise a tenant may only touch their OWN business.
 */
function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return !!businessId && businessId !== req.auth.businessId;
}

/**
 * Resolve which business a request is acting on. An admin may name one via
 * query/body business_id; a tenant is always pinned to their own key's
 * business_id — a tenant-supplied business_id in the request is never
 * trusted to override that, it's simply ignored.
 */
function resolveBusinessId(req) {
  if (req.auth?.scope === 'admin') return req.query?.business_id || req.body?.business_id || null;
  return req.auth?.businessId || null;
}

/**
 * Express middleware: resolves and validates the business_id a request is
 * acting on, in one line instead of the repeated
 *   if (!business_id) return 400...
 *   if (tenantBlocksBusinessId(req, business_id)) return 403...
 * boilerplate. On success sets req.businessId to the resolved, TRUSTED
 * value — routes should read req.businessId, not req.query.business_id,
 * after this middleware runs.
 *
 * Fits routes where the target business is named directly in the request
 * (query/body/:businessId param, or falls back to the caller's own key).
 * For routes that instead load a RESOURCE first and need to check that
 * resource's OWN business_id (e.g. "does this order belong to me"), call
 * tenantBlocksBusinessId(req, resource.business_id) directly after the
 * fetch — that's not something a route-entry middleware can do, since the
 * resource isn't loaded yet when the middleware runs.
 */
function requireBusinessAccess(getBusinessId) {
  const extractor = getBusinessId
    || (req => req.params.businessId || req.query.business_id || req.body?.business_id || req.auth?.businessId);
  return (req, res, next) => {
    const businessId = extractor(req);
    if (!businessId) {
      return res.status(400).json({ success: false, error: 'business_id required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    req.businessId = businessId;
    next();
  };
}

module.exports = { tenantBlocksBusinessId, resolveBusinessId, requireBusinessAccess };
