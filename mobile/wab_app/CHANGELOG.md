# Changelog

All notable changes to the WA-B mobile app are recorded here. Bump the build
number in `pubspec.yaml` (`version: X.Y.Z+N`) on every release build submitted
to the App Store or Play Store — both reject a re-upload with an
unincremented build number. Bump the semantic version (`X.Y.Z`) for
user-visible feature changes; patch-level bumps are fine for bug fixes only.

## Unreleased

- Passkey sign-in and setup now go through Clerk's own hosted sign-in (a
  secure in-app browser tab), not a native `androidx.credentials`/iOS
  `ASAuthorizationController` WebAuthn ceremony — works on iOS and Android
  from day one, no Apple Developer account needed. Replaces an
  Android-release-keystore-dependent native implementation that never
  shipped. Local biometric gate for payouts is unrelated and unchanged.
- Security hardening pass: 60s clipboard auto-clear for issued API keys,
  https-only image URLs, offline cache moved to `flutter_secure_storage`.
- iOS `Info.plist` usage-description strings added for camera/microphone/
  speech recognition (previously missing — would have caused instant App
  Store rejection and a runtime crash on first permission request).
- Android `RECORD_AUDIO` permission added (required by the voice
  product-update feature; previously missing, so voice updates silently never
  worked on Android).

## 1.0.0+1

- Initial internal build.
