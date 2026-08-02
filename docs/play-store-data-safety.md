# Play Console Data Safety form — answers

Drafted from what the app (`mobile/wab_app`) and its backend actually do, not
a template. Based on: `src/models/migrate.js` (schema), `pubspec.yaml`
(third-party SDKs), and the mobile login/push/voice-input code paths.

**Context that shapes every answer below**: this app's users are merchants
(business owners/staff) managing their shop, not the shop's end customers.
End-customer data (order names, phone numbers, delivery addresses) originates
from WhatsApp conversations the *bot* has — it reaches this app only because
a merchant views/edits their own orders and customers. Google's guidance is
to disclose it regardless of source once it's transmitted through the app,
so the personal-info answers below cover both the merchant's own data and
the customer records a merchant manages.

## Does your app collect or share any of the required user data types?

**Yes.**

## Data types

### Personal info

| Type | Collected? | Shared with 3rd parties? | Purpose | Optional? |
|---|---|---|---|---|
| Name | Yes | No | Account management, App functionality | Required (merchant name); customer names optional per-order |
| Phone number | Yes | No | Account management (WhatsApp OTP login), App functionality | Required for merchant login; customer phone required to fulfill orders |
| Physical address | Yes | No | App functionality (delivery) | Required only for orders needing delivery |
| Email address | No | — | — | App itself never collects an email; a synthetic placeholder email is generated **server-side** for Paystack's API requirement and never touches the app or a real inbox |

### Financial info

| Type | Collected? | Shared with 3rd parties? | Purpose | Optional? |
|---|---|---|---|---|
| Purchase history | Yes | No | App functionality, Analytics (in-app only, not sent to any analytics SDK) | Required — it's the core order data |
| Other financial info (delivery fees, payouts, subscription plan) | Yes | No | App functionality | Required |
| Card/payment method details | **No** | — | — | Card and Mobile Money entry happens on the *customer's* WhatsApp/Paystack checkout flow, never inside this app. The app only ever sees a payment **status** (paid/unpaid) and amount, never card numbers or MoMo PINs. |

### Messages

| Type | Collected? | Shared with 3rd parties? | Purpose | Optional? |
|---|---|---|---|---|
| In-app messages | Yes | No | App functionality (Inbox screen shows the WhatsApp bot↔customer conversation so the merchant can take over) | Required for the Inbox feature |

### App activity

| Type | Collected? |
|---|---|
| App interactions, in-app search history, installed apps, other user-generated content | **No** — no analytics SDK is included (checked `pubspec.yaml`: no `firebase_analytics`, no third-party analytics/attribution package) |

### App info and performance

| Type | Collected? |
|---|---|
| Crash logs, diagnostics, other performance data | **No** — no crash-reporting SDK is included (no Crashlytics/Sentry in `pubspec.yaml`) |

### Device or other IDs

| Type | Collected? | Shared with 3rd parties? | Purpose | Optional? |
|---|---|---|---|---|
| Device or other IDs | Yes | **Yes — Google (Firebase Cloud Messaging)** | App functionality (push notifications: new order, low stock, subscription renewal/failure, message-while-bot-paused) | Optional — a merchant can decline notification permission and the app still works |

### Audio

**Not collected.** The one voice feature (`VoiceUpdateButton`, product
quick-updates) runs `speech_to_text` with `onDevice: true` explicitly set —
transcription happens entirely on-device, no audio is ever transmitted to
WA-B's servers or to any cloud speech API.

### Biometric-adjacent (WebAuthn/passkeys, fingerprint/Face unlock)

**Not collected.** Passkey authentication runs inside a browser tab against
Clerk (clerk.skes.tech), not our own servers — the private key and any
biometric data never leave the device/secure enclave, and the credential
itself (public key, signature counter) is stored by Clerk on the merchant's
Clerk account, not in WA-B's own database.

## Data sharing summary (third parties)

| Third party | What's shared | Why |
|---|---|---|
| Google Firebase Cloud Messaging | Device push token | Deliver push notifications |
| Paystack | Nothing directly from this app — the *backend* sends order amount + a synthetic email to Paystack for the customer's own WhatsApp checkout, entirely outside this app's data flow | Payment processing (customer-initiated, not merchant-app-initiated) |
| Clerk | Merchant's Clerk session token (via the "Continue with Clerk" web login handoff, `flutter_web_auth_2`) | Merchant identity verification for linking a business |

No data is sold. No data is used for advertising or shared with data
brokers.

## Security practices

- **Data encrypted in transit**: Yes — all API traffic goes over HTTPS to
  `skes.tech` (TLS via Certbot, confirmed live).
- **Data encrypted at rest**: Partially — Postgres itself isn't
  disk-encrypted by this app (relies on the Oracle Cloud VM's underlying
  storage), but sensitive values (API keys, OTP codes) are hashed, never
  stored in plaintext. Passkey credentials aren't stored by this app at all
  — Clerk holds those on its own infrastructure. On-device: OTP/session
  keys are stored via `flutter_secure_storage` (iOS Keychain / Android
  Keystore), not plain SharedPreferences.
- **Users can request data deletion**: **Resolved (2026-07-30)** —
  `public/delete-account.html`, linked from `privacy.html`, explains how to
  request deletion (email `dev@skes.tech` from an address you control,
  identify the business by its registered WhatsApp number), what's deleted,
  the 30-day timeframe, and how to request deletion of a single customer's
  data instead of the whole account. Live at
  `https://skes.tech/wa-b/delete-account.html` once deployed — use that as
  Play Console's "data deletion" URL.
- **Committed to Play's Families Policy / Data safety section review**: N/A
  — this is a B2B business tool, not targeted at children.

## "Data deletion or account deletion" URL for Play Console

`https://skes.tech/wa-b/delete-account.html` — built and live once deployed.
