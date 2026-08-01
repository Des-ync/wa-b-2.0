const express = require('express');
const logger = require('../utils/logger');
const { alertOps } = require('../services/alert.service');

const router = express.Router();

/**
 * Where JavaScript exceptions in the browser get reported.
 *
 * The companion to /api/csp-report. That endpoint hears about resources the
 * browser BLOCKED; this one hears about code that RAN and threw. Both describe
 * failures the server cannot see: a TypeError in dashboard.js still returns
 * 200 for every request and logs nothing, while the merchant watches a screen
 * that quietly stopped updating.
 *
 * This is the first-party floor for decision #13, not an answer to it. There
 * are no source maps, no release tracking, no breadcrumbs, no search. What it
 * does provide is the thing that was missing entirely: somebody finding out.
 *
 * Unauthenticated by necessity — an error can fire before login, and often
 * does — so the body is treated as hostile: filtered, truncated, never echoed.
 */

const IGNORED_SOURCE_SCHEMES = ['chrome-extension', 'moz-extension', 'safari-extension', 'safari-web-extension'];

/**
 * Messages that are structurally unactionable.
 *
 * 'Script error.' is what a cross-origin script reports without CORS headers:
 * no file, no line, no stack. It cannot be investigated, so alerting on it
 * only teaches people to ignore the alerts.
 */
const NOISE_PATTERNS = [
  /^script error\.?$/i,
  /^ResizeObserver loop/i,
  /^Load failed$/i,
  /^NetworkError/i,
  /^AbortError/i,
  /Failed to fetch$/i
];

function isNoise(report) {
  const msg = String(report.message || '').trim();
  if (!msg) return true;
  if (NOISE_PATTERNS.some(re => re.test(msg))) return true;
  const src = String(report.source || '');
  return IGNORED_SOURCE_SCHEMES.some(s => src.toLowerCase().startsWith(s + ':'));
}

const trim = (v, n) => String(v == null ? '' : v).slice(0, n);

/**
 * Strips anything that could carry customer data.
 *
 * The browser already sends paths rather than full URLs, but a report is
 * untrusted input and a caller can post whatever it likes — so the query
 * string is removed again here rather than trusted to have been removed.
 */
function pathOnly(v) {
  return trim(v, 200).split('?')[0].split('#')[0];
}

function normalize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const message = trim(body.message, 300).trim();
  if (!message) return null;
  return {
    kind: body.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error',
    message,
    source: pathOnly(body.source),
    line: Number.isFinite(Number(body.line)) ? Number(body.line) : 0,
    stack: trim(body.stack, 1000),
    page: pathOnly(body.page)
  };
}

/**
 * One alert per distinct error, per process — the same reasoning as the CSP
 * endpoint. An error inside a render loop fires on every frame for every
 * visitor; alerting per report would take the ops phone down instead of the
 * dashboard. In memory so a restart re-reports, which is what makes the first
 * deploy after a bad change say something.
 */
const seen = new Set();
const MAX_SIGNATURES = 200;

function signatureOf(r) {
  return `${r.kind}|${r.message}|${r.source}|${r.line}|${r.page}`;
}

router.post('/', (req, res) => {
  // Answer first, always. Reporting must never delay or fail a page.
  res.status(204).end();

  const report = normalize(req.body);
  if (!report) return;
  if (isNoise(report)) return;

  const sig = signatureOf(report);
  if (seen.has(sig)) return;
  if (seen.size >= MAX_SIGNATURES) {
    logger.warn('client-error: signature cap reached, dropping new reports');
    return;
  }
  seen.add(sig);

  const where = report.source ? `${report.source}:${report.line}` : '(no source)';
  const detail = `${report.kind}: ${report.message}\n`
    + `at: ${where}\n`
    + `page: ${report.page}`
    + (report.stack ? `\n\n${report.stack.slice(0, 400)}` : '');

  logger.error('Client error (first occurrence): %s | %s | %s',
    report.message, where, report.page);
  alertOps('Client error', detail);
});

module.exports = router;
module.exports._testing = { normalize, isNoise, signatureOf, pathOnly, seen };
