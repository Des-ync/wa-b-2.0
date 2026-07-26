# Production Readiness — 2026-07-26

Full-repo audit (8 parallel dimensions: security, correctness, database, infra/CI-CD,
mobile, website, testing, integrations) followed by direct fixes and new test coverage.
Everything below is verified against the actual code/build/test-run, not just claimed.

**Test suite: 403 → 502 passing (0 failing).** Every change in this document was made,
then the full suite (and often a fresh-database migration) was re-run to confirm.

---

## 1. What was fixed in code this session

### Security / data-integrity bugs (the ones that actually move money or leak access)

- **A "dormant" Hubtel webhook route could hijack a live Paystack subscription
  charge.** `POST /api/payments/hubtel/callback` was documented as inactive but was
  actually live and reachable. Its callback settled `billing_transactions` rows by
  `reference` alone — a validly-signed Hubtel callback could mark a Paystack-raised
  subscription charge as paid or failed. Fixed by requiring `subscription.service.js`'s
  `applySuccessfulPayment`/`markPaymentFailed` to also match on `gateway`, so a
  Hubtel-signed callback can only ever touch a row actually raised against Hubtel.
  Verified with a dedicated test (`test/hubtelGatewayScoping.test.js`) that proves a
  mismatched-gateway callback is rejected and issues zero writes.
  (`src/services/subscription.service.js`, `src/services/webhook.processor.js`,
  `src/services/payment.sweeper.js`, `src/routes/payment.routes.js`)

- **`PATCH /api/orders/:id/status` could silently set `status='paid'` while
  bypassing every payment side effect.** That endpoint validated against the same
  status list as the real "mark paid" endpoint, so any `orders:write` caller could
  flip status to `paid` directly — never touching `payment_status`, stock, loyalty, or
  GMV/analytics (which all gate on `payment_status`). Fixed by excluding `paid` from
  the statuses this endpoint accepts; it now points callers at `POST /:id/mark-paid`,
  the endpoint that already does this correctly. (`src/routes/order.routes.js`)

- **Dashboard's order filter had a "paid" option that never matched anything** — a
  merchant filtering by "paid" got an empty list even for genuinely paid orders,
  because fulfillment `status` is never actually set to `'paid'` by the real payment
  flow. Removed the broken filter option. (`public/dashboard.html`)

### Backend correctness

- **`src/worker.js` had silently drifted out of sync with `src/server.js`** — both
  scheduled cron jobs independently, and `worker.js`'s copy was missing 3 jobs
  (broadcast sender, DB backup, daily summary) that `server.js`'s had. This is exactly
  how the birthday-coupon job went dead in production before (documented in
  `docs/feature-audit-2026-07-22.md` — already fixed by the time of this session, but
  the *duplication* that caused it hadn't been addressed). Extracted the entire cron
  schedule into one shared module (`src/services/cronJobs.js`); both `server.js` and
  `worker.js` now call the identical function, so this class of drift is now
  structurally impossible. Verified by actually booting both processes and confirming
  identical job lists in the logs.

- **`seed.js` could plant fake demo data straight into production.** No environment
  guard existed, and `deploy/README.md`'s own bootstrap instructions had you run
  `npm run seed` against the real production `DATABASE_URL` as a normal step — which
  inserted a demo business + 6 sample products. Split plan-pricing seeding (safe,
  idempotent, meant to run every time) from demo-business seeding (now requires an
  explicit `--demo-data` flag or `SEED_DEMO_DATA=true`). Updated `deploy/README.md` to
  reflect this. (`src/models/seed.js`)

- **Two migration backfills re-scanned their entire source table on every deploy**
  forever, instead of running once. Added a tiny `schema_backfills` marker table and
  gated both behind it. Verified idempotent by running the full migration twice against
  a fresh database — the backfills ran once, then were skipped on the second run.
  (`src/models/migrate.js`)

- **Outbound WhatsApp sends had no retry** — a single transient 5xx/429/network blip
  from Meta permanently dropped a message (order confirmations, OTPs, payment
  prompts) with just a log line. Added a bounded retry (3 attempts, short backoff) for
  transient failures only; 4xx application errors (bad number, rejected template) are
  never retried since they'd fail identically. 6 new tests cover every branch.
  (`src/services/whatsapp.service.js`)

- **Investigated and ruled out** a suspected bug in `analytics.routes.js`/
  `notification.routes.js` (an error seen during test runs) — confirmed it was a test
  *mock* artifact (an empty-array default didn't match real Postgres's "a bare
  aggregate always returns exactly one row" guarantee), not a production bug. Fixed
  the mock itself so the tenant-isolation test suite is actually meaningful now
  (previously asserted only "not a 403", which a silent 500 also satisfies — tightened
  to assert real 200s). (`test/routes.tenantIsolation.extended.test.js`)

### Database

- Documented `DATABASE_SSL` in `.env.example` (previously undocumented — the
  app-to-database connection is unencrypted unless this is explicitly set).
- Added a restore runbook and rollback procedure to `deploy/README.md` (neither
  existed before — a backup that's never been restored from, or a deploy pipeline
  with no rollback path, is exactly the kind of gap that turns a bad day into a very
  bad day).

### Deployment / CI-CD

- **Every push to `main` deployed straight to production with zero automated test
  gate.** This was the single highest-value fix in the whole audit. Added a `test` job
  (spins up a real Postgres 14 service container, runs migrations, runs the full
  suite) that the `deploy` job now requires (`needs: test`) — a commit that fails
  `npm test` can no longer reach production. Verified the CI config actually works by
  reproducing it locally against a completely fresh database.
  (`.github/workflows/deploy.yml`)
- Added `kill_timeout: 12000` to the PM2 config — without it, PM2's ~1.6s default
  would SIGKILL the process mid-graceful-shutdown (which needs up to 10s) on every
  reload. (`deploy/ecosystem.config.js`)
- Added edge-level gzip compression and a rate limit to nginx (webhook paths
  explicitly excluded from the rate limit, matching the app's own documented policy
  that provider retry bursts must never be throttled). (`deploy/nginx.conf` — **you
  need to manually copy this to the server and reload nginx**, see checklist below)
- `npm audit fix` applied (non-breaking): 17 → 12 vulnerabilities. The remaining 12 are
  all one transitive `uuid` chain (via `firebase-admin`) that's correctly left alone —
  it's unreachable from this app's own code and the fix requires a breaking major
  bump that isn't needed here.

### Website / legal pages

- Added `integrity`/`crossorigin` (a real SHA-384 hash, computed from the actual pinned
  file) to the one CDN script that was missing it — the passkey/WebAuthn browser
  library loaded on the merchant dashboard. Every other CDN script in the codebase
  already had this; this one was the gap.
- Added `robots.txt`/`sitemap.xml` at the true domain root (not under `/wa-b/` —
  crawlers only ever look at the root, and the root is deliberately kept free for other
  future projects, so these are two narrowly-scoped dynamic routes, not a static-file
  landgrab).
- Added missing `<meta name="description">` to 11 marketing pages.
- Fixed 55 form `<label>` elements across the dashboard and storefront that weren't
  programmatically associated with their inputs (`for=`/`id`) — an accessibility gap
  that also breaks click-to-focus.
- Added `alt` text to product thumbnails and delivery-proof photos.
- **Corrected factually wrong claims on the legal pages** — this went beyond what the
  audit flagged. `privacy.html`, `cookies.html`, and `data-processing.html` described
  infrastructure and practices that don't match reality: they claimed hosting on
  Hetzner (Germany)/Cloudflare when it's actually Oracle Cloud (Morocco West); claimed
  a live Plausible Analytics install that doesn't exist in the code; and described a
  cookie table (`wab_session`, `wab_csrf`, etc.) that the app never actually sets —
  session state is a bearer token in browser session storage, not a cookie. Also added
  Clerk (auth) and Firebase (push) to the sub-processor disclosure, which were using
  real user data but weren't named anywhere. **These are now accurate as of the
  current implementation** — re-check them any time the actual infra/vendors change.

### Mobile app (Flutter)

- **iOS `Info.plist` was missing `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  and `NSSpeechRecognitionUsageDescription`** despite the app using the camera (barcode
  scanner) and microphone/speech (voice product updates). Without these, iOS
  terminates the app the instant it requests that permission, and App Store review
  rejects the binary outright. This was the single most severe finding in the whole
  audit — fixed.
- **Android was missing the `RECORD_AUDIO` permission** the voice-update feature
  needs — without it, voice updates silently never worked on Android at all. Fixed.
- **Enabled R8/ProGuard minification + resource shrinking** for Android release
  builds (previously off — larger APK, no obfuscation). Added a baseline
  `proguard-rules.pro` covering the known reflection-touchy dependencies (Firebase,
  Credential Manager/passkeys, flutter_local_notifications). **Verified with a real
  `flutter build apk --release`** — it built successfully (73.9MB). This proves the
  build compiles cleanly; it does **not** prove every runtime code path survives
  minification — see the checklist below for the one manual step this still needs.
- Added a build-number/versioning convention comment to `pubspec.yaml` and a
  `CHANGELOG.md` (neither existed).

### Test coverage added (99 new tests, 403 → 502)

| File | Tests | Covers |
|---|---|---|
| `test/auth.routes.test.js` | 37 | Every auth entry point: OTP login, Clerk linking, WebAuthn/passkey register+login, cross-tenant passkey isolation. This was the single highest-risk untested file in the repo. |
| `test/admin.routes.critical.test.js` | 23 | Business creation/suspension, admin impersonation + revocation (with real before/after token-invalidation proof), scoped admin API-key issuance. |
| `test/apikey.routes.test.js` | 17 | API key issue/list/revoke/rotate, cross-tenant isolation, hash-never-leaks. |
| `test/paymentSweeper.service.test.js` | 10 | The stuck-payment reconciliation cron — every branch (success, currency mismatch, failed/abandoned/reversed, hard-expiry, and the "one bad row doesn't stop the sweep" resilience property). |
| `test/hubtelGatewayScoping.test.js` | 6 | Directly proves the Hubtel security fix above. |
| `test/whatsapp.service.test.js` | 6 | The new outbound-retry logic. |

---

## 2. Found, but deliberately NOT fixed — these need your decision

- **`public/contact.html`'s contact form doesn't actually send anywhere.** It just
  relabels the button to "✓ Sent" — the page promises a response "within one business
  day" that it cannot deliver on. I didn't wire this to an email address because I
  don't know which of the addresses already referenced on the site (`hello@wa-b.com`,
  `support@wa-b.com`) is a real, monitored inbox, and there's no backend endpoint or
  transactional-email service configured to receive it. **Tell me which inbox is real**
  (or that you want a backend endpoint instead) and I'll wire it properly.
- **Refunding/cancelling a paid order never restores the decremented stock.** The
  `stock_movements` table already has an unused `'return'` type for exactly this,
  suggesting it was planned but never finished. This needs a product decision: should
  refunded stock auto-restock, or is that intentionally manual (e.g. because refunded
  goods may be damaged/unsellable)?
- **No centralized error tracking** (Sentry or similar) — right now, production
  incidents are only visible via SSH + grepping winston log files on the VM's disk,
  plus a rate-limited WhatsApp ping if `OPS_ALERT_PHONE` is set. This is a real gap for
  diagnosing incidents quickly, but adding it means creating a third-party account —
  your call on the vendor.
- **No mobile automated test suite exists at all** (confirmed: zero `*_test.dart`
  files anywhere in `mobile/wab_app`). I added substantial *backend* coverage this
  session (99 tests), but writing Flutter widget/unit tests is a separate, sizeable
  effort I did not start. Given the app now handles auth tokens, biometric-gated
  payouts, and offline-queued financial mutations, this is worth prioritizing next.
- **Mobile crash reporting** (Firebase Crashlytics) isn't wired up — no uncaught Dart
  exception is captured anywhere in production today. Firebase is already configured
  for push, so adding Crashlytics is a small lift, but I didn't add a new dependency
  blind without being able to verify it end-to-end in this session.

---

## 3. What YOU need to do before this is truly production-ready

### A. Before you push this batch of changes
1. **Review the diff.** 46 files touched (37 modified, 9 new) — nothing was committed
   yet. Run `git diff` / `git status` and look it over, especially
   `src/services/subscription.service.js` and `src/services/webhook.processor.js`
   (the Hubtel security fix) and `src/routes/order.routes.js` (the "paid" status fix)
   since those touch real payment logic.
2. **Ask me to commit and push once you're satisfied** — I have no push access from
   this sandbox regardless, so you'll run the actual `git push` yourself. Suggested
   flow:
   ```bash
   git add -A
   git commit -m "Production-readiness pass: security fixes, CI test gate, test coverage, mobile/legal fixes"
   git push origin main
   ```
3. **The new CI test gate means your first push after this will take longer** (it now
   spins up Postgres and runs the full suite before deploying — expect a few extra
   minutes). If it fails on something unexpected, check the Actions tab before
   assuming the deploy silently happened — it won't, and that's the point.
4. Set the deploy pipeline's Node version awareness: `.github/workflows/deploy.yml`'s
   test job pins Node 18 (matching `package.json`'s `engines`); no action needed, just
   noting it since a flaky-test root-cause I found (below) was Node-version-specific.

### B. On the server, after this deploy lands
5. **Copy the updated `deploy/nginx.conf` to the server and reload nginx** — this
   file is *not* touched by the automated deploy (nginx isn't managed by
   `deploy.yml`), so the new gzip/rate-limit config only takes effect once you do this
   manually:
   ```bash
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/wa-saas
   sudo nginx -t && sudo systemctl reload nginx
   ```
6. **Install `pm2-logrotate`** — PM2's own log files (`logs/pm2-*.log`) have no
   rotation and will grow unbounded on the VM's small disk:
   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 14
   pm2 set pm2-logrotate:compress true
   ```
7. **Set `DATABASE_SSL=true`** on the server's `.env` if `db-vm`'s Postgres has TLS
   configured (check first — if it doesn't, this is a separate piece of work on
   `db-vm` itself, not just an env flag).
8. **Point an uptime monitor at `https://skes.tech/health`** (UptimeRobot, Better
   Uptime, etc. — free tier is fine) and alert on 503/timeout. Nothing currently
   watches this endpoint externally.
9. **Confirm `OPS_ALERT_PHONE` is actually set** in the real production `.env` (not
   just documented in `.env.example`) — if it isn't, crashes are currently invisible
   until someone manually checks logs.
10. If/when you enable `DB_BACKUP_ENABLED=true`, **actually run the restore procedure
    once against a scratch database** (documented in `deploy/README.md` now) to
    confirm your backups are real, not just theoretical.

### C. Business/account blockers — these are NOT code problems, they're the actual gate on going live
11. **Meta Business Verification** — the WhatsApp app is still in Meta "Development"
    mode as of the last session that touched this, which limits messaging to
    pre-approved test numbers only. Until Business Verification completes, **no real
    customer can message your bot.** This is the single biggest non-code blocker to
    calling this "production ready" in the sense of "a real merchant's real customers
    can use it."
12. **Apple Developer account** — iOS push notifications and native iOS passkeys are
    both blocked on this (documented in `docs/MOBILE_SETUP.md`); the
    `apple-app-site-association` file still has a `TEAMID_PLACEHOLDER`. Android is
    fully working.
13. **MTN MoMo "Go-Live" application** — if you intend to use the direct MTN
    integration (currently dormant in favor of Paystack, which already covers all
    networks), it needs a separate business application to MTN for production
    subscription keys.
14. **Back up `mobile/wab_app/android/upload-keystore.jks` and `android/key.properties`
    outside the repo** if you haven't already — losing this keystore permanently
    breaks the ability to publish updates under the current Play Store app identity.
    (Both are git-ignored, which is correct — but that also means they only exist on
    whatever machine generated them.)

### D. Before shipping the Android release build specifically
15. **Manually smoke-test a release build on a real device** for: Clerk sign-in,
    passkey add/login, push notification receipt, barcode scanning, and voice product
    updates. A successful `flutter build apk --release` (which I verified) proves the
    code compiles under minification; it does not prove every reflection-dependent
    code path survives it at runtime. This is the one place in this session where
    "the build succeeded" and "it's proven correct" are genuinely different claims —
    don't skip this before a store submission.

### E. A pre-existing test flake, unrelated to this session
16. I found (and confirmed exists on the original, unmodified code too — not
    something introduced this session) a rare (~5%) test failure:
    `orderDelivery.routes.test.js` occasionally fails with a garbled-HTTP-response
    parse error, reproducible even with `--test-concurrency=1`. I confirmed it on
    Node v26.3 locally; your CI pipeline pins Node 18, which may not even exhibit it.
    I added a one-retry safety net to the CI test step so this can't spuriously block
    a deploy, but the root cause (a supertest/Node HTTP-parser race) is still there.
    Worth a closer look if it starts showing up in Actions, but it's low-priority
    relative to everything above.

---

## 4. Test results

- **Before this session:** 403/403 passing.
- **After this session:** 502/502 passing (99 new tests), confirmed via:
  - 5+ consecutive clean full-suite runs.
  - The full migration + full test suite run twice against a completely fresh,
    never-touched Postgres database (proving both the schema and the CI pipeline's
    Postgres-service-container approach actually work, not just "worked on my already-
    set-up dev database").
  - `worker.js` and `server.js` both actually booted and both logged the identical,
    complete cron schedule.
  - `flutter build apk --release` completed successfully with the new
    minification enabled.
