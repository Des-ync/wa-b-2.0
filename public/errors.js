// Client-side error reporting.
//
// The companion to the CSP report endpoint. That one catches resources the
// browser BLOCKED; this one catches JavaScript that RAN and threw. Both are
// invisible server-side: a TypeError in dashboard.js returns 200 for every
// request, logs nothing, and leaves the merchant looking at a screen that
// silently stopped updating.
//
// This is the first-party floor, not a replacement for a real error-tracking
// product — there are no source maps, no release tracking, no breadcrumbs and
// no search UI here. It is what can be had without sending customer data to a
// third-party processor.
//
// Privacy is the constraint that shapes it. Query strings on these pages carry
// order ids and shop slugs, so URLs are stripped to their path before they
// leave the browser. Nothing else about the page is collected: no form values,
// no cookies, no storage, no user identifiers.
(function () {
  'use strict';

  var ENDPOINT = '/api/client-error';
  var MAX_PER_PAGE = 5;      // one broken render must not become a flood
  var sent = 0;
  var seen = {};

  /** Path only — query strings carry order ids and shop slugs. */
  function safeUrl(u) {
    if (!u) return '';
    try {
      var parsed = new URL(u, location.origin);
      return parsed.origin === location.origin ? parsed.pathname : parsed.origin + parsed.pathname;
    } catch (e) {
      return String(u).split('?')[0].slice(0, 200);
    }
  }

  /**
   * Errors worth nobody's attention.
   *
   * "Script error." is what a cross-origin script reports without CORS headers
   * — it carries no message, no file and no line, so it can never be acted on.
   * ResizeObserver loop warnings are benign browser noise. Extension frames are
   * not this app.
   */
  function isNoise(message, source) {
    var m = String(message || '');
    if (!m || m === 'Script error.' || m === 'Script error') return true;
    if (m.indexOf('ResizeObserver loop') === 0) return true;
    var s = String(source || '');
    return /^(chrome|moz|safari|safari-web)-extension:/.test(s);
  }

  function report(payload) {
    if (sent >= MAX_PER_PAGE) return;
    // The same error thrown in a render loop is one bug, not a thousand.
    var key = payload.message + '|' + payload.source + '|' + payload.line;
    if (seen[key]) return;
    seen[key] = true;
    sent++;

    var body = JSON.stringify(payload);
    // sendBeacon survives the page being closed, which is exactly when a fatal
    // error tends to happen. Falls back to fetch where it is unavailable.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* reporting must never itself throw */ }
  }

  window.addEventListener('error', function (ev) {
    if (isNoise(ev.message, ev.filename)) return;
    report({
      kind: 'error',
      message: String(ev.message || '').slice(0, 300),
      source: safeUrl(ev.filename),
      line: ev.lineno || 0,
      column: ev.colno || 0,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 1000) : '',
      page: safeUrl(location.href)
    });
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    if (isNoise(message, '')) return;
    report({
      kind: 'unhandledrejection',
      message: String(message || '').slice(0, 300),
      source: '',
      line: 0,
      column: 0,
      stack: reason && reason.stack ? String(reason.stack).slice(0, 1000) : '',
      page: safeUrl(location.href)
    });
  });
})();
