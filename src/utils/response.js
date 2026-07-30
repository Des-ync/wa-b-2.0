/**
 * One response envelope for every route, introduced behind a version
 * negotiation so the migration can proceed one route group at a time without
 * a flag day.
 *
 * v2 (opt in with `X-API-Version: 2`):
 *   { success: true,  data: {...}, meta: {...} }
 *   { success: false, error: { code, message, fields } }
 *
 * legacy (the default — byte-for-byte what every route returns today):
 *   { success: true,  ...payload, ...meta }
 *   { success: false, error: "human readable message" }
 *
 * WHY NEGOTIATION RATHER THAN EMITTING BOTH SHAPES AT ONCE:
 * the obvious shim is to send `data: {orders}` AND a top-level `orders`, so
 * old and new clients both find what they expect. That doubles the bytes on
 * every list response. This product is built for merchants on expensive,
 * intermittent 3G — a 200-order page sent twice is a real cost to a real
 * person, paid on every request, for the entire length of a migration. The
 * header costs nothing and lets each client move when it is ready.
 *
 * Legacy is the default on purpose: a route migrated to these helpers keeps
 * behaving exactly as before for every existing caller (public/dashboard.html
 * and any deployed mobile build), and only a client that explicitly asks for
 * v2 sees the new shape.
 */

/**
 * Stable, machine-readable error codes. Clients branch on these; the message
 * is for humans and may be reworded freely. Keep this list small — a code
 * per HTTP situation, not per call site.
 */
const CODES = {
  VALIDATION: 'validation_error',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  UNAUTHORIZED: 'unauthorized',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM: 'upstream_error',
  INTERNAL: 'internal_error'
};

/** Default HTTP status for each code, so call sites rarely pass one. */
const STATUS_FOR_CODE = {
  [CODES.VALIDATION]: 400,
  [CODES.NOT_FOUND]: 404,
  [CODES.FORBIDDEN]: 403,
  [CODES.UNAUTHORIZED]: 401,
  [CODES.CONFLICT]: 409,
  [CODES.RATE_LIMITED]: 429,
  [CODES.UPSTREAM]: 502,
  [CODES.INTERNAL]: 500
};

/**
 * Which envelope this request asked for. Anything other than an explicit "2"
 * — absent, malformed, "1" — means legacy, so a garbled header can never
 * silently change the shape a client receives.
 */
function wantsV2(req) {
  const raw = req?.get?.('X-API-Version') ?? req?.headers?.['x-api-version'];
  return String(raw || '').trim() === '2';
}

/**
 * Success. `payload` is the domain object(s) — `{ orders }`, `{ product }`.
 * `meta` is everything about the response rather than in it: pagination,
 * counts, computed rates.
 *
 * In legacy mode payload and meta are both spread flat, which is exactly
 * what today's routes do (`{ success: true, orders, total }`).
 */
function ok(req, res, payload = {}, { meta, status = 200 } = {}) {
  if (wantsV2(req)) {
    const body = { success: true, data: payload };
    if (meta && Object.keys(meta).length) body.meta = meta;
    return res.status(status).json(body);
  }
  return res.status(status).json({ success: true, ...payload, ...(meta || {}) });
}

/**
 * Failure. `fields` is a { fieldName: reason } map for validation errors and
 * is omitted entirely in legacy mode, which never had it.
 *
 * `extra` is a compatibility escape hatch, not a feature to reach for. A few
 * pre-existing errors carry structured data beside the message — the
 * mark-paid amount mismatch returns `expected` and `received` at the top
 * level — and the legacy envelope has to keep emitting them exactly there.
 * In v2 they land under `error.details` instead. Prefer `fields` for anything
 * new.
 *
 * The legacy `error` string is the message — not the code — because that is
 * what existing clients render directly to the user (see the mobile client's
 * `json['message'] ?? json['error']`). Sending a code there would put
 * "validation_error" in front of a merchant.
 */
function fail(req, res, {
  code = CODES.INTERNAL, message, fields, status, extra, legacyErrorIsCode = false
} = {}) {
  const httpStatus = status || STATUS_FOR_CODE[code] || 400;
  const text = message || 'Something went wrong';

  if (wantsV2(req)) {
    const error = { code, message: text };
    if (fields && Object.keys(fields).length) error.fields = fields;
    if (extra && Object.keys(extra).length) error.details = extra;
    return res.status(httpStatus).json({ success: false, error });
  }

  // A handful of pre-v2 responses put the CODE in `error` and the human text
  // in a sibling `message` — auth's `link_required` is the one that matters,
  // because mobile login branches on `e.code == 'link_required'` and the
  // client derives that code from the legacy `error` string. Emitting the
  // prose there instead would not fail loudly; Clerk-linked sign-in would
  // just stop recognising the case and show a generic error forever.
  if (legacyErrorIsCode) {
    return res.status(httpStatus).json({
      success: false, error: code, message: text, ...(extra || {})
    });
  }
  return res.status(httpStatus).json({ success: false, error: text, ...(extra || {}) });
}

/**
 * Terminal handler for an unexpected throw. Logs with the route's own label
 * and never leaks an internal message to the caller — the existing routes
 * are already careful about this and the helper must not regress it.
 */
function failInternal(req, res, logger, label, err) {
  logger.error('%s failed: %s', label, err.message, { stack: err.stack });
  return fail(req, res, { code: CODES.INTERNAL, message: 'Internal server error' });
}

/** Convenience wrappers for the three most repeated failures in the codebase. */
const notFound = (req, res, what = 'Resource') =>
  fail(req, res, { code: CODES.NOT_FOUND, message: `${what} not found` });

const forbidden = (req, res, message = 'Key does not match business') =>
  fail(req, res, { code: CODES.FORBIDDEN, message });

const invalid = (req, res, message, fields) =>
  fail(req, res, { code: CODES.VALIDATION, message, fields });

module.exports = {
  CODES,
  wantsV2,
  ok,
  fail,
  failInternal,
  notFound,
  forbidden,
  invalid
};
