import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/client.dart';

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
