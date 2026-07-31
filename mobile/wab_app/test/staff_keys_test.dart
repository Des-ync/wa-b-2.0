import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/staff_keys.dart';
import 'package:wab_app/state/session.dart';

/// Staff access, driven by the shape GET /api/keys actually returns.
///
/// The behaviour that matters most here is not a feature: the secret is
/// returned exactly once and stored hashed, so the reveal has to be
/// unmissable and un-dismissable. Everything else is recoverable; that is not.

const _keys = {
  'success': true,
  'keys': [
    {
      'id': 'k1', 'name': 'Ama — shop floor', 'scope': 'tenant', 'role': 'support',
      'expires_at': null, 'last_used_at': '2026-07-30T09:00:00Z',
      'last_used_ip': '41.66.1.2', 'revoked_at': null, 'created_at': '2026-07-01T09:00:00Z'
    },
    {
      'id': 'k2', 'name': 'Kofi — accounts', 'scope': 'tenant', 'role': 'accountant',
      'expires_at': null, 'last_used_at': null, 'last_used_ip': null,
      'revoked_at': null, 'created_at': '2026-07-02T09:00:00Z'
    },
    {
      'id': 'k3', 'name': 'Old laptop', 'scope': 'tenant', 'role': 'manager',
      'expires_at': null, 'last_used_at': '2026-05-01T09:00:00Z', 'last_used_ip': null,
      'revoked_at': '2026-06-01T09:00:00Z', 'created_at': '2026-04-01T09:00:00Z'
    },
  ]
};

Widget _app(ApiClient api) {
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: StaffKeysScreen()),
  );
}

ApiClient _client({Map<String, dynamic>? createResponse, List<String>? calls}) =>
    ApiClient(httpClient: MockClient((req) async {
      calls?.add('${req.method} ${req.url.path}');
      if (req.method == 'POST') {
        return http.Response(
            jsonEncode(createResponse ??
                {'success': true, 'key': {'id': 'k9', 'name': 'New', 'plaintext': 'sk_live_THESECRET'}}),
            201,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(_keys), 200,
          headers: {'content-type': 'application/json'});
    }));

void main() {
  testWidgets('separates active keys from revoked ones', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.text('Active'), findsOneWidget);
    expect(find.text('Ama — shop floor'), findsOneWidget);
    expect(find.text('Kofi — accounts'), findsOneWidget);

    // Revoked keys stay visible as a record of what access existed.
    expect(find.text('Revoked'), findsWidgets);
    expect(find.text('Old laptop'), findsOneWidget);
  });

  testWidgets('flags a key nobody has ever used', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    // The interesting case: an unused key can be revoked with no disruption.
    expect(find.text('Never used'), findsOneWidget);
    expect(find.textContaining('41.66.1.2'), findsOneWidget);
  });

  testWidgets('says what each role can do, not just its name', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    // "Support" means nothing on its own to someone handing out access.
    expect(find.textContaining('Cannot see money'), findsOneWidget);
    expect(find.textContaining('Read-only'), findsOneWidget);
  });

  testWidgets('a revoked key offers no rotate or revoke action', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    // Two active keys, so exactly two of each action — none for the revoked.
    expect(find.widgetWithText(OutlinedButton, 'Rotate'), findsNWidgets(2));
    expect(find.widgetWithText(OutlinedButton, 'Revoke'), findsNWidgets(2));
  });

  testWidgets('revoking asks first, and says it cannot be undone',
      (tester) async {
    final calls = <String>[];
    await tester.pumpWidget(_app(_client(calls: calls)));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(OutlinedButton, 'Revoke').first);
    await tester.pumpAndSettle();

    expect(find.textContaining('cannot be turned back on'), findsOneWidget);

    // Cancelling must not revoke.
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('revoke')), isEmpty);
  });

  testWidgets('the new secret is shown once and cannot be dismissed by accident',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Give access'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Ama');
    await tester.tap(find.text('Create key'));
    await tester.pumpAndSettle();

    expect(find.text('Copy this key now'), findsOneWidget);
    expect(find.text('sk_live_THESECRET'), findsOneWidget);
    // The wording has to be explicit: after this the value is unrecoverable.
    expect(find.textContaining('only time it will be shown'), findsOneWidget);

    // barrierDismissible: false — tapping outside must not close it, because
    // that would silently lose the secret.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(find.text('sk_live_THESECRET'), findsOneWidget);

    await tester.tap(find.text("I've saved it"));
    await tester.pumpAndSettle();
    expect(find.text('sk_live_THESECRET'), findsNothing);
  });

  testWidgets('creating without a name does not issue a key', (tester) async {
    final calls = <String>[];
    await tester.pumpWidget(_app(_client(calls: calls)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Give access'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create key'));
    await tester.pumpAndSettle();

    // An unnamed key is one nobody can later identify as theirs.
    expect(calls.where((c) => c == 'POST /api/keys'), isEmpty);
    expect(find.textContaining('name so you know whose it is'), findsOneWidget);
  });

  testWidgets('an empty list explains why you would add one', (tester) async {
    final api = ApiClient(httpClient: MockClient((_) async =>
        http.Response('{"success":true,"keys":[]}', 200,
            headers: {'content-type': 'application/json'})));

    await tester.pumpWidget(_app(api));
    await tester.pumpAndSettle();

    expect(find.text('Only you have access'), findsOneWidget);
    expect(find.textContaining('take it back later'), findsOneWidget);
  });
}
