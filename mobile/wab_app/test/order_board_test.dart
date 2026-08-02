import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/order_board.dart';
import 'package:wab_app/state/session.dart';

/// The order board on mobile.
///
/// Same constraint as the web: changing an order's status WhatsApps the
/// customer, and a WhatsApp message cannot be unsent. So what these check is
/// not that the card moves — it is that **nothing reaches the server** until
/// the undo window closes.

final requests = <({String method, String path, Map<String, dynamic> body})>[];

ApiClient _client({List<Map<String, dynamic>>? orders, int failStatus = 0}) {
  requests.clear();
  return ApiClient(httpClient: MockClient((req) async {
    requests.add((
      method: req.method,
      path: req.url.path,
      body: req.body.isEmpty ? {} : jsonDecode(req.body) as Map<String, dynamic>
    ));
    if (req.url.path == '/api/orders') {
      return http.Response(
          jsonEncode({
            'success': true,
            'orders': orders ??
                [
                  {'id': 'o1', 'order_number': 'A1', 'status': 'pending',
                   'total_ghs': 25, 'items': [1], 'payment_status': 'paid'},
                  {'id': 'o2', 'order_number': 'A2', 'status': 'preparing',
                   'total_ghs': 40, 'items': [1, 2], 'payment_status': 'pending'},
                  // Outside the flow: must still be visible somewhere.
                  {'id': 'o3', 'order_number': 'A3', 'status': 'cancelled',
                   'total_ghs': 10, 'items': [], 'payment_status': 'pending'},
                ]
          }),
          200,
          headers: {'content-type': 'application/json'});
    }
    if (failStatus != 0) {
      return http.Response(
          jsonEncode({'success': false, 'error': 'Could not update'}),
          failStatus,
          headers: {'content-type': 'application/json'});
    }
    return http.Response(jsonEncode({'success': true}), 200,
        headers: {'content-type': 'application/json'});
  }));
}

Widget _app(ApiClient api) {
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: OrderBoardScreen()),
  );
}

int statusRequests() =>
    requests.where((r) => r.path.contains('/status')).length;

/// Widens the viewport so every column is laid out.
///
/// The board scrolls horizontally, and at the default 800px only the first
/// three or four columns are built. That matters beyond "the test cannot see
/// them": a `findsNothing` assertion about a column that was never rendered
/// passes for entirely the wrong reason.
/// How many cards matching [card] sit inside the column headed [column].
int countIn(String column, String card) {
  final col = find.ancestor(
      of: find.text(column), matching: find.byType(Container)).first;
  return find.descendant(of: col, matching: find.text(card)).evaluate().length;
}

void useWideScreen(WidgetTester tester) {
  tester.view.physicalSize = const Size(1600, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('shows the flow columns, and cancelled is not one of them',
      (tester) async {
    useWideScreen(tester);
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    for (final label in ['New', 'Confirmed', 'Preparing', 'Ready', 'Delivered']) {
      expect(find.text(label), findsOneWidget);
    }
    // Terminal, and the worst message to send by accident.
    expect(find.text('Cancelled'), findsNothing);
  });

  testWidgets('an order outside the flow is still shown, under Other',
      (tester) async {
    // Hiding an order because its status is unfamiliar is silent loss.
    useWideScreen(tester);
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.text('Other'), findsOneWidget);
    expect(find.text('#A3'), findsOneWidget);
  });

  testWidgets('an Other card offers no move, because there is no way back in',
      (tester) async {
    useWideScreen(tester);
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Move order A1'), findsOneWidget);
    expect(find.byTooltip('Move order A3'), findsNothing);
  });

  testWidgets('moving a card sends NOTHING until the window closes',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Move order A1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move to Ready'));
    await tester.pump();

    // The card has moved on screen…
    expect(find.text('#A1 → Ready'), findsOneWidget);
    // …but the customer has not been messaged.
    expect(statusRequests(), 0);

    await tester.pump(orderUndoWindow + const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(statusRequests(), 1);
    expect(requests.last.body['status'], 'ready');
  });

  testWidgets('undo cancels it entirely — nothing is ever sent',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Move order A1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move to Ready'));
    // Two pumps: the first starts the SnackBar's entrance animation, the
    // second runs it to completion. A single pump(400) only schedules it, and
    // the Undo button is still off the bottom of the screen — the tap lands on
    // nothing and the test passes for the wrong reason. pumpAndSettle is not
    // an option here: it would advance past the undo window and commit.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    await tester.tap(find.text('Undo'));
    await tester.pump();
    await tester.pump(orderUndoWindow + const Duration(seconds: 1));
    await tester.pumpAndSettle();

    // No apologetic second message, because there was no first one.
    expect(statusRequests(), 0);
  });

  testWidgets('moving twice sends one request, for where it ended up',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Move order A1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move to Confirmed'));
    await tester.pump();

    await tester.tap(find.byTooltip('Move order A1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move to Delivered'));
    await tester.pump();

    await tester.pump(orderUndoWindow + const Duration(seconds: 1));
    await tester.pumpAndSettle();

    // One message about the destination, not one per column crossed.
    expect(statusRequests(), 1);
    expect(requests.last.body['status'], 'delivered');
  });

  testWidgets('a failed request puts the card back', (tester) async {
    useWideScreen(tester);
    await tester.pumpWidget(_app(_client(failStatus: 500)));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Move order A1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move to Ready'));
    await tester.pump();
    // The card is optimistically in Ready…
    expect(countIn('Ready', '#A1'), 1);

    await tester.pump(orderUndoWindow + const Duration(seconds: 1));
    // Safe here, unlike the undo tests: the move has already committed, so
    // there is no window left to blow through.
    await tester.pumpAndSettle();

    // …and back in New once the server refuses, rather than the board showing
    // a status that was never accepted. Asserted on the card, not the error
    // toast — pumpAndSettle waits out a SnackBar's display duration, so
    // asserting the message is a race the board's behaviour is not.
    expect(countIn('Ready', '#A1'), 0);
    expect(countIn('New', '#A1'), 1);
  });

  testWidgets('the merchant is told what a move does, before doing one',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.textContaining('messaged on WhatsApp'), findsOneWidget);
    expect(find.textContaining('few seconds to undo'), findsOneWidget);
    expect(find.textContaining('To cancel an order, open it'), findsOneWidget);
  });
}
