import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/analytics.dart';
import 'package:wab_app/state/session.dart';

/// The Analytics screen's tab behaviour.
///
/// Two things here are about cost and correctness rather than appearance:
/// opening Analytics must not fetch all five views at once on a metered
/// connection, and the day-window control must never offer a window the
/// endpoint behind the current tab does not accept — the server silently
/// falls back to its default, so a "90d" button on the Customers tab would
/// label 30-day figures as 90.

final _calls = <Uri>[];

Widget _app() {
  _calls.clear();
  final api = ApiClient(httpClient: MockClient((req) async {
    _calls.add(req.url);
    return http.Response(
        jsonEncode({
          'success': true,
          'analytics': {'revenue_trend': [], 'top_products': [], 'busiest_hours': []},
          'profit': {'by_product': [], 'by_day': []},
          'cohorts': {
            'new_customers': {'customers': 0, 'orders': 0, 'revenue_ghs': 0},
            'returning_customers': {'customers': 0, 'orders': 0, 'revenue_ghs': 0},
          },
          'delivery_sla': {'completed_deliveries': 0},
          'channels': [],
        }),
        200,
        headers: {'content-type': 'application/json'});
  }));
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: AnalyticsScreen()),
  );
}

void main() {
  testWidgets('opening Analytics fetches only the overview', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    expect(_calls.length, 1);
    expect(_calls.single.path, '/api/analytics');
  });

  testWidgets('a tab fetches when opened, and not again on return',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Profit'));
    await tester.pumpAndSettle();
    expect(_calls.map((u) => u.path), contains('/api/analytics/profit'));
    final afterFirstOpen = _calls.length;

    // Away and back: the tab keeps its result rather than re-downloading.
    await tester.tap(find.text('Channels'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Profit'));
    await tester.pumpAndSettle();

    expect(_calls.where((u) => u.path == '/api/analytics/profit').length, 1);
    expect(_calls.length, afterFirstOpen + 1); // only channels was added
  });

  testWidgets('90d is offered on Profit but not on Customers', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    // Overview: 7 and 30 only.
    expect(find.text('90d'), findsNothing);

    await tester.tap(find.text('Profit'));
    await tester.pumpAndSettle();
    expect(find.text('90d'), findsOneWidget);

    await tester.tap(find.text('Customers'));
    await tester.pumpAndSettle();
    expect(find.text('90d'), findsNothing);
  });

  testWidgets('90d selected on Profit clamps to 30d on Customers',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Profit'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('90d'));
    await tester.pumpAndSettle();

    expect(_calls.last.queryParameters['days'], '90');

    await tester.tap(find.text('Customers'));
    await tester.pumpAndSettle();

    // The cohorts request must NOT carry days=90 — the server would answer
    // with 30-day data and the UI would be labelling it 90.
    final cohort =
        _calls.lastWhere((u) => u.path == '/api/analytics/cohorts');
    expect(cohort.queryParameters['days'], '30');
  });
}
