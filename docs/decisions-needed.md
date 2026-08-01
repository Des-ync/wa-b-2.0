# Decisions needed — KweliChat / WA-B improvement program

Raised during Phase 0 (2026-07-30, commit `4d8d48b`). Nothing below is being guessed at;
each item blocks a specific task in [improvement-plan-2026.md](./improvement-plan-2026.md).

Answer format: edit this file in place, or reply with the numbers.

---

## A. Carried over from `improvement-prompt.md` §Blocked decisions

### 1. Should failed MoMo payments auto-retry?
If yes: how many attempts, at what interval?
**Blocks:** nothing in Phase 1–5; would become a Phase 7 automation template.
**Context found:** all retry today is customer-initiated via the `retrypay_<id>` button
(`conversation.handler.js:1039`). Unattended re-charging of a customer's MoMo wallet
without fresh consent is a compliance question, not just an engineering one.
**Recommendation:** keep it customer-initiated. The retry prompt already fires
automatically on failure with a humanized reason; that covers most of the value.

### 2. Payment-reminder cadence, and when does an unpaid order auto-cancel?
**Blocks:** a Phase 7 automation template.
**Context found:** merchant-triggered reminders already exist —
`POST /api/orders/:id/payment-reminder` (`order.routes.js:379`), rate-limited to one per
10 minutes per order. There is no *automatic* cadence and no auto-cancel anywhere.
**Needed:** (a) first automatic reminder at T+? hours; (b) how many total; (c) auto-cancel
at T+? or never.

### 3. Verified-shop badge — criteria, and who approves?
**Blocks:** Phase 6 entirely for this item. No schema column, no UI, nothing to build against.
**Needed:** manual admin review / auto-derived from onboarding completion / KYC document
check — and who the approver is.

### 4. Should refunds auto-restock inventory? ✅ RESOLVED — implemented 2026-07-30
**Blocks:** a small change in `order.service.js#createRefund`.
**Context found:** `markOrderPaid` decrements stock (including variant stock, verified in
`test/order.service.test.js`). `createRefund` does **not** currently restock. So today a
refunded order permanently loses the stock. That is very likely a bug, but the right
behaviour is a business rule (a refunded perishable food order is not restockable; a
refunded boutique item is).
**Resolved as recommended:** a per-business `refund_restocks_inventory` setting,
defaulted **off** for `food`/`grocery`/`pharmacy` and **on** otherwise, overridable from
business settings. Only a FULL refund restocks; partial refunds cannot know which item
they covered. Applied by a BEFORE INSERT trigger rather than at the INSERT sites, because
the one-time backfill only covered businesses that already existed — a chop bar onboarded
later would otherwise have started restocking refunded food.

### 5. Live MoMo test payment during onboarding — real ₵1 charge, or simulated?
**Blocks:** one onboarding checklist step. Everything else in onboarding is shipped.
**Context found:** the `payment_provider` step is a configuration-presence check only
(`onboarding.routes.js:32–36`). No live test-charge endpoint exists anywhere.

### 6. Mobile-vs-web scope: full parity, or is web the "back office"?
**Blocks:** the scope of Phases 4 and 8.
**Context found — this has changed materially since the audit.** The mobile app is no
longer a thin subset: 36 screens / 9,106 lines, including accounting, categories, bundles,
automations, audit log, notifications, onboarding checklist and admin ops. The remaining
web-only surfaces are narrow. **Recommendation:** declare mobile primary and complete, and
keep `public/dashboard.html` as a power-user surface for bulk/CSV/export work only — which
also reduces the Phase 9 decomposition burden.

### 7. Refund and cancellation policy — platform default, or merchant-authored?
**Already answered by the code — confirm it.** `receipt.routes.js` reads
`b.refund_policy` and falls back to a `DEFAULT_REFUND_POLICY` constant. That is
"merchant-authored with a platform default". **Confirm this is intended**, and if so
whether merchants can currently edit `refund_policy` from mobile (they cannot today —
`settings.dart` does not expose the field).

---

## B. New decisions surfaced during Phase 0 verification

### 8. Does the historical "mark paid" bug need remediating in production data?
**Blocks:** Phase 1.4.
The bug is fixed in code, but any order a merchant flipped to `paid` through the old
`PATCH /:id/status` path **before** the fix still has `payment_status` stuck at
`pending`/`unpaid` — permanently missing from GMV, analytics and loyalty.
**Needed:** (a) run the dry-run report? (b) if the damage is non-zero, do we backfill
`payment_status` and the loyalty ledger, or accept the historical gap and only fix
forward? Backfilling loyalty means retroactively granting customers points/stamps they
were never told about, which may generate support load.
**Recommendation:** run the report; backfill `payment_status` and GMV (silent, corrects
the books) but **not** loyalty rewards (customer-visible, would need a message).

**Status 2026-07-30 — still open, blocked on access, not on a decision.** The script
exists and is verified. It was run against the **local** `whatsapp_saas` database, which
is clean (one correctly-paid demo order). Production lives on the Oracle Cloud VM and is
not reachable from a dev machine, and the script is not deployed there yet because this
work is unmerged.

To get the answer, once this branch is merged and deployed:

```
cd /opt/wa-b-2.0 && node src/jobs/reconcile.paidStatus.js
```

That is **read-only** — it prints affected orders, per-business counts and the unrecorded
GMV total, and changes nothing. Only re-running it with `--apply` mutates anything, and
that remains a separate, explicit decision once the size of the damage is known.

### 9. Raw gateway failure codes in the merchant UI — how raw?
**Blocks:** Phase 1.2.
`NOT_ENOUGH_FUNDS` is legible. Paystack's `gateway_response` free text can be far less so,
and occasionally contains PII-adjacent detail.
**Needed:** show the raw string verbatim, or show it only behind a "technical details"
disclosure? **Recommendation:** disclosure, defaulting collapsed.

### 10. Should `loyalty.jobs.js` (birthday coupons) be folded into the automations engine?
**Blocks:** Phase 7 scope.
It is currently a standalone cron registered in `cronJobs.js`, while `automations.js`
already provides exactly this pattern generically. Two mechanisms doing one job is how the
original duplicate-cron bug happened.
**Recommendation:** fold it in during Phase 7.

### 11. Flutter test tooling — which mocking package? ✅ RESOLVED (mocktail)
**Was blocking:** Phase 2 scaffolding. Taken 2026-07-30.
`mocktail` (null-safe, no codegen) vs `mockito` (codegen via `build_runner`).
**Recommendation:** `mocktail` — no build step, so CI stays fast and the repo gains no
generated files.

### 12. Is a mobile CI job acceptable? ✅ RESOLVED (separate PR-only workflow)
**Was blocking:** Phase 2's CI gate. Taken 2026-07-30.
Adding `flutter test` to `.github/workflows/deploy.yml` means installing the Flutter SDK on
every push to `main`, adding roughly 2–3 minutes to a pipeline that currently gates a
production deploy. **Alternative:** a separate workflow that runs on PRs only and does not
gate deploy. **Recommendation:** separate workflow, PR-only.

### 13. Error tracking — Sentry, or self-hosted?
**Now the single highest-value unblocked-by-you item.** The 18 hanging endpoints described
in §11 of the improvement plan were live in production and nothing reported them: a hung
request produces no error log, no 5xx, and no alert. Error tracking would have surfaced
them the first time a merchant's dashboard spun.

**Blocks:** Phase 9.
Sentry's free tier is generous but is a third-party data processor, which interacts with
the existing `data-processing.html` commitments. **Needed:** approval of the vendor, or a
self-hosted alternative (GlitchTip), or a decision to stay on log-grepping.

**Partially addressed, still open.** `/api/csp-report` (§24) and `/api/client-error`
(§25) now cover blocked resources and uncaught JavaScript exceptions, first-party, with
no third-party processor involved — so the question is no longer "anything vs nothing".
What a real product still adds: source maps (a minified stack is currently unreadable),
release tracking, breadcrumbs leading up to the error, user/session context, and a search
and aggregation UI instead of one WhatsApp message and a log line. **Still needed:** the
vendor decision, now against a floor rather than against zero.

### 13b. CSRF — closed, no decision needed
Verified as not applicable: no cookie auth anywhere, header-based Bearer/`x-api-key` only,
no CORS. See improvement-plan §26. No action required.

### 14. Are `.env` and `firebase-service-account.json` in the working tree intentional?
**Not a blocker, flagged for awareness.** Both are present at the repo root. `.gitignore`
covers them and `git status` confirms neither is tracked, so nothing is committed — but
Phase 9's "secret scanning in CI" should be scoped to catch this class of file before it
ever is.
