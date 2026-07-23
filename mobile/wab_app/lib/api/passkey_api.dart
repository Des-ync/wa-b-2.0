import 'client.dart';

/// Native passkey (WebAuthn) registration and login. Every call returns
/// `{ success, options: {...} }` or `{ success, api_key, business }` per
/// src/routes/auth.routes.js's /passkey/* endpoints.
extension PasskeyApi on ApiClient {
  Future<Map<String, dynamic>> passkeyRegisterOptions() {
    return post('/api/auth/passkey/register/options');
  }

  Future<Map<String, dynamic>> passkeyRegisterVerify({
    required String challenge,
    required Map<String, dynamic> response,
    required String deviceName,
  }) {
    return post('/api/auth/passkey/register/verify', body: {
      'challenge': challenge,
      'response': response,
      'device_name': deviceName,
    });
  }

  Future<Map<String, dynamic>> passkeyLoginOptions() {
    return post('/api/auth/passkey/login/options');
  }

  Future<Map<String, dynamic>> passkeyLoginVerify({
    required String challenge,
    required Map<String, dynamic> response,
    required String deviceName,
  }) {
    return post('/api/auth/passkey/login/verify', body: {
      'challenge': challenge,
      'response': response,
      'device_name': deviceName,
    });
  }
}
