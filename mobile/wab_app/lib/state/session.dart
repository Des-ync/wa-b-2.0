import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';

import '../api/client.dart';
import '../api/passkey_api.dart';

enum SessionRole { merchant, admin }

/// Holds the logged-in credential + business profile. Persisted in secure
/// storage (Keychain / Android Keystore), restored on app start.
class Session extends ChangeNotifier {
  final ApiClient api = ApiClient();
  static const _storage = FlutterSecureStorage();

  bool restoring = true;
  SessionRole? role;
  Map<String, dynamic>? business; // merchant only
  String? fcmToken; // set by the push service once available

  bool get loggedIn => role != null;
  String? get businessId => business?['id']?.toString();

  Future<void> restore() async {
    try {
      final key = await _storage.read(key: 'api_key');
      final roleStr = await _storage.read(key: 'role');
      if (key != null && roleStr != null) {
        api.apiKey = key;
        role = roleStr == 'admin' ? SessionRole.admin : SessionRole.merchant;
        if (role == SessionRole.merchant) {
          // Re-fetch the business so settings edits elsewhere are reflected.
          try {
            final me = await api.get('/api/me');
            business = (me['business'] ?? me['data']) as Map<String, dynamic>?;
          } catch (e) {
            if (e is ApiException && (e.status == 401 || e.status == 403)) {
              await logout(remote: false);
            } else {
              // Offline — keep the cached identity and carry on.
              business = null;
            }
          }
        }
      }
    } finally {
      restoring = false;
      notifyListeners();
    }
  }

  Future<void> requestOtp(String whatsappNumber) async {
    await api.post('/api/auth/mobile/request',
        body: {'whatsapp_number': whatsappNumber});
  }

  Future<void> verifyOtp(String whatsappNumber, String code) async {
    final deviceName = Platform.isIOS ? 'iPhone' : 'Android';
    final res = await api.post('/api/auth/mobile/verify', body: {
      'whatsapp_number': whatsappNumber,
      'code': code,
      'device_name': deviceName,
    });
    api.apiKey = res['api_key'] as String;
    business = res['business'] as Map<String, dynamic>?;
    role = SessionRole.merchant;
    await _storage.write(key: 'api_key', value: api.apiKey);
    await _storage.write(key: 'role', value: 'merchant');
    notifyListeners();
  }

  /// Skip WhatsApp OTP for a merchant already signed in with Clerk on the
  /// web: open Clerk's hosted sign-in in a secure in-app browser tab, get a
  /// session token back via a wabapp:// redirect, then exchange it for a
  /// device API key the same way [verifyOtp] does. Throws (ApiException, or
  /// a PlatformException if the user cancels the browser tab) on failure.
  Future<void> loginViaClerk() async {
    final deviceName = Platform.isIOS ? 'iPhone' : 'Android';
    final result = await FlutterWebAuth2.authenticate(
      // public/ is served under /wa-b, not the domain root (see server.js).
      url: '${ApiClient.baseUrl}/wa-b/mobile-clerk-bridge.html',
      callbackUrlScheme: 'wabapp',
    );
    final token = Uri.parse(result).queryParameters['token'];
    if (token == null || token.isEmpty) {
      throw ApiException(0, 'Clerk sign-in did not return a session token.');
    }
    final res = await api.post('/api/auth/mobile/clerk-exchange', body: {
      'clerk_session_token': token,
      'device_name': deviceName,
    });
    api.apiKey = res['api_key'] as String;
    business = res['business'] as Map<String, dynamic>?;
    role = SessionRole.merchant;
    await _storage.write(key: 'api_key', value: api.apiKey);
    await _storage.write(key: 'role', value: 'merchant');
    notifyListeners();
  }

  /// Add a passkey for this device to the already-logged-in business. Both
  /// the options the server generates and the response the platform
  /// returns are standard WebAuthn JSON, so they pass straight between
  /// `api/passkey_api.dart` and the `passkeys` package with no reshaping.
  Future<void> registerPasskey() async {
    final deviceName = Platform.isIOS ? 'iPhone' : 'Android';
    final optRes = await api.passkeyRegisterOptions();
    final options = optRes['options'] as Map<String, dynamic>;
    final challenge = options['challenge'] as String;
    final result = await PasskeyAuthenticator()
        .register(RegisterRequestType.fromJson(options));
    await api.passkeyRegisterVerify(
      challenge: challenge,
      response: result.toJson(),
      deviceName: deviceName,
    );
  }

  /// Passwordless login: no phone number needed — the OS shows whichever of
  /// the device's passkeys match our RP ID. Throws (ApiException, or a
  /// PasskeyAuthCancelledException if the user backs out of the OS sheet)
  /// on failure.
  Future<void> loginViaPasskey() async {
    final deviceName = Platform.isIOS ? 'iPhone' : 'Android';
    final optRes = await api.passkeyLoginOptions();
    final options = optRes['options'] as Map<String, dynamic>;
    final challenge = options['challenge'] as String;
    final result = await PasskeyAuthenticator()
        .authenticate(AuthenticateRequestType.fromJson(options));
    final res = await api.passkeyLoginVerify(
      challenge: challenge,
      response: result.toJson(),
      deviceName: deviceName,
    );
    api.apiKey = res['api_key'] as String;
    business = res['business'] as Map<String, dynamic>?;
    role = SessionRole.merchant;
    await _storage.write(key: 'api_key', value: api.apiKey);
    await _storage.write(key: 'role', value: 'merchant');
    notifyListeners();
  }

  /// Team login: paste an sk_admin key; validated with a live stats call.
  Future<void> loginAdmin(String adminKey) async {
    final probe = ApiClient()..apiKey = adminKey.trim();
    await probe.get('/api/admin/stats'); // throws if the key is bad
    api.apiKey = adminKey.trim();
    role = SessionRole.admin;
    business = null;
    await _storage.write(key: 'api_key', value: api.apiKey);
    await _storage.write(key: 'role', value: 'admin');
    notifyListeners();
  }

  Future<void> registerDevice(String token, {String? deviceName}) async {
    fcmToken = token;
    if (!loggedIn) return;
    try {
      await api.post('/api/devices/register', body: {
        'fcm_token': token,
        'platform': Platform.isIOS ? 'ios' : 'android',
        'device_name': deviceName ?? (Platform.isIOS ? 'iPhone' : 'Android'),
      });
    } catch (_) {
      // Push registration must never break the session.
    }
  }

  Future<void> logout({bool remote = true}) async {
    if (remote) {
      try {
        if (fcmToken != null) {
          await api
              .post('/api/devices/unregister', body: {'fcm_token': fcmToken});
        }
        await api.post('/api/auth/mobile/logout');
      } catch (_) {
        // Best effort — local sign-out always succeeds.
      }
    }
    api.apiKey = null;
    role = null;
    business = null;
    await _storage.delete(key: 'api_key');
    await _storage.delete(key: 'role');
    notifyListeners();
  }
}
