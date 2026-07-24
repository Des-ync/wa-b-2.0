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

Merchants can add a passkey (Settings → Security, or "Sign in with a passkey"
on login) instead of the WhatsApp OTP each time. Same account either way —
a passkey added on the web dashboard or in the app is tied to the business's
`whatsapp_number`, not the device.

- **Android**: works today. `mobile/wab_app/android/upload-keystore.jks` is
  the real release signing keystore (generated 2026-07-24, git-ignored —
  make sure it's backed up outside this repo; losing it breaks future Play
  Store updates under this app identity). Its SHA-256 fingerprint is wired
  into `src/server.js`'s `/.well-known/assetlinks.json` handler and into
  production's `WEBAUTHN_ORIGINS`. If the keystore is ever rotated, both
  need updating together (see the comment above that handler).
- **iOS**: still blocked. Passkeys need the **Associated Domains**
  entitlement (already declared in `ios/Runner/Runner.entitlements` —
  `webcredentials:skes.tech`) plus a real Apple Developer Team ID in
  `src/server.js`'s `/.well-known/apple-app-site-association` handler, which
  needs the same Apple Developer Program membership ($99/yr) as iOS push
  (see below). Until then the passkey button is hidden on the login screen
  and shown disabled ("coming soon") in Settings — `PasskeyAuthenticator`
  would otherwise throw `DomainNotAssociatedException`.
- **Testing on the iOS Simulator**: passkeys need Face ID "enrolled" first —
  Simulator menu → Features → Face ID → Enrolled — even once the Apple
  Developer side is sorted out.

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
