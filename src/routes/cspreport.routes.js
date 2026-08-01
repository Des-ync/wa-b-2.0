const express = require('express');
const logger = require('../utils/logger');
const { alertOps } = require('../services/alert.service');

const router = express.Router();

/**
 * Where CSP violations get reported.
 *
 * This exists because of a specific failure. Tightening `style-src` blocked
 * the <style> element Clerk injects to skin its sign-in widget, so the login
 * form rendered as unstyled browser defaults — in production, on the auth
 * path — and nothing anywhere raised a signal. It was found by a human
 * opening the page and looking at it. Every visitor's browser knew, and had
 * nowhere to say so.
 *
 * A blocked resource is exactly the class of bug that is invisible
 * server-side: nothing throws, no request 500s, the HTML is byte-perfect. The
 * browser is the only party that can see it. So it is given somewhere to
 * report to.
 *
 * Deliberately unauthenticated — browsers send these with no credentials and
 * will not negotiate — and therefore treated as untrusted, unrated input:
 * heavily rate-limited upstream, filtered, truncated, and never echoed back.
 */

/**
 * Extension-injected content is the overwhelming majority of real-world CSP
 * reports and says nothing about this app. A password manager restyling a
 * login form is not a regression.
 */
const IGNORED_SCHEMES = [
  'chrome-extension', 'moz-extension', 'safari-extension', 'safari-web-extension',
  'webkit-masked-url', 'resource', 'chrome', 'about', 'blob', 'null'
];

function isIgnorable(blockedUri, sourceFile) {
  const candidates = [blockedUri, sourceFile].filter(Boolean).map(String);
  return candidates.some(v => IGNORED_SCHEMES.some(s => v.toLowerCase().startsWith(s + ':')));
}

/**
 * Reports arrive in two shapes: the legacy `application/csp-report` body with
 * a `csp-report` key, and the Reporting API's `application/reports+json`
 * array. Normalising both here keeps the rest of this file shape-agnostic.
 */
function normalize(body) {
  if (Array.isArray(body)) {
    return body
      .filter(r => r && r.type === 'csp-violation' && r.body)
      .map(r => ({
        directive: r.body.effectiveDirective || r.body.violatedDirective,
        blockedUri: r.body.blockedURL,
        documentUri: r.body.documentURL,
        sourceFile: r.body.sourceFile
      }));
  }
  const r = body && body['csp-report'];
  if (!r) return [];
  return [{
    directive: r['effective-directive'] || r['violated-directive'],
    blockedUri: r['blocked-uri'],
    documentUri: r['document-uri'],
    sourceFile: r['source-file']
  }];
}

const trim = (v, n) => String(v == null ? '' : v).slice(0, n);

/**
 * One alert per distinct violation, per process.
 *
 * A violation fires on every page view by every visitor, so alerting per
 * report would be a self-inflicted outage. Keyed in memory rather than in the
 * database on purpose: the map empties on restart, so the first deploy after
 * a bad change re-reports it instead of staying quiet because an earlier
 * release had already mentioned it.
 */
const seen = new Set();
const MAX_SIGNATURES = 200;

function signatureOf(v) {
  // Path only — query strings carry order ids and shop slugs.
  let docPath = '';
  try { docPath = new URL(v.documentUri).pathname; } catch { docPath = trim(v.documentUri, 80); }
  return `${v.directive}|${trim(v.blockedUri, 120)}|${docPath}`;
}

router.post('/', (req, res) => {
  // Answer first and always. A browser must never be made to wait on this,
  // and a report that cannot be parsed is still not the reporter's problem.
  res.status(204).end();

  let violations;
  try {
    violations = normalize(req.body);
  } catch (err) {
    logger.warn('csp-report: unparseable body: %s', err.message);
    return;
  }

  for (const v of violations) {
    if (!v.directive) continue;
    if (isIgnorable(v.blockedUri, v.sourceFile)) continue;

    const sig = signatureOf(v);
    if (seen.has(sig)) continue;
    if (seen.size >= MAX_SIGNATURES) {
      // Bounded so a hostile or noisy client cannot grow this without limit.
      logger.warn('csp-report: signature cap reached, dropping new violations');
      return;
    }
    seen.add(sig);

    const detail = `directive: ${trim(v.directive, 100)}\n`
      + `blocked: ${trim(v.blockedUri, 200)}\n`
      + `page: ${trim(v.documentUri, 200)}`;
    logger.warn('CSP violation (first occurrence): %s', detail.replace(/\n/g, ' | '));
    alertOps('CSP violation', detail);
  }
});

module.exports = router;
module.exports._testing = { normalize, isIgnorable, signatureOf, seen };
