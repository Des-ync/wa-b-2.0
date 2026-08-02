# WA-B Mobile App — Setup Guide

The Flutter app lives in `mobile/wab_app` and talks to the same API as the web
dashboard. Merchants log in with a WhatsApp OTP; your team logs in with an
`sk_admin_...` key.

## Run it locally

```bash
cd mobile/wab_app
flutter pub get
flutter run                 # picks a connected device / running simulator
```

The API base URL defaults to the production server. Point it elsewhere at
launch time:

```bash
flutter run --dart-define=API_BASE_URL=http://localhost:3000
```

(On the Android emulator use `http://10.0.2.2:3000` to reach your Mac's
localhost.)

## Merchant login flow

1. The business must be onboarded (exists in `businesses`) **and** linked to a
   Clerk account via the web dashboard first — mobile login refuses unlinked
   businesses with `link_required`.
2. In the app: enter the business WhatsApp number → a 6-digit code arrives on
   WhatsApp → enter it → the backend issues a per-device `sk_live_...` key the
   app keeps in secure storage (Keychain / Keystore).
3. Logout revokes that key server-side.

## Passkeys

Passkeys are entirely Clerk's responsibility, not our own — the app opens
`public/mobile-clerk-bridge.html` in a secure in-app browser tab (same
mechanism as "Continue with Clerk") and lets Clerk's own JS SDK run the whole
WebAuthn ceremony (`user.createPasskey()` to add one, from Settings →
Security; `signIn.authenticateWithPasskey()` to sign in with one, from
"Sign in with a passkey" on login). We never see the credential — Clerk
stores it on the merchant's Clerk account. See `public/mobile-clerk-bridge.js`
for the `?intent=` handling and `mobile/wab_app/lib/state/session.dart`'s
`loginViaPasskey`/`registerPasskey`.

Because it's browser-based (the same "Use passkey instead" flow that already
works on the web dashboard's login page), it works on **iOS and Android
today** — no Apple Developer Team ID, Associated Domains entitlement, or
Android digital-asset-links file needed; those were only required for the
earlier native-OS-passkey approach (`androidx.credentials` / iOS
`ASAuthorizationController`) this app used before, which this replaced.

One consequence of routing through Clerk: passkeys are only available to a
business that's already linked to a Clerk account (the same `link_required`
gate "Continue with Clerk" already has) — a merchant who has only ever used
WhatsApp OTP won't see a working passkey option until they link on the web
dashboard first.

- **Testing on the iOS Simulator**: passkeys need Face ID "enrolled" first —
  Simulator menu → Features → Face ID → Enrolled.

## Team / admin login

On the login screen tap **Team login** and paste an `sk_admin_...` key
(generate one with `npm run issue-key`). Admin devices receive platform alert
pushes (the same events as `OPS_ALERT_PHONE`).

## Push notifications — Firebase checklist (~10 minutes)

1. Go to https://console.firebase.google.com → **Add project** (e.g. `wa-b`).
   Analytics optional.
2. **Add an Android app**: package name `com.wab.wab_app`.
   Download `google-services.json` → put it at
   `mobile/wab_app/android/app/google-services.json`.
3. **Add an iOS app**: bundle ID `com.wab.wabApp`.
   Download `GoogleService-Info.plist` → put it at
   `mobile/wab_app/ios/Runner/GoogleService-Info.plist`
   (open `ios/Runner.xcworkspace` in Xcode and drag it into the Runner target
   so it's bundled).
4. Backend: Firebase console → ⚙️ Project settings → **Service accounts** →
   **Generate new private key**. Copy the JSON to the server and set in `.env`:
   `FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/firebase-service-account.json`
   (or `FIREBASE_SERVICE_ACCOUNT_JSON=<base64 of the file>`). Restart the API.
5. Android push now works end-to-end.

### iOS push (needs the Apple Developer account, $99/yr)

Once enrolled at https://developer.apple.com/programs/:

1. Apple Developer → Certificates, IDs & Profiles → **Keys** → create a key
   with **Apple Push Notifications service (APNs)** enabled. Download the
   `.p8` file, note the Key ID and your Team ID.
2. Firebase console → Project settings → **Cloud Messaging** → iOS app →
   upload the `.p8` with Key ID + Team ID.
3. In Xcode (Runner target → Signing & Capabilities): set your team, and add
   the **Push Notifications** + **Background Modes → Remote notifications**
   capabilities.
4. Build to a real iPhone (`flutter run --release`). Push now works on iOS.

Until then the iOS app runs fine in the simulator — everything works except
real push banners.

## What the backend sends pushes for

| Event | Who gets it |
|---|---|
| Order paid | The business's devices |
| Customer message while bot is paused (human takeover) | The business's devices |
| Low stock / out of stock | The business's devices |
| Subscription renewed / payment failed | The business's devices |
| Unhandled platform errors (ops alerts) | Admin devices |

Device tokens are registered at `POST /api/devices/register` after login and
removed on logout; dead tokens are pruned automatically after failed sends.

## Publishing

- **Android**: `flutter build appbundle` → upload to Google Play Console
  (one-time $25 developer fee).
- **iOS**: `flutter build ipa` → upload with Xcode/Transporter to App Store
  Connect (needs the Apple Developer account).
