const crypto = require('crypto');
const { run } = require('../utils/requestContext');

/**
 * Assigns (or reuses, from an upstream proxy) a request id, echoes it back
 * as X-Request-Id, and runs the rest of the request inside an
 * AsyncLocalStorage context so every log line downstream — sync or async —
 * automatically carries it. Mount this FIRST, before anything else.
 */
function requestIdMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  run({ requestId }, () => next());
}

module.exports = { requestIdMiddleware };
