import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/shell.dart';
import 'package:wab_app/state/session.dart';

/// MainShell's tab behaviour.
///
/// Bottom-nav tabs live in an IndexedStack so switching tabs doesn't lose
/// scroll position or in-progress edits — but that must not mean every tab
/// is BUILT (and its initState load fired) the instant the shell mounts.
/// Logging in should cost one tab's worth of requests (Home), not five.

final _calls = <Uri>[];

http.Response _ok(Map<String, dynamic> body) => http.Response(
    jsonEncode({'success': true, ...body}), 200,
    headers: {'content-type': 'application/json'});

Widget _app() {
  _calls.clear();
  final api = ApiClient(httpClient: MockClient((req) async {
    _calls.add(req.url);
    final path = req.url.path;
    final limit = req.url.queryParameters['limit'];
    if (path == '/api/orders/stats/today') {
      return _ok({'stats': {}});
    }
    if (path == '/api/orders' && limit == '10') {
      return _ok({'orders': []}); // Home's "recent orders" tile
    }
    if (path == '/api/orders') {
      return _ok({'orders': []}); // Orders tab, full list
    }
    if (path == '/api/notifications') {
      return _ok({'unread_count': 0});
    }
    if (path == '/api/onboarding/status') {
      return _ok({});
    }
    if (path == '/api/conversations') {
      return _ok({'conversations': []});
    }
    if (path == '/api/products') {
      return _ok({'products': []});
    }
    return _ok({});
  }));
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: MainShell()),
  );
}

void main() {
  testWidgets('opening the shell loads only the Home tab', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    expect(_calls, isNotEmpty);
    expect(_calls.any((u) => u.path == '/api/products'), isFalse,
        reason: 'Products tab must not load before it is opened');
    expect(_calls.any((u) => u.path == '/api/conversations'), isFalse,
        reason: 'Inbox tab must not load before it is opened');
    expect(
        _calls.any((u) =>
            u.path == '/api/orders' && u.queryParameters['limit'] == '100'),
        isFalse,
        reason: 'Orders tab must not load before it is opened');
  });

  testWidgets('switching to a tab loads it, once', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Products'));
    await tester.pumpAndSettle();
    expect(_calls.where((u) => u.path == '/api/products').length, 1);

    // Away and back: IndexedStack keeps the tab alive, so it must not
    // re-fetch just because it's visible again.
    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Products'));
    await tester.pumpAndSettle();
    expect(_calls.where((u) => u.path == '/api/products').length, 1);

    // Still no Inbox load — only Home and Products have been opened.
    expect(_calls.any((u) => u.path == '/api/conversations'), isFalse);
  });
}
