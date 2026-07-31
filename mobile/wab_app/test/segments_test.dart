import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/segments.dart';
import 'package:wab_app/state/session.dart';

import 'support/reveal.dart';

/// Customer segments.
///
/// The point of this screen is not the counts — it is that a count leads
/// somewhere. So the tests are mostly about the handoff: tapping a segment
/// must filter the customer list by that segment (the endpoint has always
/// supported it; nothing on mobile ever passed it), and messaging a segment
/// must open the composer already aimed at it rather than making the merchant
/// re-pick what they just tapped.

final _calls = <Uri>[];

ApiClient _client({List<Map<String, dynamic>>? tags, int inactiveCount = 23}) {
  _calls.clear();
  return ApiClient(httpClient: MockClient((req) async {
    _calls.add(req.url);
    if (req.url.path.endsWith('/segments/summary')) {
      return http.Response(
          jsonEncode({
            'success': true,
            'segments': [
              {'key': 'ordered_30d', 'label': 'Ordered in last 30 days', 'count': 12},
              {'key': 'inactive_60d', 'label': 'Inactive for 60+ days', 'count': inactiveCount},
              {'key': 'abandoned_cart', 'label': 'Has an abandoned cart', 'count': 0},
            ],
            'tags': tags ?? [
              {'tag': 'wholesale', 'n': 4},
              {'tag': 'kumasi', 'n': 2},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'});
    }
    return http.Response(jsonEncode({'success': true, 'customers': []}), 200,
        headers: {'content-type': 'application/json'});
  }));
}

Widget _app(ApiClient api) {
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: SegmentsScreen()),
  );
}

void main() {
  testWidgets('shows each segment with its count and what it is for',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.text('Ordered in last 30 days'), findsOneWidget);
    expect(find.text('12'), findsOneWidget);
    expect(find.text('23'), findsOneWidget);
    // A count alone does not tell a merchant what to do with it.
    expect(find.textContaining('A win-back message goes here'), findsOneWidget);
  });

  testWidgets('an empty segment offers no actions', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    // Two non-empty segments have buttons; the abandoned-cart one has 0 and
    // must not offer "see them" on an empty list or a broadcast to nobody.
    expect(find.text('See them'), findsNWidgets(2));
    expect(find.text('Message'), findsNWidgets(2));
  });

  testWidgets('seeing a segment filters the customer list by it',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    // The second "See them" belongs to the inactive segment.
    await tester.tap(find.text('See them').at(1));
    await tester.pumpAndSettle();

    final customers = _calls.lastWhere((u) => u.path == '/api/customers');
    expect(customers.queryParameters['segment'], 'inactive_60d');
    // And the screen says which audience it is showing.
    expect(find.text('Inactive for 60+ days'), findsWidgets);
  });

  testWidgets('messaging a segment opens the composer aimed at it',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Message').at(1));
    await tester.pumpAndSettle();

    // The composer's segment dropdown is pre-set — the merchant does not
    // re-pick the segment they just tapped.
    expect(find.text('Inactive for 60+ days'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a tag filters the customer list by tag', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await reveal(tester, find.textContaining('wholesale'));
    await tester.tap(find.textContaining('wholesale'));
    await tester.pumpAndSettle();

    final customers = _calls.lastWhere((u) => u.path == '/api/customers');
    expect(customers.queryParameters['tag'], 'wholesale');
    expect(customers.queryParameters.containsKey('segment'), isFalse);
  });

  testWidgets('no tags yet explains what tags are for', (tester) async {
    await tester.pumpWidget(_app(_client(tags: [])));
    await tester.pumpAndSettle();

    await reveal(tester, find.textContaining('No tags yet'));
    expect(find.textContaining('No tags yet'), findsOneWidget);
    expect(find.textContaining('wholesale'), findsOneWidget);
  });

  testWidgets('one request loads the whole screen', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(_calls.length, 1);
    expect(_calls.single.path, '/api/customers/segments/summary');
  });
}
