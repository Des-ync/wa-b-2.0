# Decisions needed — KweliChat / WA-B improvement program

Raised during Phase 0 (2026-07-30, commit `4d8d48b`). Nothing below is being guessed at;
each item blocks a specific task in [improvement-plan-2026.md](./improvement-plan-2026.md).

Answer format: edit this file in place, or reply with the numbers.

---

## A. Carried over from `improvement-prompt.md` §Blocked decisions

### 1. Should failed MoMo payments auto-retry? ✅ RESOLVED 2026-08-05
**Decided:** keep it customer-initiated, as recommended. No unattended re-charging.

### 2. Payment-reminder cadence, and when does an unpaid order auto-cancel? ✅ RESOLVED 2026-08-05
**Decided:** aggressive cadence — first automatic reminder at T+1 hour, order auto-cancels
at T+24 hours if still unpaid. Builds on the existing merchant-triggered
`POST /api/orders/:id/payment-reminder` (`order.routes.js:379`) rather than replacing it.

### 3. Verified-shop badge — criteria, and who approves? ✅ RESOLVED 2026-08-05
**Decided:** manual admin review. Needs a schema column (e.g. `businesses.verified_at`/
`verified_by`), an admin review queue/UI, and a badge on the storefront/receipt — nothing
built yet, this just unblocks starting the work.

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

### 5. Live MoMo test payment during onboarding — real ₵1 charge, or simulated? ✅ RESOLVED 2026-08-05
**Decided:** real ₵1 test charge. The onboarding `payment_provider` step needs a genuine
sandbox/live charge-and-refund-back flow, not just the current config-presence check
(`onboarding.routes.js:32–36`).

### 6. Mobile-vs-web scope: full parity, or is web the "back office"? ✅ RESOLVED 2026-08-05
**Decided:** mobile primary, as recommended — declare the Flutter app the complete
day-to-day merchant experience, keep `public/dashboard.html` for power-user tasks only
(bulk/CSV/export, accounting reports, rare admin actions), not full parity.

### 7. Refund and cancellation policy — platform default, or merchant-authored?
**Already answered by the code — confirm it.** `receipt.routes.js` reads
`b.refund_policy` and falls back to a `DEFAULT_REFUND_POLICY` constant. That is
"merchant-authored with a platform default". **Confirm this is intended**, and if so
whether merchants can currently edit `refund_policy` from mobile (they cannot today —
`settings.dart` does not expose the field).

---

## B. New decisions surfaced during Phase 0 verification

### 8. Does the historical "mark paid" bug need remediating in production data? ✅ RESOLVED 2026-08-05 (approach); report still needs to be run
**Decided:** as recommended — backfill `payment_status` and GMV only (silent, corrects the
books), do **not** backfill loyalty points/stamps (customer-visible, would need a message
and risks support load). This decision doesn't unblock itself: the report still needs to
be run against production once this branch is deployed —

```
cd /opt/wa-b-2.0 && node src/jobs/reconcile.paidStatus.js
```

— to know whether the damage is zero or non-zero before the backfill (`--apply`) step.

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

### 9. Raw gateway failure codes in the merchant UI — how raw? ✅ RESOLVED 2026-08-05
**Decided:** disclosure, defaulting collapsed, as recommended. Show a humanized reason by
default; raw gateway string available behind a "technical details" tap.

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

**✅ RESOLVED 2026-08-05 — stay on first-party only (logs + `/api/csp-report` +
`/api/client-error`), no third-party vendor for now.** No new data-processing-agreement
question to resolve. Revisit if another undetected-hang incident like the 18 hanging
endpoints happens again — that's the concrete trigger for reopening this, not a fixed
timeline.

### 13b. CSRF — closed, no decision needed
Verified as not applicable: no cookie auth anywhere, header-based Bearer/`x-api-key` only,
no CORS. See improvement-plan §26. No action required.

### 14. Are `.env` and `firebase-service-account.json` in the working tree intentional?
**Not a blocker, flagged for awareness.** Both are present at the repo root. `.gitignore`
covers them and `git status` confirms neither is tracked, so nothing is committed — but
Phase 9's "secret scanning in CI" should be scoped to catch this class of file before it
ever is.
