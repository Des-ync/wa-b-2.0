# KweliChat / WA-B — Improvement Plan 2026 (corrected, evidence-backed)

**Status:** Phases 0–7 complete (§5–§11); Phases 8 and 9 started (§13, §12). Phase 3's envelope migration covers 22 of 26 route
groups; the four left out are deliberate. Phases 5–9 not started.
**Produced:** 2026-07-30, at commit `4d8d48b`.
**Supersedes:** `improvement-prompt.md` as the execution plan. That file remains the
statement of intent; this file is the version corrected against the actual code.

---

## 0. Headline finding

**The improvement prompt was written against a stale snapshot of this repo.** Of the ten
Source A claims it asks to verify, **seven are already fixed**, one is **partially fixed**,
one is **wrong as stated** (the premise it rests on no longer exists), and one is
**confirmed**. Large parts of Phases 1, 3, 4 and 6 are already shipped — most of them in
commits `56d4b18` / `f38d057` / `a173d94` / `3cb391d`.

Implementing this plan as written would mean re-building working code. The corrected
plan below keeps only what is genuinely missing, and re-sequences accordingly.

The single largest genuinely-open item is **Phase 8's mobile test suite: still zero test
files**, in an app that holds auth tokens and gates payouts behind biometrics.

---

## 1. Claim-by-claim verification (Phase 0, step 2)

| # | Claim (from `improvement-prompt.md` §Phase 0) | Verdict | Evidence |
|---|---|---|---|
| 1 | Mobile "mark paid" doesn't run the webhook pipeline; cash sales miss GMV/analytics/loyalty | **ALREADY FIXED** | `POST /api/orders/:id/mark-paid` at [src/routes/order.routes.js:315](../src/routes/order.routes.js#L315) calls `orderService.markOrderPaid` — the *same* function the gateway path uses ([src/services/conversation.handler.js:2470](../src/services/conversation.handler.js#L2470)). `PATCHABLE_STATUSES` ([order.routes.js:268](../src/routes/order.routes.js#L268)) now **excludes** `paid`, and `PATCH /:id/status` returns a 400 pointing at the correct route. Mobile calls it: [order_api.dart:12](../mobile/wab_app/lib/api/order_api.dart#L12) ← [order_action_sheets.dart:63](../mobile/wab_app/lib/widgets/order_action_sheets.dart#L63). Covered by 5 tests in [test/orderMarkPaid.routes.test.js](../test/orderMarkPaid.routes.test.js). |
| 2 | WhatsApp drops natural-language quantity; IG/Messenger parse it | **ALREADY FIXED** | The free-text intent block at [conversation.handler.js:947–999](../src/services/conversation.handler.js#L947) is no longer channel-gated; the comment at L941–946 documents the fix explicitly. `case 'PRODUCT'` (L986) rewrites to the canonical `Nx name`, and `tryTypedProductAdd` honours `explicit.quantity` ([L1709](../src/services/conversation.handler.js#L1709)). |
| 3 | `history` / `refunds` / `payment_attempts` returned but discarded by `order_detail.dart` | **ALREADY FIXED** | All three are read at [order_detail.dart:47–49](../mobile/wab_app/lib/screens/order_detail.dart#L47) and rendered — history timeline L189/L581–591, refunds L67, payment attempts L482–492. |
| 4 | Rider phone captured in DB but dropped before the API response | **ALREADY FIXED** | `rider_phone` is returned by the receipt API ([receipt.routes.js:85](../src/routes/receipt.routes.js#L85), with a comment justifying it being unmasked) and reaches the order API via `SELECT *` ([order.service.js:350](../src/services/order.service.js#L350)); rendered at [order_detail.dart:525](../mobile/wab_app/lib/screens/order_detail.dart#L525). |
| 5 | Gateway failure reasons dropped before customer message and merchant view | **PARTIAL** | Fixed for the customer: `normalizeFailureReason` ([webhook.processor.js:48–75](../src/services/webhook.processor.js#L48)) maps both Paystack free-text and MTN's enum onto shared categories, passed to `handlePaymentFailure({reference, reason})` ([conversation.handler.js:2569](../src/services/conversation.handler.js#L2569)) → `payment_failed_retry` i18n template + dashboard notification. Persisted as an `order_status_history` event `payment:failed` with `note = reason` ([order.service.js:905](../src/services/order.service.js#L905)). **Still open:** the *raw* gateway code is persisted nowhere — `payment_attempts` has only `reference, order_id, method, created_at` ([migrate.js:431–436](../src/models/migrate.js#L431)) — and `GET /orders/:id` selects only those columns ([order.routes.js:440](../src/routes/order.routes.js#L440)). The merchant sees a normalized category in the timeline, never the raw code, and an attempt row carries no success/failure state. |
| 6 | No `address` column on customers; address re-prompted every order | **ALREADY FIXED** (with a gap) | `ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT` at [migrate.js:243](../src/models/migrate.js#L243), written on successful checkout at [conversation.handler.js:2176](../src/services/conversation.handler.js#L2176). **Still open:** no `address_note`, and no delivery-zone reference on the customer row. |
| 7 | Guided onboarding is web-only and unreachable from mobile | **ALREADY FIXED** | [onboarding_checklist.dart](../mobile/wab_app/lib/screens/onboarding_checklist.dart) (350 lines), reachable from [home.dart:319](../mobile/wab_app/lib/screens/home.dart#L319) and [more.dart:100](../mobile/wab_app/lib/screens/more.dart#L100), backed by [onboarding_api.dart](../mobile/wab_app/lib/api/onboarding_api.dart). |
| 8 | Cron jobs consolidated into one shared module — **confirm still consolidated** | **CONFIRMED** (guard still missing) | [src/services/cronJobs.js](../src/services/cronJobs.js) is the sole `cron.schedule` site in the codebase; both entry points call it once — [server.js:404](../src/server.js#L404), [worker.js:31](../src/worker.js#L31). The module docstring records why. **Still open:** no assertion or test fails if a job is registered twice, and no test file references `cronJobs` at all. |
| 9 | `notifyOrderStatusChange` has an unused hook point on `delivered` | **WRONG AS STATED** | `delivered` is a live key in `STATUS_KEYS` ([notification.service.js:311](../src/services/notification.service.js#L311)) — it already notifies. Post-purchase review was not built on that hook; it is a generic automation, `post_purchase_review` ([automations.js:38](../src/services/automations.js#L38), handler at L180), driven by a query over `order_status_history` events `status:delivered` (L162–165). Phase 6's premise — "use the existing unused hook" — no longer applies. |
| 10 | Zero `*_test.dart` files exist in the mobile app | **CONFIRMED** | `find mobile -name "*_test.dart" -not -path "*/.dart_tool/*"` → **0 results**. No `mobile/wab_app/test/` directory exists. |

### Corrections to the plan that follow from this

- **Phase 1 is ~80% already shipped.** What remains is listed in §2 below and is small.
- **Phase 3's `order_detail.dart` rebuild is done** — the file is 723 lines and already
  carries rider assignment, ETA, refunds, the full payment timeline, receipt link + copy,
  internal notes, and humanized labels (`'pending' || 'unpaid' => 'Awaiting payment'`,
  [common.dart:470](../mobile/wab_app/lib/widgets/common.dart#L470)).
- **Phase 6's automation engine already exists** ([src/services/automations.js](../src/services/automations.js),
  [automations.routes.js](../src/routes/automations.routes.js), [automations.dart](../mobile/wab_app/lib/screens/automations.dart)).
  The instruction "do not copy-paste the cart_nudge cron six more times" was already heeded.
- **Phase 5's receipt work is largely done** — merchant logo, order timeline, refund policy
  and a genuine `wa.me/?text=` share (not a fixed link) are all in [public/receipt.html](../public/receipt.html).

---

## 2. Corrected phase plan

Phases are renumbered to reflect what is actually left. Effort tags: **S** ≤1 day,
**M** 2–4 days, **L** ≥1 week.

### Phase 1 — Close the residual backend-correctness gaps (**M**)

Everything the original Phase 1 asked for *except* the parts already shipped.

| Task | Files | Acceptance |
|---|---|---|
| 1.1 Persist gateway failure state on `payment_attempts`: add `status` (`pending`/`success`/`failed`), `failure_code` (raw gateway string), `failure_reason` (normalized category), `failed_at`. | `src/models/migrate.js`, `src/services/order.service.js` (`markOrderFailed`, `attachPaymentReference`), `src/services/webhook.processor.js` | A failed Paystack charge writes the raw `gateway_response` verbatim to `failure_code` and the normalized category to `failure_reason`. Test asserts both. |
| 1.2 Surface the raw code in the merchant order view: widen the `payment_attempts` select in `GET /orders/:id`; render it in the mobile payment timeline. | `src/routes/order.routes.js:440`, `mobile/wab_app/lib/screens/order_detail.dart:482` | Merchant sees `NOT_ENOUGH_FUNDS` (raw) alongside the humanized line; customer message is unchanged. |
| 1.3 Prove the two paid-paths are equivalent. Write a test that runs a cash sale through `POST /:id/mark-paid` and an identical sale through the webhook, then asserts the resulting `orders` row, `order_status_history` events, loyalty ledger and stock deltas match field-for-field (excluding `payment_method`, `payment_ref` and timestamps). | `test/order.paidPathParity.test.js` (new) | The original plan's stated acceptance criterion, now actually enforced by CI. |
| 1.4 Reconciliation script for orders paid through the historical broken path (status flipped to `paid` while `payment_status` stayed `pending`/`unpaid`). **Report first, mutate only behind an explicit `--apply` flag.** | `src/jobs/reconcile.paidStatus.js` (new) | Dry run prints affected order ids, GMV delta and loyalty delta per business. `--apply` is idempotent and re-runnable. |
| 1.5 Cron double-registration guard. `startCronJobs()` throws if called twice; each job registers through a small `register(name, expr, fn)` helper that throws on duplicate name. | `src/services/cronJobs.js`, `test/cronJobs.test.js` (new) | Test asserts a second `startCronJobs()` throws, and that registering a duplicate job name throws. |
| 1.6 Add the two genuinely-missing Today aggregates to the **existing** endpoint: `low_stock_count` and `failed_payments_today`. (`new_customers_count`, `messages_needing_reply_count` and `open_orders` already exist — [order.routes.js:40–90](../src/routes/order.routes.js#L40).) Drop the mobile home screen's separate `/api/inventory/reorder-suggestions` round trip for the *count*; keep it for the drill-down sheet. | `src/routes/order.routes.js`, `mobile/wab_app/lib/screens/home.dart:47–55`, `test/orderStatsToday.routes.test.js` | Home screen makes one fewer request on cold load; both new fields covered by tests. |
| 1.7 Add `address_note` to `customers` and wire it through checkout + reorder. | `src/models/migrate.js`, `src/services/conversation.handler.js:2176` | Reorder offers back the stored address **and** note without re-prompting. |

**Blocked in this phase:** nothing. All seven tasks are unblocked.

### Phase 2 — Mobile test suite from zero (**M**) — *promoted from Phase 8*

Promoted because it is the only **CONFIRMED** finding from Phase 0, it guards the highest-risk
surfaces in the product, and every later mobile change is safer behind it.

- Scaffold `mobile/wab_app/test/`, add `flutter_test` + `mocktail` to dev deps, add a
  `flutter test` step to `.github/workflows/deploy.yml` alongside `npm test`.
- First four suites, in order: **auth/token refresh** (`state/session.dart`),
  **payout biometric gating** (`services/biometric_gate.dart`), **order state rendering**
  (`widgets/common.dart` `StatusChip` label mapping), **the API layer**
  (`api/*_api.dart` — path and body shape assertions).
- **Acceptance:** CI fails on a broken Dart test; the four suites above are green.

### Phase 3 — Contracts and validation (**L**) — *was Phase 2*

- Response helper + compatibility shim, then migrate route groups one at a time.
  There is no `src/utils/response.js` today; envelopes are hand-rolled per route
  (`{success, order}`, `{success, orders}`, `{success, stats}`…).
- Shared request-validation layer, generalized from the existing product/variant/add-on
  validators in `src/routes/product.routes.js`.
- **Correction to the original plan:** the "typed service layer in Flutter" is *already
  built* — `lib/api/` holds 11 domain extensions on `ApiClient` (`order_api.dart`,
  `catalog_api.dart`, `accounting_api.dart`, …). What is missing is **typed models**
  (they still return `Map<String, dynamic>`). Scope this to model classes, not a new layer.
- No TypeScript conversion. JSDoc typedefs only.

### Phase 4 — Mobile parity: the two screens that don't exist (**M**) — *was Phase 3*

Most of the original Phase 3 is shipped. What is genuinely missing:

- **Today's Business Snapshot** — `home.dart` already renders the stats; the "snapshot"
  framing and the Phase 1.6 fields are the delta.
- **Task Center** — does not exist anywhere (`grep` for it returns nothing). Actionable,
  tappable, resolves in place: "3 orders need confirmation", "2 customers waiting",
  "5 products out of stock", "Set your delivery fee", "Trial ends in 2 days".
- Accounting/payouts/settlement on mobile is **already shipped**
  ([accounting.dart](../mobile/wab_app/lib/screens/accounting.dart), 287 lines) — verify
  coverage against `src/routes/accounting.routes.js` rather than rebuilding.

### Phase 5 — WhatsApp conversation quality (**S–M**) — *was Phase 4*

- Quantity bug: **already fixed**. Add the Ghanaian-phrasing regression tests the plan asks
  for ("gimme 2 jollof", "2 pieces of the fried rice", "two waakye") to `test/nl.intent.test.js`.
- `TRACK` and `REORDER`/`REPEAT` are **already in the vocabulary**
  ([nl.intent.js:60–69](../src/services/nl.intent.js#L60)). Genuinely missing:
  **`RECEIPT`, `POINTS`, `HOURS`, `LOCATION`** — plus `HELP` exists as an intent but has no
  bare-keyword branch in the global command block.
- Delivery-fee questions are **already handled** (`tryProductInquiry` → `delivery_fee`,
  including per-zone answers). Still missing: "can I pay with Vodafone cash?".
- Address memory: shipped in Phase 0 terms; the *reorder offer-back* is Phase 1.7.
- **Out-of-stock auto-reply with alternatives** — genuinely missing.

### Phase 6 — Customer trust and storefront (**L**) — *was Phase 5*

Receipts are done (logo, timeline, refund policy, real share). What remains:

- **Verified shop badge** — no schema column, no UI. **BLOCKED** (decision 3).
- **Customer Account Lite** (phone + WhatsApp OTP → orders, receipts, reorder, points,
  opt-out) — not built.
- **Storefront depth** — `public/storefront.html` is 419 lines and has no product detail
  page, no gallery, no variant/add-on selection, no pickup-vs-delivery choice, no zone
  selector. Backend supports all of it.
- **PWA + WCAG 2.1 AA + 3G performance budget** on the storefront only. No `manifest.json`
  or service worker exists today.

### Phase 7 — Lifecycle automation build-out (**S**) — *was Phase 6*

The engine exists. Remaining work is **templates on top of it**, plus the broadcast safety UI:

- Templates not yet registered in `automations.js`: back-in-stock alerts, merchant low-stock
  digest, birthday offers (exists as a *cron*, `loyalty.jobs.js` — consider folding it in),
  ETA-change / rider-assigned proactive notifications.
- **Broadcast safety UI**: audience preview with recipient count, explicit opt-out display,
  mandatory send-test-to-self, post-send performance. `src/utils/audience.js` already
  supports the segments.

### Phase 8 — Merchant depth (**L**) — *was Phase 7*

Unchanged from the original plan, minus what exists. Confirmed missing: photo upload
(paste-URL only), CSV import with preview, bulk edit, duplicate product, drag-and-drop
ordering, product quality score, Kanban order board, packing slip, CRM profile page with
LTV, segment builder UI, settings IA rework, search on products/inbox/broadcasts/promos,
loading skeletons, bulk actions, undo.

### Phase 9 — Codebase health (**L**) — *was Phase 8, minus the mobile tests*

- **No linter or formatter is configured at all** — no `.eslintrc`, no `.prettierrc`.
  CI runs `npm test` only. Add lint + format gates.
- **No error tracking** — zero `sentry` references in `src/` or `package.json`.
- **No CSRF protection** — zero `csrf` references in `src/`.
- Backend coverage is already substantial (61 test files) — target the named gaps rather
  than a blanket push.
- Admin ops surface: [admin_ops.dart](../mobile/wab_app/lib/screens/admin_ops.dart) exists
  (347 lines); audit it against the plan's list before building.
- `public/dashboard.html` is **2,879 lines**. Decompose incrementally, as each area is
  touched. CSP tightening is sequenced *after* that, as the plan correctly states.

---

## 3. Working protocol (unchanged, restated)

- One phase per branch, `phase-N/short-slug`; one logical change per commit.
- Test before fix for anything in Phase 1.
- Migrations forward-only; never destructive without an explicit backup step in the PR body.
- Update this file after each phase with shipped-vs-planned.
- Raise, don't guess, anything in [decisions-needed.md](./decisions-needed.md).

## 4. Non-goals

Unchanged from `improvement-prompt.md` §Non-goals. Nothing found during Phase 0 argues for
readmitting any of them.

---

## 5. Phase 1 — shipped vs. planned

Branch `phase-1/backend-correctness`, four commits on top of `4d8d48b`.
**All seven tasks shipped as planned.** 528 backend tests pass; `flutter analyze` reports
no new issues; the migration was verified re-runnable against a scratch database.

| Task | Shipped | Notes |
|---|---|---|
| 1.1 Persist gateway failure state | ✅ | `payment_attempts` gains `status` / `failure_code` / `failure_reason` / `resolved_at`, with a CHECK constraint and a conservative backfill that only infers an outcome for the order's *current* reference — an order can be paid by an earlier attempt, and a wrong guess here would misattribute money. `markOrderPaid` also retires siblings left `pending`. |
| 1.2 Raw code in the merchant view | ✅ | Threaded verbatim from both gateways; rendered in the mobile payment timeline behind a collapsed "Details" disclosure, per decision #9. |
| 1.3 Paid-path parity test | ✅ | `test/order.paidPathParity.test.js`. Compares the write **sequence**, not the end state. Plus route-reaches-markOrderPaid and PATCH-can't-set-paid assertions. |
| 1.4 Reconciliation script | ✅ | `src/jobs/reconcile.paidStatus.js`. Report-by-default, `--apply` to mutate, optional `--business`. Verified end-to-end on seeded data: finds the broken order, ignores a genuine failed gateway charge, corrects `payment_status` + lifetime spend + audit row, and is a clean no-op on re-run. |
| 1.5 Cron double-registration guard | ✅ | `register()` throws on a duplicate job name; `startCronJobs()` throws on a second call. `test/cronJobs.test.js`. |
| 1.6 Missing Today aggregates | ✅ | `low_stock_count` + `failed_payments_count` added to the existing endpoint. Bonus: removed a request from every cold load by making the low-stock drill-down lazy. |
| 1.7 `address_note` | ✅ | Plus `address_zone`. **Scope note:** the "read-on-reorder" half of this task was already shipped — `askForAddress` has offered the saved address back since before this program started. |

### What changed in the plan as a result

- **Nothing downstream broke.** No Phase 1 finding invalidates a later phase's premise.
- **Decision #4 (refunds don't restock) is now the highest-value open item.** It is a live
  bug — `createRefund` never restocks, so refunded stock is permanently lost — but the
  correct behaviour is a business rule, so it stays blocked rather than guessed at.
- **Decision #8 is now actionable.** The reconciliation report can be run against
  production at any time; it is read-only without `--apply`.
- Phase 2 (mobile tests) is unchanged and remains the next phase.

### Not done, and why

- The production reconciliation has **not been run** — that touches live merchant books and
  is the user's call, not a side effect of this branch.
- Nothing has been pushed or merged.

---

## 6. Phase 2 — shipped vs. planned

Branch `phase-2/mobile-tests`, one commit. **Shipped as planned**, with one addition the
plan did not anticipate (the production test seams, below).

**58 tests, 4 suites** — `mobile/wab_app/test/`. All green; `flutter analyze
--fatal-warnings` passes.

| Suite | Covers | Notable cases pinned |
|---|---|---|
| `session_test.dart` (18) | restore, OTP, admin login, logout, device registration | A revoked key (401/403) signs the device out; **being offline does not** — a merchant on bad 3G can still run their shop from cache. Push-token unregister precedes key clearing. A rejected admin key never becomes the session credential. |
| `biometric_gate_test.dart` (7) | the payout gate | Its two failure directions are deliberately opposite: nothing enrolled → fail **open**; platform error → fail **closed**. Neither is visible when testing by hand on an enrolled handset. |
| `order_state_rendering_test.dart` (13) | `StatusChip`, `paymentStatusLabel`, `timeAgo` | An unpaid order can never render as settled — the exact confusion the mark-paid bug produced. A label overrides the text but never the colour. |
| `api_client_test.dart` (20) | transport + `OrderApi` + `AccountingApi` | Every path and body shape. `markOrderPaid` posts to `/mark-paid`, **not** `PATCH /status`. A 200 carrying `success:false` is still an error. |

### Decisions taken (were #11, #12 — now closed)

- **#11 mocktail**, not mockito — no `build_runner`, so `flutter test` stays one command
  and the repo gains no generated files.
- **#12 separate PR-only workflow** (`.github/workflows/mobile-test.yml`), not a step in
  `deploy.yml` — the Flutter SDK install would add 2–3 minutes to the gate in front of
  every production deploy, for a suite that cannot break the backend it is shipping.

### Deviation from the plan: two production seams were required

The plan said "scaffold tests"; it did not anticipate that the app is **untestable by
construction**. `ApiClient` called `package:http`'s top-level functions and `Session`
constructed its own `ApiClient`, so neither could be driven by a test. Both now take an
optional injected dependency defaulting to today's behaviour, and `loginAdmin`'s throwaway
probe client comes from a new `api.sibling()` — preserving the intent that a bad key
cannot clobber a good session, while making it reachable. No call site changed.

This is worth recording because it is the same root cause as the audit's cross-area risk
#6: the absence of a seam is why the mark-paid gap could only ever have been caught by
grepping.

### Not done

- `analyze` runs with `--fatal-warnings`, not `--fatal-infos` — 10 pre-existing info-level
  lints remain (all `curly_braces_in_flow_control_structures`). Clearing them and
  tightening the gate belongs to Phase 9's lint work.
- Widget/screen-level tests are out of scope; these four suites are logic and contract
  tests. Screen tests become worthwhile after Phase 3's typed models land.
- Nothing pushed or merged.

---

## 7. Phase 3 — in progress

Branch `phase-3/contracts-and-validation`. Both shared layers are **done and tested**; the
route migration they exist to enable is **2 of 25 groups in** and tracked separately in
[api-envelope-migration.md](./api-envelope-migration.md).

### Shipped

| Piece | Where | Tests |
|---|---|---|
| Response envelope + version negotiation | `src/utils/response.js` | `test/response.test.js` (13) |
| Declarative request validation | `src/utils/validate.js` | `test/validate.test.js` (23) |
| `category.routes.js` migrated | — | `test/category.routes.test.js` (19) |
| `notification.routes.js` migrated | — | `test/notification.routes.test.js` (10) |
| Client parses both envelopes | `mobile/.../api/client.dart` | 8 added to `api_client_test.dart` |

**Key decision: the envelope is negotiated by an `X-API-Version` header, not emitted in
both shapes at once.** Sending `data: {orders}` *and* a top-level `orders` would double
every list response. On the 3G connections this product targets, that is a real cost to a
real merchant on every request for the whole migration. Legacy stays the default, so a
migrated route is invisible to `public/dashboard.html` and every deployed mobile build.

### Corrections to the plan

- The plan said "build a typed service layer in Flutter". **It already exists** —
  `lib/api/` holds 11 domain extensions on `ApiClient`. The real gap was typed *models*
  (still `Map<String, dynamic>`) and structured *errors*. Errors are now done:
  `ApiException` carries `code` and a `fields` map, with `e.fieldError('name')` for
  form-level display. Typed models remain open.
- The plan implied a single sweep across all route groups. At 673 response sites across
  8,140 lines that is one enormous, unreviewable diff — hence the negotiated envelope and
  the group-by-group tracker.

### Two traps found, both now documented

- `validate`'s `max` **truncates** strings and arrays, but several routes **reject** past
  their limit. Category reorder was one: silently reordering the first 200 of 250
  categories and reporting success is worse than refusing.
- `auth.routes.js` uses the legacy `error` **string** as a machine-readable code
  (`link_required`), and `login.dart` branches on it. Migrating that group without
  mapping it to `error.code` verbatim would silently break Clerk-linked sign-in. Pinned
  by a test that explains why.

### Not done

- 23 route groups remain. `order` and `product` are the highest-value next targets;
  `product`'s hand-rolled validators are what `validate.js` was generalized from, so
  migrating it should delete them.
- `ApiClient.useV2Envelope` is **off**. Turn it on only once the groups the app actually
  calls are migrated.
- Typed Flutter models.
- `webhook`/`payment`/`receipt`/`storefront` responses are third-party contracts read by
  Paystack, Meta and the static HTML in `public/` — flagged as probably-never-migrate.
- Nothing pushed or merged.


---

## 8. Phase 4 — shipped vs. planned

Branch `phase-4/finish`. **Complete**, but the plan's premise was wrong in one place and
that is the more useful finding.

### Shipped

| Piece | Where | Tests |
|---|---|---|
| Task Center | `lib/state/task_center.dart`, `lib/widgets/task_center.dart` | 26 |
| `needs_confirmation_count` aggregate | `src/routes/order.routes.js` | in `orderStatsToday` |
| Shell tab-switch channel | `lib/state/shell_tabs.dart` | covered by the widget tests |
| "Today's snapshot" framing | `lib/screens/home.dart` | — |
| Withdraw to MoMo (biometric-gated) | `lib/screens/accounting.dart` | API layer, 5 |
| Expense capture + month-to-date P&L | `lib/screens/accounting.dart` | API layer |

### The plan was wrong about accounting

§2 said accounting/payouts was "already shipped — verify coverage rather than
rebuilding". Verifying showed **mobile called 4 of 11 accounting endpoints**. The gaps
included the merchant actually *getting paid*: `POST /payouts/auto` moves money via
Paystack Transfers and had no client at all, so the app could show a merchant their
balance but gave them no way to withdraw it.

Now wired, gated twice — the device biometric/passcode check **and** an explicit
confirmation naming the amount and destination — because it is the only action in the app
that sends money and a mis-tap is not recoverable from inside the app. A 409 (Paystack
OTP-approval enabled) is surfaced as "needs manual approval, your money is safe" rather
than a retry prompt, because retrying cannot help.

Expenses and profit-and-loss came with it: a profit figure that only counts revenue reads
as profit when it is really turnover, so the expense entry point sits next to the number,
and the card says so explicitly when no expenses are recorded.

### Design notes worth keeping

- **The Task Center costs nothing on a cold load.** It is a pure function of data the home
  screen already fetches. One extra round trip would be paid by a merchant on 3G every
  morning.
- **`needs_confirmation_count` is deliberately not scoped to today.** An order left
  unconfirmed since yesterday is more urgent than one placed an hour ago.
- **Nothing outstanding renders nothing** — no daily "all clear" card to scroll past.
- **The P&L endpoint returns fixed-precision strings, not numbers.** A plain `as num?` cast
  silently yields null and every figure renders as zero; caught before shipping.

### Not done

- `vat-export` and `inventory-valuation` remain web-only. Both are back-office exports, not
  things a merchant does from a phone — a deliberate call, not an oversight.
- Nothing pushed or merged.


---

## 9. Phase 5 — shipped vs. planned

Branch `phase-5/whatsapp-quality`. **Complete.**

| Task | Shipped | Notes |
|---|---|---|
| Ghanaian-phrasing quantity tests | ✅ | Found two real gaps, below. |
| `RECEIPT` / `POINTS` / `HOURS` / `LOCATION` | ✅ | Plus `PAYMENT_METHODS`. |
| Payment-method questions | ✅ | "can I pay with Vodafone cash?" |
| Out-of-stock auto-reply with alternatives | ✅ | Fixed a real lie, below. |
| Address memory | already shipped in Phase 1 | — |

### The phrasing tests found two real gaps

Writing them as *regressions* turned up two things the parser genuinely could not do,
both named in the original plan:

- **`gimme` was not a filler prefix.** "gimme 2 jollof" fell through to generic chatter.
  Added alongside the rest of the spoken register a customer actually types — `bring me`,
  `I need`, `make I get`, `abeg`.
- **Spelled-out numbers were not parsed.** "two waakye" — explicitly in the plan — read as
  a bare name with no quantity. Now handled up to twelve; beyond that everyone writes the
  numeral, and a longer list starts colliding with product names.

Also corrected two wrong assumptions of my own: a **bare** product name returning null is
*by design* (the caller's own matcher handles it, where context makes it safe), and
"1000 jollof" never parsed as a quantity at all because the matcher accepts at most two
digits.

### Out-of-stock was telling customers a lie

`fetchVisibleProducts` filters on `in_stock = TRUE`, so a finished item is invisible to the
matcher and the customer got **"We couldn't find jollof on the menu"** — untrue, and it
reads as though the shop never sold it. Both entry points (typing the name, and asking
"do you have jollof?") now check the out-of-stock shelf and answer "finished for now",
with up to three alternatives **from the same category first** — someone who wanted jollof
wants another meal, not a drink.

### Design principle the tests pin

Every new answer is honest when the shop has nothing useful to say, and every one is
terminal — it answers and stops rather than dragging the customer into checkout:

- no cash value quoted for points when no redemption rate is configured
- `POINTS` says the shop runs no programme rather than reporting "0 points"
- `HOURS` says orders are taken any time rather than inventing a window
- `LOCATION` says "we deliver, call this number" rather than apologising, because plenty
  of these shops genuinely have no premises
- `RECEIPT` refuses to produce one for an **unpaid** order — a receipt is proof of payment

### Not done

- Twi phrasings for the five new intents. The existing `TRACK` entry documents why:
  guessing a phrase ships something wrong rather than merely missing. They need a native
  speaker, and the `NEEDS_NATIVE_REVIEW` convention is already in place for when one is
  available.
- Nothing pushed or merged.


---

## 10. Phase 6 — shipped vs. planned

Branch `phase-6/storefront`. **Storefront depth done; two items remain open.**

### Shipped

| Piece | Notes |
|---|---|
| Variants + add-ons in the public catalogue | Backend-complete but absent from this endpoint, so a web customer could not order a size or an extra that a WhatsApp customer of the same shop could. |
| Variant/add-on pricing at checkout | Priced exactly as `order.routes.js` does. |
| Pickup vs delivery choice | Pickup no longer means "leave the address blank and hope". |
| Delivery-zone selector and pricing | **Fixed a real pricing bug** — see below. |

### The zone pricing bug

`delivery_zones` was being returned to the page and then **ignored when pricing**:
checkout charged `delivery_fee_ghs` flat whenever an address was present. A shop with
zones therefore quoted **two different prices for the same delivery** — per-zone on
WhatsApp, flat on the web. Now matched by name against the shop's own list, and a shop
that *has* zones requires one to be chosen rather than falling back to the flat fee, which
would quietly undercharge for a far zone.

### The rule this endpoint turns on

`/storefront/:slug/checkout` is **public and unauthenticated**, so everything is
re-resolved server-side from ids: a posted price is an offer, never a fact. A variant
belonging to another product, an unknown add-on, or a zone the shop does not have are all
refused rather than silently dropped — dropping an add-on would charge less than the shop
expected to be paid, and the merchant would only find out at handover.

### Verified in a browser, not just asserted

Looking at the page caught a mobile layout bug static tests could not: `.field label` and
`.field input { width: 100% }` from the shared stylesheet beat `.opts-row` on specificity,
stacking each radio above its label at full width. Fixed by taking the fulfilment control
out of `.field` and raising the selector specificity.

Confirmed live: GH¢40 + GH¢10 (Large) + GH¢15 (extra chicken) = **GH¢65**, matching the
server; East Legon GH¢20 vs Madina GH¢10 vs pickup free; and two differently-configured
lines of the same product staying separate in the cart.

### Not done

- **Verified shop badge — BLOCKED on decision #3.** No schema, no criteria, no approver.
  Not guessed at.
- **Customer Account Lite** (phone + WhatsApp OTP → orders, receipts, reorder, points,
  opt-out). Genuinely large; it is its own phase, not a tail on this one.
- **PWA + full WCAG 2.1 AA audit.** The new controls are labelled (`role="dialog"`,
  `aria-modal`, `aria-labelledby`, `aria-label` on the icon-only steppers) and have visible
  focus, but a full audit and a service worker are separate work.
- Nothing pushed or merged.


---

## 11. Phase 7 — shipped vs. planned

Branch `phase-7/automations`. **Broadcast safety done. The automation templates the plan
listed turned out to be mostly built already.**

### The plan was wrong again about what was missing

It listed back-in-stock alerts and a merchant low-stock digest as templates still to build.
Both already exist:

- **Back-in-stock** is event-driven, not scheduled — `product_watchers` plus
  `automations.notifyProductRestocked`, fired from the product PATCH when `in_stock` flips.
  A scheduled template would have been the wrong shape *and* a duplicate.
- **Merchant low-stock digest** is part of `jobs/daily.summary.js`.

### An inconsistency Phase 5 introduced, now fixed

Tapping a sold-out item from the menu has always offered "tell me when it's back"
(`addProductToCart`). The out-of-stock reply I added in Phase 5 for the **typed** path did
not — so the same question got two different answers depending on how it was asked, and
the typed path silently dropped the only response that *recovers* the sale rather than
substituting it. Both paths now offer the restock opt-in.

### Broadcast safety

A broadcast fans out the moment it is created and cannot be recalled. Two rails, both
reachable from the mobile compose sheet:

| Rail | Why |
|---|---|
| `POST /broadcasts/preview` | "inactive 60+ days" could be four people or four thousand, and the filter alone doesn't say. Returns the reachable count, a five-name sample to sanity-check the filter, and how many *matching* customers opted out — scoped to the same audience, so it answers "of the people you targeted", not "overall". |
| `POST /broadcasts/test` | Sends the draft to the shop's own number. Catches the typo, the missing price, the line that reads fine in a compose box and badly in a chat bubble. Deliberately **not** recorded as a broadcast — a test is not a campaign, and counting it would corrupt the history and delivery stats. |

The preview builds its count from the **same `buildAudienceClauses`** the sender uses, so
the number cannot drift from what actually happens. A preview failure never blocks a send;
it downgrades to "Send without a preview?" rather than letting the merchant believe they
saw a count they didn't.

### Not done

- **Post-send performance** (delivered / replies / orders / revenue generated). `broadcasts`
  tracks `sent_count` and `failed_count`; attributing replies and revenue to a campaign
  needs a schema decision about the attribution window, which is a product question.
- **Folding the birthday cron into the automation engine** — that is decisions-needed #10,
  still unanswered. `loyalty.jobs.js` works; the argument for folding it in is consistency,
  not correctness.
- Nothing pushed or merged.


---

## 12. Phase 9 — security hardening (started)

Branch `phase-9/security`. Two corrections to the plan, and one live production bug the
new tooling found within a minute of being installed.

### CSRF is NOT a gap here — the plan was wrong

The plan (inherited from `improvement-prompt.md`) listed "CSRF protection on
browser-authenticated dashboard mutations". Verified against the code:

- `public/dashboard.html` authenticates with `Authorization: Bearer <token>`
- there is **no** cookie parsing, **no** session middleware, **no** `res.cookie` anywhere
- there is **no** CORS middleware, so cross-origin requests are same-origin-blocked

CSRF requires an *ambient* credential the browser attaches automatically. A Bearer header
is not one, and cannot be set cross-origin without CORS approval that is never granted.
Adding CSRF tokens would be theatre: complexity, a new desync failure mode, and no
attack prevented. **Not implemented, deliberately.**

### The linter found 18 hanging endpoints — shipped, in production

Installing ESLint surfaced `no-undef` on `admin.routes.js` (16 sites) and
`subscription.routes.js` (2), including the **public** `/api/subscriptions/plans`.

Cause: the scripted envelope migration inserted `respond.ok(req, res, ...)` into handlers
whose signature was `(_req, res)` — an underscore-prefixed, deliberately-unused request
parameter. `req` was undefined, the `try` threw, the `catch` called
`respond.failInternal(req, ...)` and threw again, and **the request hung**.

None of the four guards I had written caught it. They checked for a missing `require`, a
half-migrated file, an unbound *trailing* argument, and a malformed `fail()` — not a
first argument, and not a parameter that exists under a different name. A fifth guard now
covers this exact shape, but the real lesson is that **a linter catches a whole class
where hand-written guards catch instances**.

It also explains why nothing alerted: a hung request emits no error log and no 5xx. This
is now the argument for decisions-needed #13 (error tracking).

### Shipped

| Piece | Notes |
|---|---|
| ESLint + `npm run lint`, gated in CI | Deliberately defect-focused, not style-focused: a thousand formatting findings on day one would get it switched off. |
| 7 real unused-variable/dead-import fixes | Including two dead imports and a dead destructure left by earlier migrations. |
| Secret scanning in CI | Verified against a planted canary. A test fixture was renamed rather than the detector weakened. |
| Tighter auth rate limit (30/15min vs 120/min) | The OTP flow's real protection is its 5-attempts-per-code cap, which is sound. This is defence in depth, and slows enumeration of which numbers are registered shops. |

### Not done

- **Error tracking** — blocked on decisions-needed #13, now the highest-value item on that
  list.
- **`public/dashboard.html` decomposition** (2,879 lines) and the CSP tightening that
  depends on it.
- **Staff roles and permissions UI** — the backend RBAC exists (`utils/permissions.js`,
  `rbac.test.js`); there is no UI for it.
- Nothing pushed or merged.


---

## 13. Phase 8 — merchant depth (started)

Branch `phase-8/merchant-depth`. **The CRM profile shipped.** The rest of Phase 8 is a
long list of independent items; this took the one with the largest gap between what the
backend already does and what a merchant can see.

### The gap

`GET /api/customers/:id/profile` has served lifetime spend, order frequency, preferred
payment method, last products ordered, recent orders and conversation history for a long
time, and **nothing called it**. Tapping a customer in the list opened the chat thread, so
"is this person worth a discount" had no answer inside the app. The same was true of
`/loyalty`, `/tags`, `/address-note` and `/birthday`.

### Shipped

`lib/screens/customer_detail.dart` — one screen answering what the merchant actually asks
when they tap a name in a customer *list*: what is this person worth, what do they buy,
what have I promised them. The chat is one tap away from there rather than being the
destination.

Loyalty loads in parallel and is allowed to fail on its own: a shop with the programme
switched off must still see who its best customers are.

Also `lib/api/customer_api.dart` — typed methods for profile, loyalty, tags, address note,
birthday and points redemption, all previously unreachable.

### Two shape assumptions caught before shipping

- **`last_products_ordered` elements are `{ name, ordered_at }` objects**, not strings.
  `Text('$p')` would have rendered `{name: Jollof Rice, ordered_at: …}` on screen.
- The profile's derived metrics arrive **flat**, because the legacy envelope spreads `meta`
  at the top level — which is what every deployed client receives.

Both are now pinned by widget tests built from the exact payload the endpoint returns,
rather than from what the screen wished it returned. A third test pins that a failing
loyalty call still renders the profile.

### CSV import — preview, a transaction, and a regression it exposed

`dry_run: true` now validates the whole file and reports what *would* happen per row,
writing nothing. A merchant pasting a spreadsheet had no way to discover that column 3 was
the wrong one until their catalogue was already wrong — and unlike one bad product, a bad
import is two hundred of them.

The real import now runs in **one transaction**. It wrote row by row, so a database error
on row 150 of 200 left 149 products written, returned a 500, and gave the merchant no way
to know which.

**Building the dry run exposed a live regression from Phase 3.** The import assembles
`{ stock_qty: record.stock_qty }` from spreadsheet columns, so a CSV without a `stock_qty`
column produced a key holding `undefined`. The hand-rolled validators it replaced checked
`if (body.x !== undefined)`; the schema layer used `hasOwnProperty`, so it validated
`undefined` as a supplied value and **rejected every row of any CSV missing an optional
column** — which is most of them. `validate()` now treats an explicitly-`undefined` value
as absent, matching the behaviour it replaced. `null` still means "clear this", which is
the distinction that makes the rule safe. Verified end to end against a real database.

### Not done

Bulk edit, duplicate product, drag-and-drop ordering, product quality score, photo upload
(still paste-URL), Kanban order board, printable packing slip, segment builder UI, settings
IA rework, undo. Each is independent; none blocks the others.

Nothing pushed or merged.


---

## 14. Regression audit of the Phase 3 validator swap

After two regressions from the same migration surfaced by building on top of it rather
than by any test, the swap was audited properly instead of waiting for a third to be
found in production.

### Method

The pre-migration validators were extracted from git (`8c61c56`), isolated, and run
against the current schemas over a matrix of inputs — empty, padded, null, empty-string,
negative, fractional, over-length, and boundary values for every field, in both full and
`partial` mode. Any difference in **accept/reject** or in the **coerced output** is a
behaviour change the migration made silently.

### Result

**114 cases. One divergence, now fixed.**

An emptied `category` returned `''` where the old validator returned `'general'`. The
CREATE paths hid it behind their own `out.category || 'general'` fallback, but **PATCH
writes the validated object straight into the UPDATE** — so a merchant clearing the field
persisted an empty string, and that product then grouped under nothing and matched no row
in `categories`.

### The pattern across all three regressions

| Regression | Why no test caught it |
|---|---|
| `req` undefined in 18 handlers | Nothing exercised those branches; a hung request emits no log |
| `undefined` treated as a value | JSON has no `undefined` — only object-building callers were affected, and every test posted JSON |
| Empty category | The CREATE fallback masked it; only PATCH was exposed, and no test cleared a category |

Each survived because the tests covered the *paths* but not the *inputs*. A scripted
migration preserves whatever the tests exercise and quietly changes the rest — which is
the argument for differential-testing a mechanical refactor against the thing it replaced,
rather than trusting a green suite.

The one remaining `validate()` caller that builds an object rather than passing `req.body`
is the CSV import, already fixed. Every other call site passes a JSON body.


---

## 15. API coverage audit — what the backend does that nobody can reach

The single highest-yield check in this whole program has been "which endpoints have no
client". It found the Task Center's data, the accounting payout gap, and the customer
profile. Run systematically across all mounted routes:

**Genuinely unreachable, confirmed by grep across `mobile/` and `public/`:**

| Surface | Status |
|---|---|
| `/api/inventory/*` — suppliers CRUD, restock, adjust, movements, margins | **Now shipped** (below). Only `reorder-suggestions` had a caller. |
| `/api/keys` — issue, revoke, rotate staff keys | **Now shipped** (§16). |
| `/api/analytics/{delivery-sla,profit,cohorts,channels}` | **Now shipped** (§18). |
| `/api/products/{variants,addons}/:id` PATCH+DELETE | **Now shipped** (§19). The audit line was wrong — see below. |
| `/api/business/export`, `/api/business/close` | **Now shipped** (§17). |
| `/api/customers/segments/summary` | **Now shipped** (§20). |
| `/api/admin/{ops,audit-log,risk-flags,impersonation-*}` | Admin surface. |
| `/api/accounting/inventory-valuation` | Back-office; web-appropriate. |

Webhook and payment-callback routes also show as clientless, correctly — Meta and Paystack
call those.

### Shipped: the inventory workflow

The largest coherent gap. A merchant could see something was running low and had **no way
to record restocking it**, so the warning never cleared and stock counts drifted from
reality until each product was edited by hand.

`lib/screens/inventory.dart` — three tabs in the order a shopkeeper needs them: what to
buy, what it earns, what happened.

- **Restock** adds to the count with optional unit cost and supplier, writing a
  `stock_movements` row so the change is auditable rather than an unexplained jump.
- **Count** sets an exact figure — a stock take. Deliberately a *different* endpoint from
  restock, because a delivery and a correction are different events and the ledger has to
  tell them apart.
- **Margins** shows cost against price, flagging anything under 15% — worth knowing before
  a discount is offered on top of it. A product with no cost price is excluded rather than
  displayed as pure profit.

Shapes verified against the SQL before writing the UI: `margin_pct` and `margin_ghs` are
Postgres NUMERIC and arrive as **strings**, which the fixtures use deliberately.

### Not done

Staff-key management UI (§16), the four richer analytics views, variant/add-on editing
from mobile, data export and account closure (§17), segment summary. All independent.


---

## 16. Staff access management

Branch `phase-9/staff-keys`. Phase 9's "staff roles and permissions UI", and the
unreachable surface with a security dimension rather than a convenience one.

### The gap

Keys could only be issued by calling `/api/keys` directly. Nothing could **list** what
existed or **revoke** it, so a shop owner had no way to answer "who still has access" —
the question that matters after someone leaves. The backend RBAC (`utils/permissions.js`,
five roles, `rbac.test.js`) has been complete throughout.

### What the design turns on

The secret is returned **exactly once**, at creation or rotation, and stored hashed. Every
choice in the reveal follows from that being genuinely irreversible:

- the dialog is `barrierDismissible: false`, so tapping away cannot silently lose it
- the copy says "the only time it will be shown", not "keep this safe"
- the confirm button reads "I've saved it", not "OK"
- the remedy is named in the dialog itself: rotate the key

Other decisions worth keeping:

- **Roles are shown by capability, not name.** "Support" and "Manager" mean nothing to
  someone handing out access; the picker says which one can see the money.
- **Revoked keys stay listed**, as a record of what access existed and when it ended.
- **"Never used" is surfaced**, because a key nobody has picked up can be revoked with no
  disruption.
- **Rotate and revoke are separate actions with separate confirmations.** Rotating an
  intended revoke would leave the person with access — the worst possible mis-tap here.
- An unnamed key is refused: a key nobody can later identify as theirs cannot be safely
  revoked.

### A layout bug the tests caught

The create sheet — four role options with their explanations, plus a field and a button —
**overflowed a short screen**, clipping the Create button off the bottom on exactly the
cheap handsets this product targets. Now scrollable. The inventory restock sheet was
checked for the same fault at 375×600 and does not have it, so it was left alone.

### Still unreachable

Four richer analytics views, variant/add-on editing from mobile, segment summary. All
independent.


---

## 17. Data export and account closure

`GET /api/business/export` and `POST /api/business/close` had no client on any surface.
That was worth fixing ahead of the remaining analytics work for a reason that is not
really about API coverage: an app that lets someone create an account has to let them
leave, and Play requires that route to be findable from inside the app rather than only
in a support email.

### The distinction the screen is built around

The two endpoints do not do what their names suggest to a merchant:

- `/close` sets `closed_at` and stops the storefront and bot. **Every order, customer and
  message is retained**, and the export keeps working afterwards.
- Actual deletion is not an API call at all. Per `public/delete-account.html` it is an
  email to `dev@skes.tech`, verified against the WhatsApp number on file before anything
  is erased — deliberately, so that nobody can destroy a merchant's business records by
  getting hold of their phone for a minute.

So the screen never lets "close" imply "delete". It states the retention plainly, and
names the real deletion route with the exact address, subject line and required details,
each copyable. Two tests hold that wording still: one asserts the screen says closing
does **not** delete, one asserts the deletion details are present and reachable.

### Shipped

- `lib/api/account_api.dart` — both calls, plus the deletion-request constants mirrored
  from the published policy page.
- `lib/screens/account_data.dart` — one screen, three depths, in the order download →
  close → delete, so a merchant is offered their copy of the data *before* giving up
  access to it.
- `ApiClient.getRaw` — the export is a file, not an envelope. Kept separate from `get`
  because the bytes must survive unreformatted (decoding to a Map and re-encoding would
  reformat the merchant's file and double peak memory on a low-end phone), and because a
  full bundle needs far more than the standard 25s timeout on a 3G connection.
- Closing requires typing `CLOSE`, not a second tap — a mis-tap should not be able to
  take a shop offline. It asks an optional reason first, then signs out, since every
  screen behind it would otherwise be describing a shop that is no longer trading.
- `share_plus` added (the one new dependency): the export goes straight to the system
  share sheet, because on these phones a file saved "somewhere in Downloads" is one the
  merchant will never find again, whereas WhatsApp-to-self or Drive is somewhere they
  already know how to get back to.

### A test that was passing for the wrong reason

The short-screen test tapped a button at y=882 on a 640px-tall viewport. The tap silently
missed, the sheet never opened, and `takeException()` was null — so it passed while
verifying nothing. `dragUntilVisible` had not helped: it stops the moment its finder
matches, and a `ListView` builds a cache extent past the viewport, so it kept finding the
button off-screen and never scrolled. The fix is `scrollUntilVisible` followed by
`ensureVisible`; both are needed, and neither alone is enough.

### Not done

Nothing from the coverage audit — see §20.


---

## 18. The four deeper analytics views

`profit`, `cohorts`, `delivery-sla` and `channels` were backend-complete with no client
on any surface. They are tabs on the existing Analytics screen rather than four more rows
in More, because they answer versions of the same question and a merchant comparing them
should not have to navigate back out each time.

### Two things that are about correctness, not layout

**The windows differ per endpoint.** Overview and cohorts accept 7 and 30; profit,
delivery and channels also accept 90. The server *silently falls back to its default*
when handed a window it does not accept — so a "90d" button on the Customers tab would
have shown 30-day figures under a 90-day label. `analyticsWindows` mirrors the route
file, the segmented control is built from it, and switching tabs clamps the selection.
A test asserts the cohorts request never carries `days=90`.

**Margin % is taken against the revenue it was computed from.** Products with no
`cost_price_ghs` contribute revenue but no margin. Dividing known-cost profit by *total*
revenue would drag the percentage down for a reason that has nothing to do with the
business — the shop would look less profitable purely because some cost prices are
missing. In the test fixture that is 40% correct vs 27% wrong. The view also states what
share of revenue the profit figure covers and how many products are missing a cost price,
rather than burying it.

The same honesty problem appears twice more, and is handled the same way:

- A `late_rate_pct` of `null` means *no order had an ETA*, so nothing could be late. Shown
  as an explanation, never as "0% late" — which would read as perfect performance.
- A repeat rate with zero eligible customers reads "Not enough history yet", not "0%".

### Cost of opening the screen

Each tab fetches on first open and then holds its result via
`AutomaticKeepAliveClientMixin`. Without it a `TabBarView` disposes a tab on swipe, so
flicking between Profit and Channels would re-download both every time — a real cost on a
metered 3G connection. Tests assert that opening Analytics issues exactly one request,
and that returning to an already-loaded tab issues none.

### Shipped

- `lib/api/analytics_api.dart` — the four calls plus the per-view window table.
- `lib/screens/analytics_views.dart` — the four views as top-level pure functions of the
  response, so they are testable against real payload shapes with no network and no
  controller. That is where the bugs in this area have actually been: not layout, but
  assuming a field's type or reading a key that does not exist.
- `lib/screens/analytics.dart` — tabs, lazy per-tab loading, window clamping. The existing
  overview is unchanged.
- 19 tests: shape handling (`channels` is a top-level array, not nested; `recent` carries
  a raw null `rider_name` where `by_rider` substitutes `(unassigned)`), the three honesty
  cases above, lazy loading, and window clamping.

One label changed as a result of a test: the delivery stat "Late" collided with the
per-delivery "Late" badge on the same screen, so the stat is now "Late orders".

### Not done

Variant/add-on editing from mobile, segment summary.


---

## 19. Variants and add-ons

### The audit line was wrong

§15 recorded this as "can create from mobile, cannot edit or delete". Checking before
building: the mobile app had **no variant or add-on code at all** — `grep` over `lib/`
returns nothing. Creation exists only on the web dashboard, through a chain of
`prompt()` dialogs where removing one means typing `remove variant Large` and having it
matched by name.

And the PATCH endpoints for both had **no caller on any surface**. Correcting a price or
fixing a typo has only ever been possible by deleting the option and recreating it, which
loses its `sort_order`. So this is not "editing from mobile" as scoped — it is the first
edit path that has existed at all.

### Two distinctions the UI has to preserve

The data model draws these and a naive list would flatten both:

- A **variant** carries a signed `price_delta_ghs` against the product — Large is +GH¢5,
  Small can be −GH¢2. An **add-on** carries `price_ghs`, an absolute price the server
  refuses to let go negative. Different endpoints, different rules, so they are separate
  sections rather than one list with a type field.
- A variant's `stock_qty` of `null` means "not tracked separately"; `0` means "sold out".
  Conflating them either hides something that is for sale or keeps selling something that
  has run out. Tracking is therefore an explicit switch, and turning it **off** sends
  `stock_qty: null` rather than omitting the field — omitting it would leave the old count
  in place and the variant would still look tracked. Verified against the real validator,
  not just the mock: `int({nullable: true})` accepts the null and it reaches the `SET`
  list, so the clear actually happens.

### Shipped

- `lib/api/options_api.dart` — all six calls, with `clearStockQty` as a distinct argument
  so "stop tracking" cannot be confused with "field not supplied".
- `lib/screens/product_options.dart` — both sections, create/edit/delete, reached from the
  product edit sheet (only once the product exists — options hang off a product id).
- The variant sheet shows **what the customer will actually pay** as the delta is typed.
  A merchant prices in final money, not differences.
- Delete confirms first and states that past orders are unaffected, because orders keep
  their own snapshot of what was bought — "delete" on a catalogue item reads riskier than
  it is.
- 13 tests, including that editing issues a PATCH and never a DELETE-then-POST, that
  turning tracking off sends an explicit null, and that a negative add-on price is caught
  before the round trip.

### Still on the web dashboard only

The dashboard's `manageOptions()` prompt chain is unchanged and still cannot edit — it
only adds and removes. Mobile is now strictly better for this task. Worth replacing when
`public/dashboard.html` is decomposed (Phase 9), not before.

### Not done

Segment summary.


---

## 20. Customer segments — and the end of the coverage audit

`GET /api/customers/segments/summary` was the last endpoint in §15 with no client. With
this it has none left.

### Why it is not three numbers

Shipping the summary as a stats panel would have missed what makes it useful. The same
filter spec that produces these counts — `segment`, `tag`, `min_spend_ghs` in
`src/utils/audience.js` — is already what the customer list and broadcast targeting
accept. So a count is one tap from "show me these people" and one tap from "message
these people". A merchant does not want to know that 23 customers are slipping away;
they want to write to those 23.

Each segment therefore carries what it is *for* ("Slipping away. A win-back message goes
here.") next to its count, and two actions. A segment with a count of zero offers
neither — there is nothing to look at and nobody to message.

### A gap found on the way

`CustomersScreen` never passed `segment` or `tag`, though the endpoint has always
supported both via `buildAudienceClauses`. Every merchant saw the same unfiltered
top-200 list, narrowed only by a client-side name search. It now takes an audience and
titles itself with it, so a filtered view is never mistaken for the whole list.

`showBroadcastComposer()` is new for the same reason — the composer already had segment
and tag targeting, it just could not be opened pointed at anything.

### Shipped

- `lib/api/segments_api.dart` — the call, plus what each segment is for.
- `lib/screens/segments.dart` — segments with counts and both actions; tags as chips that
  filter the list. Reached from the Customers screen.
- `CustomersScreen({segment, tag, filterLabel})` and `showBroadcastComposer()`.
- 7 tests, mostly about the handoff rather than the counts: that "see them" actually
  sends `segment=`, that a tag sends `tag=` and *not* a segment, that an empty segment
  offers no actions, and that the screen costs one request.

### `test/support/reveal.dart`

The off-screen-tap trap from §17 turned up again, so the helper is now shared. It is
worth stating plainly because it fails by **passing**: `scrollUntilVisible` returns as
soon as its finder matches, a `ListView` builds a cache extent past the viewport, so a
`tap` computes an offset outside the render tree, silently hits nothing, and every
assertion afterwards checks a screen that never changed. `ensureVisible` is the second
half. `account_data_test.dart` now imports the shared helper instead of its own copy.

### One thing to watch

A single backend test failed once during this work (774/775) and did not reproduce in
four subsequent full runs; the failure marker was not captured. Nothing in this change
touches backend code. Recording it because an intermittent that is seen once and then
ignored is exactly the kind that resurfaces in CI.

### Coverage audit: closed

Every endpoint listed as clientless in §15 now has one. Remaining Phase 9 work is
`public/dashboard.html` decomposition with its dependent CSP tightening, and error
tracking (blocked on decision #13).


---

## 21. The CSP, and what was actually blocking it

The plan sequenced this as "decompose `dashboard.html`, then tighten the CSP". Checking
before building, that was necessary but nowhere near sufficient, and the real blocker was
somewhere else entirely.

### What was found

**11 files had inline `<script>` blocks**, not one — 3,519 lines across `dashboard`,
`admin`, `storefront`, `receipt`, `accountant`, `roi-calculator`, `status`, `login`,
`signup`, `contact` and `mobile-clerk-bridge`.

**And 28 marketing pages loaded a runtime JSX toolchain.** React, ReactDOM (development
builds) and Babel standalone, to render a design-time theme panel that showed a visitor
nothing — its host div mounted empty. Verified in a browser: Babel transforms the JSX at
runtime and injects the result as **inline `<script>` elements** (99 KB and 28 KB on
`pricing.html`). Those execute only because `script-src` grants `'unsafe-inline'`, and
being generated at runtime they can never be extracted. The panel, not `dashboard.html`,
was what made the CSP unfixable.

It was also expensive. Measured gzipped: **893 KB** of framework on top of a **3.4 KB**
page — 260× the page weight, on a market where data is bought by the megabyte. After
removal `pricing.html` transfers **5 KB across 6 requests**, down from ~900 KB.

### Shipped

1. `dashboard.html` 2,879 → 825 lines; behaviour moved verbatim to `dashboard.js`.
2. The tweaks panel's script tags removed from all 28 marketing pages (the `.jsx` files
   stay in the repo for local design work). The app pages — dashboard, storefront, login,
   signup, admin, receipt — never loaded it, so no customer flow changed.
3. The remaining 10 inline blocks extracted to sibling `.js` files. **Zero inline
   `<script>` blocks remain anywhere in `public/`.**
4. `script-src` tightened from `'self' 'unsafe-inline' https:` to `'self' https:`.

Every extraction was verified byte-identical against the original block, parsed with
`node --check`, and exercised in a real browser under the tightened header: the dashboard
runs and its inline `onclick` handlers still fire, Clerk initialises on `login.html`,
`storefront.js` reaches its correct no-slug path, and no page reports a CSP violation.

### The gap that remains, stated plainly

`script-src-attr` still allows `'unsafe-inline'`, because the markup wires **86 inline
`on*=` handlers**. An injected `<img onerror=…>` would still run. What the change does buy
is that an injected `<script>…</script>` — the classic stored-XSS shape — no longer
executes. Closing the rest means converting every handler to `addEventListener` across
pages with no browser-level test coverage; that is its own change, with its own risk, and
it should not ride along with a mechanical extraction.

### Tests

- `test/csp.test.js` — asserts `script-src` allows neither `'unsafe-inline'` nor
  `'unsafe-eval'`, that `object-src`/`base-uri` stay locked, and that `script-src-attr`
  is still the *known* gap, so it stays visible rather than forgotten.
- `frontend.smoke.test.js` — no page may contain an inline `<script>` block (the
  invariant the CSP rests on: one added back would silently stop that page's JS in
  production); every extracted script parses and is referenced; no page may ship a
  runtime JSX toolchain or a React development build; and every function named in an
  inline handler must still be defined in the page's script, since a global that stopped
  being global would fail at click time, not load time.
- Both frontend test files now read a page as *markup plus its script file*. Without
  that, the XSS scans would have kept passing while pointed at files that no longer
  contain the `innerHTML` templates they guard. Confirmed non-vacuous by mutation:
  reintroducing a raw `${b.name}` in `admin.js` fails the guard.

### Not done

Error tracking remains blocked on decision #13. (The 86 inline handlers were converted
straight after — see §22.)


---

## 22. Closing the last CSP gap

The 86 inline `on*=` handlers became `data-*` attributes dispatched by a delegated
listener, and `script-src-attr` went from `'unsafe-inline'` to `'none'`. An injected
`<img onerror=…>` no longer executes, which was the hole left open by §21.

### The dispatcher is deliberately dumb

`public/actions.js` looks a function up **by name** and calls it. It does not eval, so a
`data-*` attribute cannot carry executable source the way an `on*=` attribute could —
that is the whole point of the change rather than an implementation detail.

    data-click="saveSettings"                        → saveSettings()
    data-click="showSubTab" data-arg1="stock" data-arg2="promos"
    data-click-self="closeCart"                      → only when the click landed on the
                                                       element itself (modal backdrops)
    data-click-el="pImportFile"                      → clicks that element
    data-submit-prevent                              → preventDefault()

### The bug this would have shipped

Arguments arrive from the DOM as strings. `loadAnalytics` compares
`currentAnaDays === 7` **strictly**, so passing `"7"` would have left the active-period
button permanently unhighlighted while the data still loaded correctly — working enough
to pass a glance, wrong enough to look broken. Found by reading the function before
writing the dispatcher, not after. Numeric-looking args are therefore coerced, and it is
verified end-to-end in a browser: clicking 7d makes `#anaBtn7` `btn-primary`, clicking
30d moves it.

### Three handlers that could not be declarative

A `data-*` attribute names a function; it cannot hold an expression. So
`downloadAuthed('…' + BIZ.id, …)`, `importProductsCsv(this.files[0])` and
`window.print()` became small named wrappers — `downloadBusinessExport`,
`importProductsCsvFromPicker`, `printPage`. Naming them is a gain: each is now greppable
and testable instead of living inside an attribute.

### How it was verified

The failure mode here is not an exception — it is a **dead button**. A typo in
`data-click="savSettings"` is not a syntax error, not a load-time error, and produces no
user-visible message. So:

- A static test asserts every `data-click/click-self/change/input` names a function its
  page's script actually defines. Mutation-tested: introducing `savSettings` fails it.
- Tests also assert no page contains an inline `on*=` handler, that every
  `data-click-el` points at an element that exists, and that any page declaring `data-*`
  handlers loads `actions.js`.
- In a real browser under the tightened header: all 57 dashboard actions and all 13
  storefront actions resolve to functions, zero inline handlers remain, nav and two-arg
  sub-tabs work, clicking a child element still reaches the handler via `closest()`, the
  backdrop guard closes on the overlay but **not** on the dialog inside it, and the
  ROI form's submit is still prevented (checked via `dispatchEvent`'s return value —
  a listener registered on the form itself runs *before* the document-level one and
  reports `defaultPrevented: false`, which looks like a failure and is not).
- Confirmed no page script is IIFE-wrapped, since a function defined but not global
  would satisfy the static test and still fail at runtime. Only `roi-calculator.js` is,
  and it declares no function-valued handlers.

### The CSP now

    script-src       'self' https:
    script-src-attr  'none'
    object-src       'none'
    base-uri         'self'

`style-src` still allows `'unsafe-inline'` — addressed in §23, which also corrects the
counts stated here (there are 819 style attributes and ten `<style>` blocks, not ~200
and one).


---

## 23. style-src, and where the line was drawn

`style-src` no longer allows `'unsafe-inline'`. `style-src-attr` still does, deliberately.

### The measurements that decided the scope

The estimate in §22 was wrong, and the real numbers change the answer:

| | count |
|---|---|
| inline `<style>` blocks | 10 (not 1) |
| `style="…"` attributes in markup | 628 |
| `style="…"` built into `innerHTML` by JS | 191 |
| `el.style.x = …` via CSSOM | 101 |

### What CSP actually blocks, tested rather than assumed

A scratch page served under `style-src-attr 'none'` established the boundary:

| | under `style-src-attr 'none'` |
|---|---|
| `style="…"` in markup | **blocked** |
| `style="…"` injected via `innerHTML` | **blocked** |
| `setAttribute('style', …)` | **blocked** |
| `el.style.color = …` (CSSOM) | **allowed** |

So the 101 CSSOM assignments were never at risk, and the 819 attributes all were. A
second scratch page confirmed the split this change relies on: `style-src 'self'` blocks
an inline `<style>` block while `style-src-attr 'unsafe-inline'` keeps every attribute
working, including ones injected through `innerHTML`.

### Where the line is, and why

Extracting ten `<style>` blocks is mechanical and verifiable. Converting 819 style
attributes to classes is not: it touches every page including the customer purchase
flow, there is no browser-level regression coverage to catch what it breaks, and the
thing it buys is much smaller than the script work bought — **CSS injection cannot
execute code**. It can exfiltrate via attribute selectors and redress the UI, which is
worth fixing eventually, but not at that risk in one pass.

So `<style>` blocks are gone and `style-src-attr 'unsafe-inline'` stays.

### The line that must not be tidied away

`'style-src-attr'` is now stated **explicitly**. An absent `style-src-attr` inherits
`style-src`, which no longer has `'unsafe-inline'` — deleting the line as redundant would
silently drop all 819 style attributes and break the layout on every page. A test asserts
it is present, precisely because removing it looks like cleanup.

### Verification

Every extraction byte-identical against the original block, and the `<link>` placed at
the exact position the `<style>` occupied so it still overrides `styles.css`. In a
browser: `login.css`'s computed values compared **against production** across every
selector it defines — zero differences; `storefront.css` 52 rules load and the 24 with
elements on the page all apply; `dashboard.css` 94 rules load with three apparent
mismatches, each confirmed to be correct cascade (`#app` carries an inline
`display:none` pre-auth, and `.dash-section.active` / `.sub-pane.active` override their
base rules).

Both guards mutation-tested: reintroducing a `<style>` block fails, and deleting the
`style-src-attr` line fails.

### Reverted: style-src cannot drop 'unsafe-inline'

**This shipped, broke production, and was reverted.** Clerk styles its sign-in widget by
injecting a `<style>` element into the document at runtime. Under `style-src 'self'
https:` that element is blocked and arrives empty, so the entire login form renders as
unstyled browser defaults — visibly broken, on the auth path.

Why the local checks missed it: the Clerk widget only renders with a live publishable
key, so locally `#clerk-signin` was an empty container. Every check passed against a
component that was not there. The regression was caught by screenshotting **production**
after deploy, which is the only reason it was found in minutes rather than by a user.

The lesson generalises past Clerk: `style-src` restricts any third-party widget that
styles itself at runtime, and those are exactly the components that do not render in a
local no-credentials environment. A CSP change involving a hosted widget has to be
verified against a page where that widget actually renders.

`style-src` is back to `'self' 'unsafe-inline' https:`, with a test asserting it stays
that way so the next attempt starts from this finding instead of rediscovering it the
same way. The `<style>` extraction was kept — it is worth having regardless, and
`style-src-attr` is still stated explicitly so the 819 attributes no longer depend on
`style-src`'s value.

### The CSP now

    script-src       'self' https:
    script-src-attr  'none'
    style-src        'self' 'unsafe-inline' https:   ← required by Clerk
    style-src-attr   'unsafe-inline'                 ← 819 attributes
    object-src       'none'
    base-uri         'self'

The script surface is fully closed. The style surface is not, and cannot be without
either Clerk-supported nonces or dropping Clerk.

### Not done

The 819 style attributes, and `style-src` itself. Error tracking remains blocked on
decision #13.


---

## 24. CSP violation reporting

Directly motivated by §23. When `style-src` blocked the `<style>` element Clerk injects,
the login form rendered unstyled **in production, on the auth path**, and nothing raised
a signal. Nothing threw, no request 500'd, the HTML was byte-perfect. It was found by a
human opening the page and looking at it.

Every visitor's browser knew. None of them had anywhere to say so. `report-uri` now
points at `/api/csp-report`.

This is the part of error tracking that needs no vendor and no decision — worth having
regardless of how #13 lands.

### The failure mode being designed against

The endpoint is unauthenticated (browsers send these with no credentials and will not
negotiate), every visitor's browser can post to it, and one bad directive fires on
**every page view**. Alerting per report would be a self-inflicted outage. So:

- **Extension noise is dropped.** `chrome-extension:`, `moz-extension:`, `about:` and
  friends are the overwhelming majority of real-world reports — a password manager
  restyling a login form is not a regression. Left in, this endpoint would alert
  constantly and be muted within a day, which is the same as not having it.
- **One alert per distinct violation, per process.** Signature is
  `directive | blocked-uri | document *path*` — the path, because query strings carry
  order ids and shop slugs, so two shops hitting one bug is one bug.
- **Held in memory, not the database.** The map empties on restart, so the first deploy
  after a bad change re-reports it rather than staying quiet because an earlier release
  already mentioned it. Capped at 200 signatures.
- **Answers 204 immediately**, before parsing. A browser is never made to wait, and a
  body that cannot be parsed is not the reporter's problem. Rate-limited to 60/min, and
  its limiter answers 204 too rather than JSON the browser never asked for.
- Body capped at 16 KB, and parsed for `application/csp-report` *and*
  `application/reports+json` — `express.json()` ignores both by default and would have
  handed the route an empty body.

### Verified against the actual bug

Not just unit-tested. With `style-src` temporarily re-tightened locally, a real browser
injecting a `<style>` element produced a real report, delivered and logged:

    CSP violation (first occurrence): directive: style-src-elem | blocked: inline | page: /wa-b/login.html

That is character-for-character the signature the Clerk regression produced, and it is
the string the test asserts. Also confirmed live: extension-scheme reports are dropped,
and a repeat of a known signature logs nothing.

Worth noting what this run *also* confirmed — Clerk injects no `<style>` at all locally,
which is precisely why §23 shipped broken. The blind spot is real and is not fixed by
being more careful; it is fixed by the browser being able to report.

### A defect found by testing it against production

The first deploy answered **500** to an unparseable body. `express.json()` throws before
the route runs, so the route's own "answer 204 first, always" never got the chance and
the generic handler turned it into a server error — making the file's own comment
("a report that cannot be parsed is still not the reporter's problem") false.

Browsers do not send garbage, so the practical impact was small, but a reporting endpoint
that answers 5xx manufactures the errors it exists to surface. A dedicated error handler
now swallows it to 204. Found only because the live endpoint was poked with a malformed
body rather than only the well-formed ones the unit tests cover.

### Not done

Error tracking proper (decision #13) — this covers blocked resources, not JavaScript
exceptions. The 819 style attributes, and `style-src` itself.


---

## 25. Client-side error reporting

The companion to §24, and the other half of what was missing. That endpoint hears about
resources the browser **blocked**; this one hears about JavaScript that **ran and threw**.

Both describe failures the server cannot see. A `TypeError` in `dashboard.js` returns 200
for every request, logs nothing, and leaves a merchant looking at a screen that quietly
stopped updating. This is the same shape as the 18 hanging endpoints in §11 — invisible
precisely because nothing errored server-side.

`public/errors.js` (≈2 KB) installs `error` and `unhandledrejection` handlers and posts to
`/api/client-error`. It loads **before** each page's own script, so an exception thrown
during parsing is still caught; a test enforces the ordering, since loading it second
would look correct and silently miss the earliest failures.

### Privacy is what shapes it

These pages carry order ids and shop slugs in their query strings. URLs are reduced to
their path in the browser **and again on the server** — the body is untrusted input like
any other, so it is not merely trusted to have been stripped already. Nothing else about
the page is collected: no form values, no cookies, no storage, no identifiers. That is
also what keeps this outside the third-party-processor question in decision #13.

### Restraint, again

- **Capped at 5 reports per page load**, deduplicated in the browser. One broken render
  loop must not become a flood before the request ever leaves.
- **One alert per distinct error per process** server-side, keyed on
  `kind|message|source|line|page`. Because `page` is already path-only, two shops hitting
  one bug produce one signature.
- **`Script error.` is dropped.** That is what a cross-origin script reports without CORS
  headers — no file, no line, no stack. It cannot be investigated, so alerting on it only
  teaches people to ignore alerts. Same for `ResizeObserver loop`, aborted fetches, and
  extension frames.
- `sendBeacon` where available, so a report survives the page being closed — which is
  exactly when a fatal error tends to happen.
- Answers 204 before parsing, rate-limited, 16 KB cap, and the same error-handler trick as
  §24 so an unparseable body cannot become a 500.

### Verified with real thrown exceptions

Not only unit tests. In a browser against a running server:

    Uncaught TypeError: Cannot read properties of null … | /wa-b/receipt.html
    ApiError: request timed out after 25000ms            | /wa-b/receipt.html   ← unhandledrejection
    Uncaught TypeError: Cannot set properties of null …  | /wa-b/_probe.js:5

The third came from a real file and captured **exact file and line**. The first two showed
`(no source)` — worth knowing why: they were injected via `eval`, which carries no
filename. That is a property of how they were triggered, not a defect, and the probe
confirmed it. Reloading the probe page with a different query string logged **nothing
further**, confirming dedup holds across page loads and across query strings.

The second line is the notable one: an unhandled rejection from a timed-out API call is
precisely the client-side symptom the 18 hanging endpoints produced.

### Not done

Decision #13 is now **partially** addressed rather than answered — see
`docs/decisions-needed.md`. A real product still adds source maps (a minified stack is
currently unreadable), release tracking, breadcrumbs, session context, and a search UI.
The choice is now against a floor rather than against zero.


---

## 26. CSRF: verified as not applicable — and what checking it found

Phase 9 lists "**No CSRF protection** — zero `csrf` references in `src/`". Verified before
building, per the ground rule, and the item is a **false alarm**.

CSRF works by the browser attaching *ambient* credentials — cookies — to a cross-site
request. This app has none:

- `public/dashboard.js` calls `Clerk.session.getToken()` and sends
  `Authorization: Bearer …`; the mobile client does the same.
- `src/middleware/auth.js` reads identity only from the `authorization` and `x-api-key`
  **headers**.
- `grep` for `req.cookies` / `cookie-parser` / `req.headers.cookie` across `src/` returns
  nothing.
- No CORS headers are configured, confirmed live against production, so the same-origin
  policy blocks cross-origin reads by default.

Browsers do not attach custom headers to cross-origin requests. A forged cross-site POST
arrives with no `Authorization` header and gets 401. Adding CSRF tokens here would be pure
complexity for zero security gain, and would risk breaking the mobile app's header auth.

### What checking it did surface

A vector in the code from §24 and §25. Both reporting endpoints are unauthenticated by
necessity, and both fed browser-supplied text straight into `alertOps` — which sends a
**WhatsApp message to the ops phone** and a push to admins. So an unauthenticated POST of:

    {"message":"URGENT: dashboard compromised, reset credentials at https://wa-b-secure.test"}

delivered exactly that, as a tappable link, through the company's own monitoring channel —
which is far more credible than a cold email. Not code execution; phishing.

`src/utils/untrustedText.js` now defangs before anything reaches an alert or a log:
`https://x` → `hxxps://x`, `www.x` → `www[.]x`, with a `[browser-reported, unverified]`
label. Defanged rather than stripped because for a CSP report the URIs *are* the signal.
Applied to the log lines too — log viewers linkify, so the same one-tap risk exists for
whoever reads them.

### Two bugs the tests caught in that helper

Worth recording because both look correct on the page:

- **`\b` prevented defanging.** `\bhttps?:\/\/` never matches in `xxxhttps://evil.test`,
  because there is no word boundary between two word characters — so padding a message
  with letters kept the link live. The anchors are gone.
- **Newlines survived.** The first control-character class deliberately skipped `\n`, but
  the alert body separates its fields with newlines, so `boom\npage: https://real.test`
  forges a `page:` field the browser never sent. Now flattened to spaces.

The character filters are written as **code-point checks, not regex literals**: as a
character class these are invisible bytes in the source, which is unreadable and easy to
edit wrongly — exactly how the newline gap survived a first pass. The test file had the
same problem and now uses `\u200B`-style escapes, which is also what `no-irregular-
whitespace` flagged.

### Not done

Phase 9's remaining named item is a formatter (`.prettierrc`); ESLint is configured and
gating CI. Decision #13 stays partially addressed.
