const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');

// Mirrors the apiLimiter config in server.js, at a much smaller `max` so
// the test doesn't need to fire 120+ requests to observe the 429.
function buildLimitedApp(max) {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, slow down.' }
  });
  app.use('/api/test', limiter);
  app.get('/api/test/ping', (_req, res) => res.json({ success: true }));
  return app;
}

test('requests under the limit succeed', async () => {
  const app = buildLimitedApp(5);
  for (let i = 0; i < 5; i++) {
    const res = await request(app).get('/api/test/ping');
    assert.equal(res.status, 200);
  }
});

test('the request that exceeds the limit gets a 429 with the configured message', async () => {
  const app = buildLimitedApp(3);
  for (let i = 0; i < 3; i++) {
    const res = await request(app).get('/api/test/ping');
    assert.equal(res.status, 200);
  }
  const blocked = await request(app).get('/api/test/ping');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);
  assert.equal(blocked.body.error, 'Too many requests, slow down.');
});

test('rate limit headers are present on responses (standardHeaders: true)', async () => {
  const app = buildLimitedApp(5);
  const res = await request(app).get('/api/test/ping');
  assert.ok(res.headers['ratelimit-limit'] !== undefined || res.headers['x-ratelimit-limit'] !== undefined);
});

test('requests to an unthrottled path are never limited', async () => {
  const app = buildLimitedApp(1);
  app.get('/api/other/ping', (_req, res) => res.json({ success: true }));
  await request(app).get('/api/test/ping'); // consume the only slot on the limited path
  for (let i = 0; i < 10; i++) {
    const res = await request(app).get('/api/other/ping');
    assert.equal(res.status, 200);
  }
});

/**
 * Auth is rate-limited more tightly than the rest of the API.
 *
 * A static assertion rather than a live burst test, because the limiter is
 * wired in server.js at require time and booting the real app in a unit test
 * would start a listener. What matters is that the auth mount is NOT sharing
 * the general 120/min bucket with product listings.
 */
test('the auth routes get their own, tighter limiter', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  assert.match(src, /app\.use\('\/api\/auth', authLimiter, authRoutes\)/,
    'auth must not share the general apiLimiter');

  // Pull the limiter's own config out and check it is actually stricter.
  const block = src.slice(src.indexOf('const authLimiter'), src.indexOf('app.use(\'/api/auth\''));
  const max = Number((block.match(/max:\s*(\d+)/) || [])[1]);
  const windowMs = eval((block.match(/windowMs:\s*([\d\s*_]+),/) || [])[1]);
  const general = src.slice(src.indexOf('const apiLimiter'), src.indexOf('app.use(\'/api/webhooks\''));
  const generalMax = Number((general.match(/max:\s*(\d+)/) || [])[1]);
  const generalWindow = eval((general.match(/windowMs:\s*([\d\s*_]+),/) || [])[1]);

  assert.ok(max / windowMs < generalMax / generalWindow,
    `auth allows ${max}/${windowMs}ms which is not stricter than the general ${generalMax}/${generalWindow}ms`);
});

test('webhooks are still exempt from rate limiting', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  // Meta and Paystack retry in bursts; throttling them into a 429 loses data
  // that is not re-delivered indefinitely.
  assert.match(src, /app\.use\('\/api\/webhooks', webhookRoutes\)/,
    'a rate limiter on webhooks would turn a retry burst into lost orders');
});
