# API envelope migration — status and how-to

Phase 3 of [improvement-plan-2026.md](./improvement-plan-2026.md). Started 2026-07-30.

Route groups move onto `src/utils/response.js` and `src/utils/validate.js` **one at a
time**. Nothing is flag-dayed: an un-migrated group keeps working exactly as it does now,
and a migrated group is invisible to existing clients until they ask for v2.

---

## The two envelopes

**Legacy — the default.** Byte-for-byte what every route returns today.

```json
{ "success": true, "orders": [], "total": 12 }
{ "success": false, "error": "Product name is required" }
```

**v2 — opt in with `X-API-Version: 2`.**

```json
{ "success": true, "data": { "orders": [] }, "meta": { "total": 12 } }
{ "success": false, "error": { "code": "validation_error", "message": "...", "fields": { "name": "is required" } } }
```

Only a literal `"2"` opts in. Anything else — absent, `1`, `v2`, garbage — is legacy, so a
malformed header can never silently change the shape a client receives.

### Why negotiation, and not both shapes at once

The obvious shim is to send `data: { orders }` **and** a top-level `orders`, so old and new
clients both find what they expect. That doubles the bytes of every list response.

This product is built for merchants on expensive, intermittent 3G. A 200-order page sent
twice is a real cost to a real person, paid on every request, for the entire length of the
migration. A request header costs nothing and lets each client move when it is ready.

---

## Status

| Route group | Migrated | Tests | Notes |
|---|---|---|---|
| `category.routes.js` | ✅ | `test/category.routes.test.js` (19) | First group; the worked example. |
| `notification.routes.js` | ✅ | `test/notification.routes.test.js` (10) | `unread_count` moved to `meta`. |
| `order.routes.js` | ✅ | `orderMarkPaid`, `orderStatsToday`, `orderDelivery`, `orderPaymentReminder`, `order.paidPathParity` | Largest and highest-traffic; migrate after a smaller group has proven the pattern under load. |
| `product.routes.js` | ✅ | `test/product.routes.test.js` (31) | All four hand-rolled validators replaced by schemas. Tests written FIRST, against the old behaviour. |
| `customer.routes.js` | ☐ | — | |
| `business.routes.js` | ☐ | `businessSettings.routes.test.js` | |
| `analytics.routes.js` | ☐ | `analytics.deliverySla.test.js` | Read-only; low risk. |
| `conversations.routes.js` | ☐ | `conversationSummary.test.js` | |
| `broadcast.routes.js` | ☐ | — | |
| `promo.routes.js` | ☐ | `promoEligibility.test.js` | |
| `storefront.routes.js` | ☐ | `storefront.routes.test.js` | **Public** — the storefront HTML reads it directly. Check `public/storefront.html` before migrating. |
| `inventory.routes.js` | ✅ | `inventory.routes.test.js` | |
| `accounting.routes.js` | ☐ | `accounting.routes.test.js` | |
| `automations.routes.js` | ✅ | `automations.routes.test.js` | |
| `auditlog.routes.js` | ✅ | `auditlog.routes.test.js` | |
| `onboarding.routes.js` | ☐ | `onboarding.test.js` | Consumed by both dashboard and mobile checklist. |
| `admin.routes.js` | ☐ | `admin.routes.critical.test.js` | Largest file (1,110 lines). |
| `auth.routes.js` | ☐ | `auth.routes.test.js` | ⚠️ See the `link_required` warning below. |
| `receipt.routes.js` | ☐ | `receipt.routes.test.js` | **Public** — `public/receipt.html` reads it directly. |
| `webhook.routes.js` | ☐ | — | ⚠️ Gateways read these responses; the shape is a third-party contract, not ours. **Probably should never migrate.** |
| `payment.routes.js` | ☐ | — | Same caution as webhooks for any gateway-facing route. |
| `subscription.routes.js` | ☐ | `billingPermissions.routes.test.js` | |
| `apikey.routes.js` | ☐ | `apikey.routes.test.js` | |
| `device.routes.js` | ☐ | — | |
| `search.routes.js` | ☐ | — | |

**7 of 25 migrated.**

---

## How to migrate one group

1. `const respond = require('../utils/response');`
2. Replace each response:
   - `res.json({ success: true, x })` → `respond.ok(req, res, { x })`
   - a count/total/rate *about* the collection → `{ meta: { total } }`, not `data`
   - `res.status(201).json(...)` → `respond.ok(req, res, {...}, { status: 201 })`
   - `res.status(404).json({ success:false, error:'X not found' })` → `respond.notFound(req, res, 'X')`
   - `res.status(403)...'Key does not match business'` → `respond.forbidden(req, res)`
   - `res.status(400)...` → `respond.invalid(req, res, message, fields)`
   - the `catch` block → `respond.failInternal(req, res, logger, 'GET /x', err)`
3. Replace inline validation with a schema (`src/utils/validate.js`) and pass `fields`
   through, so a client can mark the right input.
4. Write tests that assert **both** envelopes. The legacy assertions are the contract —
   they describe the behaviour before you touched it.
5. `grep -c "res.status\|res.json" src/routes/<group>.js` should return 0.
6. **Run the group's tests.** `node -e "require('./src/routes/x.js')"` is NOT enough — see
   the hanging-route pitfall below.

### Pitfalls hit so far

- **`arrayOf`'s `max` truncates; some routes reject.** Category reorder refused a list over
  200. Silently reordering the first 200 of 250 and reporting success is worse than
  refusing, so that bound stayed explicit. Check whether a limit in the old code was a cap
  or a rejection.
- **`str`'s `max` truncates; use `strExact` to reject.** Matches the product routes'
  existing behaviour, where a long description is trimmed rather than refused.
- **⚠️ Some routes use the legacy `error` string as a machine-readable code.**
  `auth.routes.js` returns a bare `error: 'link_required'`, and `mobile/.../login.dart`
  branches on `e.code == 'link_required'`. The mobile client maps legacy `error` → `code`
  for exactly this reason. When migrating `auth.routes.js`, the v2 `error.code` must be
  `link_required` — not `validation_error` with the detail buried in a message — or
  Clerk-linked sign-in silently breaks.
- **⚠️ A missed `require` makes routes HANG, not 500.** Adding `respond.*` calls without
  the import means every request throws a ReferenceError inside its `try`, the `catch`
  calls `respond.failInternal` and throws again, and Express never responds. The module
  still loads cleanly, so `node -e "require(...)"` reports it fine. This happened while
  migrating `inventory.routes.js`. Two tests in `test/response.test.js` now guard it
  statically: one asserts every file using `respond.*` imports it, the other refuses a
  half-migrated file. Always run the group's own tests.
- **⚠️ An unbound local hangs a route the same way a missing import does.** The product
  migration left `respond.invalid(req, res, msg, fields)` next to a destructure that still
  read `const { errors, out }`. ReferenceError in the `try`, another from the `catch`,
  request never completes — and the suite stayed green because nothing exercised that
  branch. A third guard in `test/response.test.js` now scans for exactly that shape.
  **A route group with no tests must get characterisation tests BEFORE it is migrated**,
  as `product.routes.js` did.
- **`msg()` preserves legacy error prose.** Merchants read these strings; a schema's
  generated wording ("must be 0 or more") is not the same product as
  "price_ghs must be a non-negative number". Wrap the rule.
- **Public/gateway-facing routes are a third-party contract.** Webhook and payment
  responses are read by Paystack/Meta, and receipt/storefront responses by the static HTML
  in `public/`. Do not change those shapes to suit our own tidiness.

---

## Client status

`mobile/wab_app/lib/api/client.dart` **understands both envelopes already** — it unwraps
v2 `data`/`meta` into the same flat map call sites read today, and parses both error
shapes into `ApiException` (which now carries `code` and a `fields` map, with
`e.fieldError('name')` for form-level display).

It does **not** yet send the header: `ApiClient.useV2Envelope` is `false`. Turn it on once
the groups the app actually calls are migrated — `order`, `product`, `customer`,
`business`, `accounting`, `conversations`, `onboarding`, `notification`.

`public/dashboard.html` has not been touched and stays on legacy until the Phase 9
decomposition.
