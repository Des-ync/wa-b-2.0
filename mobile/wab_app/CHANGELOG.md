# Changelog

All notable changes to the WA-B mobile app are recorded here. Bump the build
number in `pubspec.yaml` (`version: X.Y.Z+N`) on every release build submitted
to the App Store or Play Store — both reject a re-upload with an
unincremented build number. Bump the semantic version (`X.Y.Z`) for
user-visible feature changes; patch-level bumps are fine for bug fixes only.

## Unreleased

- Android release keystore + passkey support wired up (WebAuthn, biometric
  gate for payouts).
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
