/**
 * Request-scoped context (request id + tenant/business id) via
 * AsyncLocalStorage, so every log line emitted anywhere during a request —
 * or during async work spawned from a webhook event — automatically carries
 * both, without threading them through every function signature.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function run(context, fn) {
  return als.run({ ...context }, fn);
}

function getContext() {
  return als.getStore() || {};
}

/** Attach the tenant once it's known mid-request (auth middleware, or once a webhook resolves its business). */
function setBusinessId(businessId) {
  const store = als.getStore();
  if (store) store.businessId = businessId;
}

module.exports = { run, getContext, setBusinessId };
