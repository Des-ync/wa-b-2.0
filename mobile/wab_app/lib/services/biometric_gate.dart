import 'package:local_auth/local_auth.dart';

/// Gates access to sensitive financial screens/actions behind the device's
/// biometric lock (Face ID / Touch ID / fingerprint), falling back to the
/// device passcode when biometrics aren't enrolled — local_auth's standard
/// behavior. This is a local, on-device check only: it proves "this is
/// whoever is holding the phone right now," not an identity check against
/// our backend, and it protects against someone picking up an unattended
/// phone, not against a compromised account.
class BiometricGate {
  static final _auth = LocalAuthentication();

  /// Prompts for Face ID / Touch ID / fingerprint (or device passcode as a
  /// fallback) with [reason] shown in the system prompt. Returns true only
  /// on a real, successful check.
  ///
  /// If the device has no passcode or biometric enrolled at all, this
  /// fails open (returns true): there's no OS-level lock screen protecting
  /// the phone in that case either, so refusing the merchant access to
  /// their own payout screen would add friction without adding security.
  static Future<bool> authenticate(String reason) async {
    try {
      if (!await _auth.isDeviceSupported()) return true;
      return await _auth.authenticate(
        localizedReason: reason,
        biometricOnly: false,
        persistAcrossBackgrounding: true,
      );
    } catch (_) {
      // Platform channel / plugin error — fail closed here, since unlike
      // "nothing enrolled" this means we couldn't tell either way.
      return false;
    }
  }
}
