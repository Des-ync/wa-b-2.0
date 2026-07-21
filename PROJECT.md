# Project: WhatsApp Commerce & Subscription SaaS Codebase Audit

## Architecture
This application is a WhatsApp Commerce & Subscription SaaS.
- **Stateful Conversation Engine & Webhooks**: Ingests incoming WhatsApp webhooks, routes them per tenant, queues messages for sequential processing, uses locking mechanisms to prevent concurrency races.
- **SaaS Billing & Renewals**: Integrates Paystack (dominant/active gateway for both order checkout and subscription billing) with Hubtel kept as an inactive legacy fallback. Manages plan transitions, webhook event signature verification, and daily renewal crons.
- **Security & Authentication**: Uses Clerk auth, API key middleware for API endpoints, and verifies incoming provider webhook signatures.
- **Database**: SQLite/PostgreSQL used for storage.

## Code Layout
- `src/server.js` - Main Express application entry point.
- `src/worker.js` - Queue consumer and background processing worker.
- `src/config/` - Database and env configuration.
- `src/middleware/` - Authentication and authorization middlewares.
- `src/models/` - Database models and schema migrations.
- `src/routes/` - Express route handlers (auth, payment, subscription, webhook, etc.).
- `src/services/` - Core business logic services (conversation, payment, subscription, webhook processor).
- `src/utils/` - Shared utility functions and logger.
- `test/` - Existing and newly created audit verification test files.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Scoping | Initial codebase walkthrough and setup analysis | None | DONE |
| 2 | Stateful Conversation Engine Audit | Audit conversation handler, queue, lock, whatsapp service, webhooks route | M1 | DONE |
| 3 | SaaS Billing & Renewals Audit | Audit Paystack, Hubtel, subscription service, payment routes | M1 | DONE |
| 4 | Security & Authentication Audit | Audit auth middleware, routes, API keys, database models | M1 | DONE |
| 5 | Test Suite & Final Report | Synthesize findings into audit_report.md, verify demonstration test scripts | M2, M3, M4 | DONE |

## Interface Contracts
- **Audit Findings Schema**: All finding records must specify Severity (Critical, High, Medium, Low), File Path, Line Range, Flaw Description, Impact, and proposed Remediation Code.
- **Verification Scripts**: Any bug/vulnerability proof-of-concept tests must be written to `test/` or `scratch/` using standard JavaScript assertion runners (e.g. Node.js `assert`), verify the exact vulnerability, and run successfully without breaking other tests.
