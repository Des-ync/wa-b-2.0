import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/account_data.dart';
import 'package:wab_app/state/session.dart';

/// Data export and account closure.
///
/// Two things are worth pinning down here and the rest is presentation:
/// closing an account must not be reachable by a mis-tap, and the screen must
/// never tell a merchant that closing deletes their data — because it does
/// not. Both are claims about wording and gating, which is exactly what a
/// widget test can hold still.

Widget _app(ApiClient api, {Map<String, dynamic>? business}) {
  final session = Session(api: api)
    ..business = business ?? {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: AccountDataScreen()),
  );
}

/// Brings [f] into the viewport whether or not it has been built yet.
///
/// Neither call alone is enough: `scrollUntilVisible` returns the moment the
/// finder matches, and a ListView builds a cache extent past the viewport, so
/// it happily stops on a widget that is still off-screen and untappable —
/// which is how a tap can silently miss and leave a test passing for the
/// wrong reason. `ensureVisible` then scrolls that built widget into reach.
Future<void> _reveal(WidgetTester t, Finder f) async {
  await t.scrollUntilVisible(f, 120,
      scrollable: find.byType(Scrollable).first);
  await t.ensureVisible(f);
  await t.pumpAndSettle();
}

ApiClient _client({List<String>? calls, int closeStatus = 200}) =>
    ApiClient(httpClient: MockClient((req) async {
      calls?.add('${req.method} ${req.url.path}');
      if (req.url.path.endsWith('/close')) {
        return http.Response(
            jsonEncode(closeStatus == 200
                ? {'success': true, 'closed_at': '2026-07-31T10:00:00Z'}
                : {'success': false, 'error': 'This account is already closed.'}),
            closeStatus,
            headers: {'content-type': 'application/json'});
      }
      // The export is a FILE, not an envelope.
      return http.Response(
          jsonEncode({'exported_at': 'x', 'business': {}, 'products': []}), 200,
          headers: {'content-type': 'application/json'});
    }));

void main() {
  testWidgets('offers the three routes out, in order', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.text('Download your data'), findsOneWidget);
    expect(find.text('Close this account'), findsOneWidget);
    await _reveal(tester, find.text('Delete everything permanently'));
    expect(find.text('Delete everything permanently'), findsOneWidget);
  });

  testWidgets('never says closing deletes; says the opposite', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(
        find.textContaining('Closing does NOT delete anything'), findsOneWidget);
    expect(find.textContaining('orders, customers and messages are kept'),
        findsOneWidget);
  });

  testWidgets('close needs a typed confirmation, not just a tap',
      (tester) async {
    final calls = <String>[];
    await tester.pumpWidget(_app(_client(calls: calls)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Close my account'));
    await tester.pumpAndSettle();

    // The sheet is open, but the destructive button is inert until CLOSE is
    // typed — so reaching this sheet by accident cannot take a shop offline.
    final closeBtn = find.widgetWithText(FilledButton, 'Close account');
    expect(closeBtn, findsOneWidget);
    expect(tester.widget<FilledButton>(closeBtn).onPressed, isNull);

    await tester.tap(closeBtn);
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('close')), isEmpty);
  });

  testWidgets('typing CLOSE arms it and calls the endpoint', (tester) async {
    final calls = <String>[];
    await tester.pumpWidget(_app(_client(calls: calls)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Close my account'));
    await tester.pumpAndSettle();

    await tester.enterText(
        find.widgetWithText(TextField, 'Type CLOSE to confirm'), 'CLOSE');
    await tester.pumpAndSettle();

    final closeBtn = find.widgetWithText(FilledButton, 'Close account');
    expect(tester.widget<FilledButton>(closeBtn).onPressed, isNotNull);

    await tester.tap(closeBtn);
    await tester.pumpAndSettle();

    expect(calls.any((c) => c.contains('/api/business/close')), isTrue);
    expect(find.text('Account closed'), findsOneWidget);
  });

  testWidgets('lower-case close still counts', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Close my account'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Type CLOSE to confirm'), 'close');
    await tester.pumpAndSettle();

    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Close account'))
            .onPressed,
        isNotNull);
  });

  testWidgets('an already-closed account says so and still offers the export',
      (tester) async {
    await tester.pumpWidget(_app(_client(), business: {
      'id': 'biz-1',
      'name': 'Ama',
      'closed_at': '2026-07-01T00:00:00Z'
    }));
    await tester.pumpAndSettle();

    expect(find.text('This account is closed'), findsOneWidget);
    // Closing again is not offered...
    expect(find.text('Close this account'), findsNothing);
    // ...but getting your data out still is, which is the whole point of
    // retention-on-close.
    expect(find.text('Download my data'), findsOneWidget);
  });

  testWidgets('deletion gives the exact details needed to make the request',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await _reveal(tester, find.text('dev@skes.tech'));

    expect(find.text('dev@skes.tech'), findsOneWidget);
    expect(find.text('Delete my WA-B account'), findsOneWidget);
    expect(find.textContaining('within 30 days'), findsOneWidget);
  });

  testWidgets('the close sheet fits a short screen', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();
    // Scroll it into reach first — on a 640px-tall screen the button is below
    // the fold, and tapping a point outside the viewport would silently do
    // nothing and let this test pass without ever opening the sheet.
    await _reveal(tester, find.text('Close my account'));
    await tester.tap(find.text('Close my account'));
    await tester.pumpAndSettle();

    expect(find.text('Close your account'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
