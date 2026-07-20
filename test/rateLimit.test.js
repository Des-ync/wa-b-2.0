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
