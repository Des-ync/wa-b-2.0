import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/api/product_ops_api.dart';
import 'package:wab_app/screens/products.dart';
import 'package:wab_app/state/session.dart';

/// Bulk edit, duplicate and reorder on mobile.
///
/// The API shapes matter most: these three endpoints are shared with the web
/// dashboard, and getting a body wrong here fails at the server with a message
/// the merchant cannot act on. The screen tests cover the two modes that could
/// silently do the wrong thing — selecting and reordering.

final requests = <({String method, String path, Map<String, dynamic> body})>[];

ApiClient _client({Map<String, dynamic>? response}) {
  requests.clear();
  return ApiClient(httpClient: MockClient((req) async {
    requests.add((
      method: req.method,
      path: req.url.path,
      body: req.body.isEmpty ? {} : jsonDecode(req.body) as Map<String, dynamic>
    ));
    if (req.url.path == '/api/products') {
      return http.Response(
          jsonEncode({
            'success': true,
            'products': [
              {'id': 'p1', 'name': 'Shito', 'price_ghs': 25, 'in_stock': true},
              {'id': 'p2', 'name': 'Jollof', 'price_ghs': 40, 'in_stock': false},
            ]
          }),
          200,
          headers: {'content-type': 'application/json'});
    }
    return http.Response(
        jsonEncode(response ?? {'success': true, 'updated': 2, 'notified': 0}),
        200,
        headers: {'content-type': 'application/json'});
  }));
}

Widget _app(ApiClient api) {
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: ProductsScreen()),
  );
}

void main() {
  group('api shapes', () {
    test('bulk update sends ids and changes in one request', () async {
      final api = _client();
      await api.bulkUpdateProducts('biz-1',
          productIds: ['p1', 'p2'], changes: {'in_stock': false});

      final r = requests.last;
      expect(r.method, 'PATCH');
      expect(r.path, '/api/products/bulk');
      expect(r.body['product_ids'], ['p1', 'p2']);
      expect(r.body['changes'], {'in_stock': false});
      // One request for the whole selection — not one per product.
      expect(requests.length, 1);
    });

    test('duplicate posts to the product it copies', () async {
      final api = _client();
      await api.duplicateProduct('p1');
      expect(requests.last.method, 'POST');
      expect(requests.last.path, '/api/products/p1/duplicate');
    });

    test('reorder sends the ids in their new order', () async {
      final api = _client();
      await api.reorderProducts('biz-1', ['p2', 'p1']);
      expect(requests.last.path, '/api/products/reorder');
      // Order is the payload — reversing it here would silently save the
      // opposite of what the merchant dragged.
      expect(requests.last.body['order'], ['p2', 'p1']);
    });
  });

  group('products screen', () {
    testWidgets('no checkboxes until something is selected', (tester) async {
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      // The list stays uncluttered for the common case of just browsing.
      expect(find.byType(Checkbox), findsNothing);
      expect(find.textContaining('selected'), findsNothing);
    });

    testWidgets('long-press starts a selection and shows the bar',
        (tester) async {
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Shito'));
      await tester.pumpAndSettle();

      expect(find.text('1 selected'), findsOneWidget);
      expect(find.byType(Checkbox), findsNWidgets(2));
      expect(find.text('Out of stock'), findsOneWidget);
    });

    testWidgets('a bulk action sends one request for the selection',
        (tester) async {
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Shito'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Out of stock'));
      await tester.pumpAndSettle();

      final bulk = requests.where((r) => r.path == '/api/products/bulk');
      expect(bulk.length, 1);
      expect(bulk.first.body['product_ids'], ['p1']);
      expect(bulk.first.body['changes'], {'in_stock': false});
    });

    testWidgets('the back-in-stock count is surfaced, not swallowed',
        (tester) async {
      // Marking a batch in stock messages every customer who asked to be told.
      // A merchant should learn that here, not from the bill.
      await tester.pumpWidget(_app(
          _client(response: {'success': true, 'updated': 2, 'notified': 3})));
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Shito'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('In stock'));
      await tester.pumpAndSettle();

      expect(find.textContaining('3 customers told it is back in stock'),
          findsOneWidget);
    });

    testWidgets('the selection clears after a bulk action', (tester) async {
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Shito'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hide'));
      await tester.pumpAndSettle();

      expect(find.textContaining('selected'), findsNothing);
      expect(find.byType(Checkbox), findsNothing);
    });

    testWidgets('reorder mode hides search, because filtering would lie',
        (tester) async {
      // Dragging within a filtered list saves an order that does not match
      // what the merchant sees — the hidden rows keep their old positions.
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, 'Search products'), findsOneWidget);
      await tester.tap(find.byTooltip('Reorder products'));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, 'Search products'), findsNothing);
      expect(find.textContaining('Featured products still come first'),
          findsOneWidget);
    });

    testWidgets('reorder mode says WhatsApp ranks popularity first',
        (tester) async {
      // Otherwise "I moved it and the bot still shows it fourth" is a support
      // conversation.
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Reorder products'));
      await tester.pumpAndSettle();

      expect(find.textContaining('what sells most is shown before'),
          findsOneWidget);
    });

    testWidgets('entering reorder mode drops any selection', (tester) async {
      // Two different modes; leaving ticks behind would float the bulk bar
      // over a list the merchant is now dragging.
      await tester.pumpWidget(_app(_client()));
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Shito'));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);

      await tester.tap(find.byTooltip('Reorder products'));
      await tester.pumpAndSettle();
      expect(find.textContaining('selected'), findsNothing);
    });

    testWidgets('duplicate is reachable and says the copy is hidden',
        (tester) async {
      await tester.pumpWidget(_app(_client(response: {
        'success': true,
        'product': {'id': 'p3'},
        'variants_copied': 2,
        'addons_copied': 1,
        'hidden': true
      })));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('More for Shito'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Duplicate'));
      await tester.pumpAndSettle();

      expect(requests.any((r) => r.path == '/api/products/p1/duplicate'), isTrue);
      // "Why is my copy not in the shop" is otherwise a mystery.
      expect(find.textContaining('hidden until you publish it'), findsOneWidget);
      expect(find.textContaining('2 variants and 1 add-on'), findsOneWidget);
    });
  });
}
