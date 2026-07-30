import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/state/session.dart';

/// Auth and token handling — the app's highest-risk surface, and the reason
/// this suite exists first. A session bug either locks a merchant out of
/// their own shop or leaves a revoked key working.

/// Records every request the session makes so a test can assert on the whole
/// conversation, not just the final state.
class Recorder {
  final List<http.BaseRequest> requests = [];
  final List<String> bodies = [];

  MockClient client(Map<String, dynamic> Function(http.Request req) respond,
      {int status = 200}) {
    return MockClient((req) async {
      requests.add(req);
      bodies.add(req.body);
      final body = respond(req);
      final code = body.remove('__status') as int? ?? status;
      return http.Response(jsonEncode(body), code,
          headers: {'content-type': 'application/json'});
    });
  }

  http.Request get last => requests.last as http.Request;
}

Session sessionWith(MockClient client) =>
    Session(api: ApiClient(httpClient: client));

void setStoredSession({String? key, String? role}) {
  FlutterSecureStorage.setMockInitialValues({
    if (key != null) 'api_key': key,
    if (role != null) 'role': role,
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => setStoredSession());

  group('restore', () {
    test('with no stored credential leaves the session logged out', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));

      await session.restore();

      expect(session.loggedIn, isFalse);
      expect(session.restoring, isFalse);
      expect(rec.requests, isEmpty,
          reason: 'a logged-out app must not call the API on startup');
    });

    test('restores a merchant and refreshes the business profile', () async {
      setStoredSession(key: 'sk_live_abc', role: 'merchant');
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {
            'success': true,
            'business': {'id': 'biz-1', 'name': 'Auntie Ama'},
          }));

      await session.restore();

      expect(session.loggedIn, isTrue);
      expect(session.role, SessionRole.merchant);
      expect(session.businessId, 'biz-1');
      expect(session.api.apiKey, 'sk_live_abc');
      expect(rec.last.url.path, '/api/me');
      // The restored key must be presented on that very first call — not
      // attached later, once some other request has already gone out bare.
      expect(rec.last.headers['Authorization'], 'Bearer sk_live_abc');
    });

    test('a revoked key (401) signs the device out locally', () async {
      setStoredSession(key: 'sk_live_revoked', role: 'merchant');
      final rec = Recorder();
      final session = sessionWith(rec.client(
          (_) => {'success': false, 'error': 'Invalid key', '__status': 401}));

      await session.restore();

      expect(session.loggedIn, isFalse);
      expect(session.api.apiKey, isNull);
      // Local logout only: the key is already dead, so calling the remote
      // logout endpoint with it would just fail again.
      expect(rec.requests.map((r) => r.url.path), ['/api/me']);
      expect(await const FlutterSecureStorage().read(key: 'api_key'), isNull);
    });

    test('403 is treated the same as 401', () async {
      setStoredSession(key: 'sk_live_x', role: 'merchant');
      final session = sessionWith(Recorder().client(
          (_) => {'success': false, 'error': 'Forbidden', '__status': 403}));

      await session.restore();

      expect(session.loggedIn, isFalse);
    });

    test('being offline keeps the merchant signed in', () async {
      setStoredSession(key: 'sk_live_abc', role: 'merchant');
      final session = Session(
          api: ApiClient(
              httpClient: MockClient((_) async => throw const SocketLike())));

      await session.restore();

      // The credential is still good — the network is not. Signing the
      // merchant out here would lock them out of a shop they can still run
      // from cached data on a bad connection.
      expect(session.loggedIn, isTrue);
      expect(session.api.apiKey, 'sk_live_abc');
      expect(session.business, isNull);
    });

    test('an admin session restores without fetching a business', () async {
      setStoredSession(key: 'sk_admin_abc', role: 'admin');
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));

      await session.restore();

      expect(session.role, SessionRole.admin);
      expect(session.businessId, isNull);
      expect(rec.requests, isEmpty);
    });

    test('restoring always clears the restoring flag, even on failure',
        () async {
      setStoredSession(key: 'k', role: 'merchant');
      final session = sessionWith(
          Recorder().client((_) => throw StateError('boom')));

      await session.restore();

      // Guarded by a finally: if this ever regressed the splash screen would
      // hang forever on a bad response.
      expect(session.restoring, isFalse);
    });
  });

  group('verifyOtp', () {
    test('stores the returned key and business, and notifies listeners',
        () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {
            'success': true,
            'api_key': 'sk_live_new',
            'business': {'id': 'biz-9', 'name': 'Kofi Store'},
          }));
      var notified = 0;
      session.addListener(() => notified++);

      await session.verifyOtp('233241234567', '123456');

      expect(session.api.apiKey, 'sk_live_new');
      expect(session.businessId, 'biz-9');
      expect(session.role, SessionRole.merchant);
      expect(notified, 1);

      final sent = jsonDecode(rec.bodies.last) as Map<String, dynamic>;
      expect(sent['whatsapp_number'], '233241234567');
      expect(sent['code'], '123456');
      expect(rec.last.url.path, '/api/auth/mobile/verify');

      // Persisted, so the next cold start restores rather than re-prompting.
      expect(
          await const FlutterSecureStorage().read(key: 'api_key'), 'sk_live_new');
      expect(await const FlutterSecureStorage().read(key: 'role'), 'merchant');
    });

    test('a wrong code leaves the session untouched', () async {
      final session = sessionWith(Recorder().client((_) =>
          {'success': false, 'error': 'Invalid code', '__status': 400}));

      await expectLater(
          session.verifyOtp('233241234567', '000000'), throwsA(isA<ApiException>()));

      expect(session.loggedIn, isFalse);
      expect(session.api.apiKey, isNull);
      expect(await const FlutterSecureStorage().read(key: 'api_key'), isNull);
    });

    test('the OTP request carries only the phone number', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));

      await session.requestOtp('233241234567');

      expect(rec.last.url.path, '/api/auth/mobile/request');
      expect(jsonDecode(rec.bodies.last),
          {'whatsapp_number': '233241234567'});
    });
  });

  group('loginAdmin', () {
    test('validates the key with a live call before adopting it', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));

      await session.loginAdmin('  sk_admin_key  ');

      // Trimmed — merchants paste keys with stray whitespace.
      expect(session.api.apiKey, 'sk_admin_key');
      expect(session.role, SessionRole.admin);
      expect(rec.last.url.path, '/api/admin/stats');
      expect(rec.last.headers['Authorization'], 'Bearer sk_admin_key');
    });

    test('a rejected key never becomes the session credential', () async {
      final session = sessionWith(Recorder()
          .client((_) => {'success': false, 'error': 'nope', '__status': 401}));

      await expectLater(
          session.loginAdmin('sk_admin_bad'), throwsA(isA<ApiException>()));

      // The probe runs on a sibling client precisely so a bad key cannot
      // clobber a good session that is already established.
      expect(session.api.apiKey, isNull);
      expect(session.role, isNull);
    });
  });

  group('logout', () {
    test('clears credentials, storage and the offline cache', () async {
      setStoredSession(key: 'sk_live_abc', role: 'merchant');
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));
      await session.restore();

      await session.logout();

      expect(session.loggedIn, isFalse);
      expect(session.api.apiKey, isNull);
      expect(session.business, isNull);
      expect(await const FlutterSecureStorage().read(key: 'api_key'), isNull);
      expect(await const FlutterSecureStorage().read(key: 'role'), isNull);
      expect(rec.requests.map((r) => r.url.path),
          contains('/api/auth/mobile/logout'));
    });

    test('unregisters the push token before signing out', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((req) =>
          req.url.path == '/api/auth/mobile/verify'
              ? {'success': true, 'api_key': 'sk_live_new', 'business': {'id': 'b1'}}
              : {'success': true}));
      await session.verifyOtp('233241234567', '123456');
      session.fcmToken = 'fcm-token-1';

      await session.logout();

      final paths = rec.requests.map((r) => r.url.path).toList();
      expect(paths, contains('/api/devices/unregister'));
      // Order matters: the key is cleared locally at the end, so the
      // unregister call must go out while it is still valid.
      expect(paths.indexOf('/api/devices/unregister'),
          lessThan(paths.indexOf('/api/auth/mobile/logout')));
    });

    test('a failing server still signs the device out locally', () async {
      final session = sessionWith(Recorder()
          .client((_) => {'success': false, 'error': 'down', '__status': 500}));
      session.api.apiKey = 'sk_live_abc';

      await session.logout();

      expect(session.api.apiKey, isNull,
          reason: 'local sign-out must never depend on the server answering');
    });

    test('logout(remote: false) makes no network calls at all', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));
      session.api.apiKey = 'sk_live_abc';

      await session.logout(remote: false);

      expect(rec.requests, isEmpty);
      expect(session.api.apiKey, isNull);
    });
  });

  group('registerDevice', () {
    test('is a no-op while logged out', () async {
      final rec = Recorder();
      final session = sessionWith(rec.client((_) => {'success': true}));

      await session.registerDevice('fcm-1');

      expect(session.fcmToken, 'fcm-1',
          reason: 'the token is kept so it can be sent after login');
      expect(rec.requests, isEmpty);
    });

    test('never lets a push failure break the session', () async {
      // Login succeeds; the device-register call behind it does not.
      final session = sessionWith(Recorder().client((req) =>
          req.url.path == '/api/auth/mobile/verify'
              ? {'success': true, 'api_key': 'sk_live_new', 'business': {'id': 'b1'}}
              : {'success': false, 'error': 'push broker down', '__status': 500}));
      await session.verifyOtp('233241234567', '123456');

      await session.registerDevice('fcm-1');

      expect(session.loggedIn, isTrue);
      expect(session.api.apiKey, 'sk_live_new');
    });
  });
}

/// Stands in for a dropped connection. ApiClient maps any non-SocketException
/// throw to the same generic network ApiException, which is the path a
/// flaky 3G connection actually takes.
class SocketLike implements Exception {
  const SocketLike();
}
