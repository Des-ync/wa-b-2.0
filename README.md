# WhatsApp Commerce & Subscription SaaS (Ghana)

A production-ready Node.js + Express + PostgreSQL platform that lets Ghanaian SMEs sell, accept payments, and manage customer orders entirely through WhatsApp — and bills those SMEs monthly via Mobile Money for using the platform.

- **End-customer flow** (browse menu → cart → address → MoMo/Card payment → confirmation) over WhatsApp Cloud API.
- **SaaS billing flow** (PAY / RENEW / STATUS / UPGRADE / CANCEL / SUPPORT) via pawaPay MoMo deposits (server-initiated collections, flat 1%).
- Stateful conversation engine with durable webhook queue, full audit trail, cron-driven renewals/reminders/suspensions.

---

## 1. Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | ≥ 18 LTS |
| PostgreSQL | ≥ 14 |
| ngrok (dev) | latest |
| Meta Business account | with WhatsApp Cloud API app |
| Paystack account | test or live |
| pawaPay merchant account | with Ghana deposits enabled |

---

## 2. Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in every required value:

| Var | Required | Purpose |
| --- | --- | --- |
| `PORT` | | HTTP port (default `3000`) |
| `NODE_ENV` | | `development` or `production` |
| `PUBLIC_BASE_URL` | ✅ | Your public URL (ngrok in dev). Used in webhook callback URLs. |
| `DATABASE_URL` | ✅ | `postgresql://user:pass@host:5432/whatsapp_saas` |
| `WA_PHONE_NUMBER_ID` | ✅ | Default WhatsApp Cloud API phone number ID (platform inbox) |
| `WA_ACCESS_TOKEN` | ✅ | Long-lived Meta access token |
| `WA_VERIFY_TOKEN` | ✅ | Any secret string — must match the value entered in Meta UI |
| `WA_API_VERSION` | | Default `v19.0` |
| `PAYSTACK_SECRET_KEY` | ✅ | `sk_test_...` or `sk_live_...` |
| `PAYSTACK_PUBLIC_KEY` | | `pk_test_...` or `pk_live_...` |
| `PAWAPAY_API_TOKEN` | ✅ | pawaPay API token (sandbox or production) |
| `PAWAPAY_BASE_URL` | | Defaults to sandbox `https://api.sandbox.pawapay.io`; set `https://api.pawapay.io` for production |
| `HUBTEL_*` | | Legacy — only to receive callbacks for charges initiated before the pawaPay switch |
| `SUPPORT_WHATSAPP_NUMBER` | ✅ | E.164 number shown in *SUPPORT* replies |
| `DEFAULT_TRIAL_DAYS` | | Days of free trial on new businesses (default `14`) |
| `SUSPENSION_GRACE_DAYS` | | Days past renewal before auto-suspension (default `3`) |
| `LOG_LEVEL` | | `debug` / `info` / `warn` / `error` |
| `RUN_CRON` | | Set `false` on replica instances (default `true`) |
| `RUN_PROCESSOR` | | Set `false` on replica instances (default `true`) |
| `PROCESSOR_INTERVAL_MS` | | Webhook queue poll interval (default `1500`) |

---

## 3. Local setup

```bash
# 1. Install dependencies
npm install

# 2. Create the database
createdb whatsapp_saas   # or: psql -c "CREATE DATABASE whatsapp_saas;"

# 3. Configure .env
cp .env.example .env
# edit .env with your credentials

# 4. Run the migration (creates all tables, indexes, triggers)
npm run migrate

# 5. Seed the 3 SaaS plans + a sample business with products
npm run seed

# 6. Issue an admin API key (save the printed key — shown only once)
npm run issue-key admin "my dashboard"

# 7. Start the dev server
npm run dev         # nodemon-watched
# or
npm start           # production-style
```

Server boots on `http://localhost:3000`. Health check: `GET /health`.

---

## 4. Expose your local server with ngrok

WhatsApp + Paystack + pawaPay webhooks need a public HTTPS URL. In a separate terminal:

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` forwarding URL and:

1. Set `PUBLIC_BASE_URL=https://xxxx.ngrok.io` in `.env`.
2. Restart `npm run dev`.

---

## 5. Configure Meta (WhatsApp Cloud API) webhook

1. In **Meta for Developers → your app → WhatsApp → Configuration**:
   - **Callback URL**: `https://xxxx.ngrok.io/api/webhooks/whatsapp`
   - **Verify Token**: same value as `WA_VERIFY_TOKEN` in `.env`
2. Click **Verify and Save**. The server echoes `hub.challenge` when the token matches.
3. Subscribe to the `messages` webhook field.
4. In **Phone numbers**, copy the **Phone Number ID** — you will need it below.

Sanity check (must return `test`):
```
GET https://xxxx.ngrok.io/api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=test&hub.verify_token=YOUR_VERIFY_TOKEN
```

### Tenant routing — important

Each business tenant must have `wa_phone_number_id` set in the `businesses` table. This is how inbound webhooks are routed to the right tenant:

```sql
UPDATE businesses
   SET wa_phone_number_id = '<Phone Number ID from Meta>'
 WHERE id = '<your-business-uuid>';
```

Without this field set, inbound messages for that tenant will be silently dropped (fail-safe — never leak between tenants).

---

## 6. Configure Paystack webhook

1. **Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL**:
   `https://xxxx.ngrok.io/api/payments/paystack/webhook`
2. Paystack signs each event with HMAC-SHA512 of the raw body using your `PAYSTACK_SECRET_KEY`. The server verifies `x-paystack-signature` and rejects unverified events.
3. Card payment redirect callback URL:
   `https://xxxx.ngrok.io/api/payments/paystack/callback`

---

## 7. Configure pawaPay callback

1. In the **pawaPay dashboard → API configuration → Callback URLs**, set the deposit callback to:
   `https://xxxx.ngrok.io/api/payments/pawapay/callback`
2. No shared-secret HMAC is needed on this endpoint: the callback body is treated purely as a trigger. Before any billing state changes, the queue processor re-verifies the deposit with `GET /v2/deposits/{depositId}` against pawaPay's API, so forged callbacks cannot fake a payment.
3. The legacy `POST /api/payments/hubtel/callback` route (HMAC-verified) remains mounted for charges initiated before the pawaPay switch; it can be removed once no `hubtel` transactions are pending.

---

## 8. API authentication

All mutating and sensitive API routes require an API key passed as:

```
Authorization: Bearer sk_admin_xxxx
# or
X-Api-Key: sk_admin_xxxx
```

**Scopes:**

| Scope | Access |
| --- | --- |
| `admin` | All routes |
| `tenant` | Own business's orders and subscriptions only |

### Issue keys

```bash
# Admin key (no business restriction)
npm run issue-key admin "ops dashboard"

# Tenant key (restricted to one business)
npm run issue-key tenant <business-uuid> "POS station 1"
```

The plaintext key is printed once. Only a SHA-256 hash is stored. Revoke via:

```sql
UPDATE api_keys SET revoked_at = NOW() WHERE id = '<key-uuid>';
```

### Public routes (no auth required)

- `GET /api/subscriptions/plans`
- `GET /api/webhooks/whatsapp` (Meta verification)
- `POST /api/webhooks/whatsapp`, `POST /api/payments/*` (webhook callbacks — verified by HMAC instead)

---

## 9. API endpoints

### WhatsApp webhook

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET  | `/api/webhooks/whatsapp` | None | Verification handshake (Meta) |
| POST | `/api/webhooks/whatsapp` | None (HMAC-verified) | Inbound messages + status updates |

### Payments

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/payments/paystack/webhook` | None (HMAC-verified) | Paystack signed events |
| GET  | `/api/payments/paystack/callback` | None | Browser redirect after card payment |
| POST | `/api/payments/pawapay/callback` | None (verified by status re-fetch) | pawaPay deposit result callback |
| POST | `/api/payments/hubtel/callback` | None (HMAC-verified) | Legacy Hubtel payment result callback |

### Subscriptions (SaaS billing)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET  | `/api/subscriptions/plans` | None | List active plans |
| POST | `/api/subscriptions` | Admin | Create a business + start MoMo charge |
| GET  | `/api/subscriptions/:businessId` | Admin or tenant | Current subscription |
| POST | `/api/subscriptions/:businessId/renew` | Admin or tenant | Manually trigger a charge |
| POST | `/api/subscriptions/:businessId/cancel` | Admin or tenant | Cancel subscription (at period end if active) |

### Orders (commerce)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET  | `/api/orders?business_id=...` | Admin or tenant | List business orders |
| GET  | `/api/orders/:id` | Admin or tenant | Order detail |
| POST | `/api/orders` | Admin or tenant | Create an order programmatically |
| PATCH | `/api/orders/:id/status` | Admin or tenant | Update fulfilment status |

### Admin / dashboard

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/admin/stats` | Admin | KPIs (GMV, MRR, message volume, etc.) |
| GET | `/api/admin/businesses` | Admin | List businesses + current plan |
| GET | `/api/admin/billing` | Admin | Recent SaaS billing transactions |
| GET | `/api/admin/messages` | Admin | Recent message log entries |

### Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | None | DB ping + status |
| GET | `/` | None | Service banner |

---

## 10. WhatsApp commands

### End-customer (talking to an SME's number)
- `MENU`, `HI`, `HELLO`, `START` — welcome + Order Now button
- `ORDER`, `BUY`, `SHOP` — open the product menu list
- `CANCEL`, `STOP` — clear current cart / abandon flow

### SME (talking to the platform's inbox)
- `PAY` / `RENEW` / `RETRY` — initiate MoMo charge for the current plan
- `STATUS` — show plan name, period end date, message quota
- `UPGRADE` — pick a different plan
- `CANCEL` — cancel subscription (access continues to period end if active)
- `SUPPORT` — show the human support WhatsApp number

---

## 11. Cron jobs (Africa/Accra)

| Time | Job | Action |
| --- | --- | --- |
| 08:00 | `runRenewalJob` | Charge subscriptions whose `next_billing_date ≤ NOW()` via pawaPay. Also finalizes cancel-at-period-end subscriptions and clears stale conversation sessions. |
| 09:00 | `runReminderJob` | Send 3-day renewal reminders to businesses approaching billing date. |
| 10:00 | `runSuspensionJob` | Suspend businesses more than `SUSPENSION_GRACE_DAYS` past due. |

Each job acquires a DB advisory lock (`worker_locks` table) before running — only one instance executes the job body even if multiple replicas are running cron.

---

## 12. Webhook queue & worker

All inbound webhook events (WhatsApp messages, Paystack events, pawaPay/Hubtel callbacks) are persisted to the `webhook_events` table **before** the HTTP `200 OK` is sent. A background processor drains the queue and retries failed events with exponential backoff (up to 8 attempts).

**Single-process deploy** (default): the processor runs inside the HTTP server.

**Multi-instance deploy**: run exactly one dedicated worker alongside stateless API replicas:

```bash
# API replicas (stateless)
RUN_CRON=false RUN_PROCESSOR=false npm start

# One dedicated worker
npm run worker         # or: node src/worker.js
```

---

## 13. Project layout

```
whatsapp-saas/
├── src/
│   ├── server.js                       Express app + cron bootstrap
│   ├── worker.js                       Standalone cron + queue worker
│   ├── config/
│   │   └── database.js                 pg Pool + query() + transaction()
│   ├── middleware/
│   │   └── auth.js                     API key auth (issue, revoke, require)
│   ├── models/
│   │   ├── migrate.js                  Full DB schema
│   │   ├── seed.js                     Plans + sample products
│   │   └── issue-key.js                CLI: npm run issue-key
│   ├── routes/
│   │   ├── webhook.routes.js           WhatsApp inbound
│   │   ├── payment.routes.js           Paystack + pawaPay (+legacy Hubtel) callbacks
│   │   ├── subscription.routes.js      SaaS subscription management
│   │   ├── order.routes.js             Order CRUD
│   │   └── admin.routes.js             Dashboard stats API
│   ├── services/
│   │   ├── whatsapp.service.js         Send messages + templates
│   │   ├── paystack.service.js         MoMo charge, card link, signature verify
│   │   ├── pawapay.service.js          MoMo deposits (SaaS billing) + status verify
│   │   ├── hubtel.service.js           Legacy — callback verify for pre-switch charges
│   │   ├── subscription.service.js     SaaS billing lifecycle
│   │   ├── conversation.handler.js     Stateful bot brain
│   │   ├── order.service.js            Order creation + payment marking
│   │   ├── notification.service.js     Cron jobs + WhatsApp notifications
│   │   ├── webhook.queue.js            Durable event queue (webhook_events table)
│   │   ├── webhook.processor.js        Queue drainer + dispatcher
│   │   └── worker.lock.js              DB-backed single-leader cron lock
│   └── utils/
│       ├── helpers.js                  Ghana phone normalizer, formatters
│       └── logger.js                   Winston logger
├── .env.example
├── package.json
└── README.md
```

Logs are written to `./logs/combined.log` and `./logs/error.log` (rotated at 5 MB, 5 files).

---

## 14. Smoke-test checklist

- [ ] `npm install` finishes with 0 errors
- [ ] `npm run migrate` succeeds against local PostgreSQL
- [ ] `npm run seed` adds 3 plans + a sample business with products
- [ ] `npm run issue-key admin "test"` prints a `sk_admin_...` key
- [ ] `npm run dev` boots without crashes; `GET /health` returns `{"status":"ok"}`
- [ ] `GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=test&hub.verify_token=YOUR_TOKEN` returns `test`
- [ ] `businesses.wa_phone_number_id` is set; a WhatsApp message routes to the correct tenant
- [ ] `GET /api/admin/stats` with an admin key returns KPI JSON
- [ ] `GET /api/admin/stats` with no key returns `401`
- [ ] `POST /api/subscriptions` triggers a pawaPay MoMo prompt on the test number
- [ ] A successful Paystack test charge updates `orders.payment_status = 'paid'` and the customer receives a WhatsApp confirmation
- [ ] Sending a duplicate Paystack webhook for the same reference does **not** double-apply payment
