const test = require('node:test');
const assert = require('node:assert/strict');

// node-cron is stubbed out entirely: this suite is about the registration
// guards, and actually scheduling a dozen real timers would keep the test
// process alive. Stub before requiring cronJobs, which binds cron at require
// time.
const cron = require('node-cron');
const scheduled = [];
cron.schedule = (expression, fn, opts) => {
  scheduled.push({ expression, fn, opts });
  return { stop() {} };
};

const cronJobs = require('../src/services/cronJobs');

test.beforeEach(() => {
  scheduled.length = 0;
  cronJobs.__resetForTests();
});

test('startCronJobs schedules every job exactly once, all on Africa/Accra', () => {
  cronJobs.startCronJobs();

  assert.ok(scheduled.length >= 11, `expected the full job list, got ${scheduled.length}`);
  for (const job of scheduled) {
    assert.equal(job.opts.timezone, 'Africa/Accra',
      `job "${job.expression}" is not pinned to Africa/Accra`);
  }

  // No two jobs may share a schedule AND be the same function — that is the
  // shape a copy-paste duplicate takes.
  const seen = new Set();
  for (const job of scheduled) {
    const key = `${job.expression}::${job.fn.toString()}`;
    assert.ok(!seen.has(key), `duplicate job registered for "${job.expression}"`);
    seen.add(key);
  }
});

test('calling startCronJobs twice in one process throws instead of double-firing', () => {
  cronJobs.startCronJobs();
  const firstCount = scheduled.length;

  assert.throws(() => cronJobs.startCronJobs(), /already run in this process/);

  assert.equal(scheduled.length, firstCount,
    'the rejected second call must not have scheduled anything');
});

test('the whole job list survives a reset — the guard is not a one-shot fuse', () => {
  cronJobs.startCronJobs();
  const first = scheduled.map(j => j.expression);

  scheduled.length = 0;
  cronJobs.__resetForTests();
  cronJobs.startCronJobs();

  assert.deepEqual(scheduled.map(j => j.expression), first);
});

test('the known jobs are all present', () => {
  cronJobs.startCronJobs();
  const expressions = scheduled.map(j => j.expression);
  // The two that were historically at risk: the birthday coupon (which once
  // lived only in worker.js and never fired in production) and the broadcast
  // drain (whose duplicate would double-send to real customers).
  assert.ok(expressions.includes('0 7 * * *'), 'birthday coupon job missing');
  assert.ok(expressions.includes('* * * * *'), 'broadcast drain missing');
  assert.ok(expressions.includes('*/5 * * * *'), 'payment sweeper missing');
  assert.ok(expressions.includes('*/15 * * * *'), 'cart nudge missing');
  assert.ok(expressions.includes('*/30 * * * *'), 'lifecycle automations missing');
});
