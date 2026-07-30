const test = require('node:test');
const assert = require('node:assert/strict');

const respond = require('../src/utils/response');

/** Minimal express req/res doubles — enough to capture status + JSON body. */
function reqWith(version) {
  const headers = version ? { 'x-api-version': String(version) } : {};
  return { headers, get: (h) => headers[h.toLowerCase()] };
}

function res() {
  const r = { statusCode: 200, body: undefined };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('legacy is the default and is byte-for-byte the old shape', () => {
  const r = res();
  respond.ok(reqWith(), r, { orders: [{ id: 1 }] }, { meta: { total: 1 } });

  // Exactly what the un-migrated routes return today: flat, no `data`,
  // no `meta` wrapper. A deployed mobile build or dashboard.html must not
  // be able to tell that the route was migrated.
  assert.deepEqual(r.body, { success: true, orders: [{ id: 1 }], total: 1 });
  assert.equal(r.statusCode, 200);
});

test('v2 nests under data and meta', () => {
  const r = res();
  respond.ok(reqWith(2), r, { orders: [{ id: 1 }] }, { meta: { total: 1 } });

  assert.deepEqual(r.body, {
    success: true,
    data: { orders: [{ id: 1 }] },
    meta: { total: 1 }
  });
});

test('v2 omits meta entirely when there is none', () => {
  const r = res();
  respond.ok(reqWith(2), r, { product: { id: 1 } });
  assert.deepEqual(r.body, { success: true, data: { product: { id: 1 } } });
});

test('only an explicit "2" opts in — anything else stays legacy', () => {
  // A garbled or forward-dated header must never silently change the shape
  // a client receives; the failure mode would be a blank screen in the field.
  for (const v of [undefined, '', '1', '2.0', 'v2', 'two', '3', 'null']) {
    const r = res();
    respond.ok(reqWith(v), r, { x: 1 });
    assert.deepEqual(r.body, { success: true, x: 1 }, `header "${v}" should be legacy`);
  }
});

test('a numeric header value still opts in', () => {
  const r = res();
  respond.ok({ headers: { 'x-api-version': 2 }, get: () => 2 }, r, { x: 1 });
  assert.deepEqual(r.body, { success: true, data: { x: 1 } });
});

test('status overrides carry through both envelopes', () => {
  const legacy = res();
  respond.ok(reqWith(), legacy, { product: {} }, { status: 201 });
  assert.equal(legacy.statusCode, 201);

  const v2 = res();
  respond.ok(reqWith(2), v2, { product: {} }, { status: 201 });
  assert.equal(v2.statusCode, 201);
});

test('legacy errors stay a plain string, because clients render it directly', () => {
  const r = res();
  respond.fail(reqWith(), r, {
    code: respond.CODES.VALIDATION,
    message: 'Product name is required',
    fields: { name: 'is required' }
  });

  // Not the code — the mobile client does `json['message'] ?? json['error']`
  // and shows the result to a merchant. "validation_error" in front of a
  // human is the bug this guards against.
  assert.deepEqual(r.body, { success: false, error: 'Product name is required' });
  assert.equal(r.statusCode, 400);
});

test('v2 errors carry code, message and per-field reasons', () => {
  const r = res();
  respond.fail(reqWith(2), r, {
    code: respond.CODES.VALIDATION,
    message: 'Product name is required',
    fields: { name: 'is required', price_ghs: 'must be a number' }
  });

  assert.deepEqual(r.body, {
    success: false,
    error: {
      code: 'validation_error',
      message: 'Product name is required',
      fields: { name: 'is required', price_ghs: 'must be a number' }
    }
  });
});

test('v2 omits fields when there are none', () => {
  const r = res();
  respond.fail(reqWith(2), r, { code: respond.CODES.NOT_FOUND, message: 'Order not found' });
  assert.deepEqual(r.body.error, { code: 'not_found', message: 'Order not found' });
});

test('each code maps to its conventional HTTP status', () => {
  const expected = {
    validation_error: 400, unauthorized: 401, forbidden: 403, not_found: 404,
    conflict: 409, rate_limited: 429, upstream_error: 502, internal_error: 500
  };
  for (const [code, status] of Object.entries(expected)) {
    const r = res();
    respond.fail(reqWith(), r, { code, message: 'x' });
    assert.equal(r.statusCode, status, code);
  }
});

test('an explicit status beats the code default', () => {
  const r = res();
  respond.fail(reqWith(), r, { code: respond.CODES.VALIDATION, message: 'x', status: 422 });
  assert.equal(r.statusCode, 422);
});

test('the shorthand helpers match the messages the routes already send', () => {
  const nf = res();
  respond.notFound(reqWith(), nf, 'Order');
  assert.deepEqual(nf.body, { success: false, error: 'Order not found' });
  assert.equal(nf.statusCode, 404);

  const fb = res();
  respond.forbidden(reqWith(), fb);
  assert.deepEqual(fb.body, { success: false, error: 'Key does not match business' });
  assert.equal(fb.statusCode, 403);
});

test('failInternal logs the real error but never returns it', () => {
  const logged = [];
  const logger = { error: (...a) => logged.push(a) };
  const r = res();

  respond.failInternal(reqWith(2), r, logger, 'GET /orders', new Error('connection string leaked'));

  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error.message, 'Internal server error');
  assert.ok(!JSON.stringify(r.body).includes('connection string'),
    'an internal message must never reach the client');
  assert.match(logged[0].join(' '), /GET \/orders/);
});
