import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/product_options.dart';
import 'package:wab_app/state/session.dart';

/// Variants and add-ons.
///
/// The behaviour worth pinning is the two places the data model makes a
/// distinction the UI could easily flatten: a variant's price is a signed
/// DELTA against the product (an add-on's is an absolute price), and a
/// variant's `stock_qty` of null means "not tracked", which is not the same
/// as 0 meaning "sold out". Getting either wrong either hides something that
/// is for sale or keeps selling something that has run out.

const _variants = [
  {'id': 'v1', 'name': 'Large', 'price_delta_ghs': 5, 'stock_qty': null, 'sort_order': 0},
  {'id': 'v2', 'name': 'Small', 'price_delta_ghs': -2, 'stock_qty': 0, 'sort_order': 1},
  {'id': 'v3', 'name': 'Regular', 'price_delta_ghs': 0, 'stock_qty': 7, 'sort_order': 2},
];
const _addons = [
  {'id': 'a1', 'name': 'Extra chicken', 'price_ghs': 8, 'sort_order': 0},
];

final requests = <({String method, String path, Map<String, dynamic> body})>[];

ApiClient _client() {
  requests.clear();
  return ApiClient(httpClient: MockClient((req) async {
    Map<String, dynamic> body = {};
    if (req.body.isNotEmpty) {
      body = jsonDecode(req.body) as Map<String, dynamic>;
    }
    requests.add((method: req.method, path: req.url.path, body: body));

    if (req.url.path.endsWith('/variants') && req.method == 'GET') {
      return http.Response(jsonEncode({'success': true, 'variants': _variants}),
          200, headers: {'content-type': 'application/json'});
    }
    if (req.url.path.endsWith('/addons') && req.method == 'GET') {
      return http.Response(jsonEncode({'success': true, 'addons': _addons}), 200,
          headers: {'content-type': 'application/json'});
    }
    return http.Response(jsonEncode({'success': true}), 200,
        headers: {'content-type': 'application/json'});
  }));
}

Widget _app({dynamic basePrice = 20}) {
  final session = Session(api: _client())
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: MaterialApp(
      home: ProductOptionsScreen(
          productId: 'p1', productName: 'Jollof', basePrice: basePrice),
    ),
  );
}

void main() {
  group('price labels', () {
    test('a variant delta is shown with the resulting price', () {
      expect(variantPriceLabel(5, 20), '+GH₵5.00 · GH₵25.00');
      expect(variantPriceLabel(-2, 20), '−GH₵2.00 · GH₵18.00');
      expect(variantPriceLabel(0, 20), 'same price · GH₵20.00');
    });

    test('falls back to the delta alone when the base price is unknown', () {
      expect(variantPriceLabel(5, null), '+GH₵5.00');
    });

    test('parses a numeric string, as NUMERIC columns can arrive', () {
      expect(variantPriceLabel('5.00', '20.00'), '+GH₵5.00 · GH₵25.00');
    });
  });

  group('stock labels', () {
    test('null is untracked, 0 is sold out — never the same thing', () {
      expect(variantStockLabel(null), 'Stock not tracked');
      expect(variantStockLabel(0), 'Sold out');
      expect(variantStockLabel(7), '7 left');
    });
  });

  testWidgets('lists both sections with their real meanings', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    expect(find.text('Large'), findsOneWidget);
    expect(find.textContaining('+GH₵5.00 · GH₵25.00'), findsOneWidget);
    expect(find.textContaining('Stock not tracked'), findsOneWidget);
    // The negative delta reads as a discount, and its variant is sold out.
    expect(find.textContaining('−GH₵2.00 · GH₵18.00'), findsOneWidget);
    expect(find.textContaining('Sold out'), findsOneWidget);
    expect(find.text('Extra chicken'), findsOneWidget);
  });

  testWidgets('editing a variant PATCHes rather than recreating it',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(InkWell, 'Large').first);
    await tester.pumpAndSettle();
    expect(find.text('Edit variant'), findsOneWidget);

    await tester.enterText(
        find.widgetWithText(TextField, 'Name'), 'Extra large');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    final patch = requests.lastWhere((r) => r.method == 'PATCH');
    expect(patch.path, '/api/products/variants/v1');
    expect(patch.body['name'], 'Extra large');
    // No DELETE-then-POST: the option keeps its identity and sort order.
    expect(requests.any((r) => r.method == 'DELETE'), isFalse);
  });

  testWidgets('turning stock tracking off sends an explicit null',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    // "Regular" tracks 7 in stock.
    await tester.tap(find.widgetWithText(InkWell, 'Regular').first);
    await tester.pumpAndSettle();
    expect(find.text('7'), findsOneWidget);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    final patch = requests.lastWhere((r) => r.method == 'PATCH');
    // Omitting the field would leave 7 in place and the variant would still
    // look tracked — so the null has to be sent, not skipped.
    expect(patch.body.containsKey('stock_qty'), isTrue);
    expect(patch.body['stock_qty'], isNull);
  });

  testWidgets('a negative add-on price is refused before the round trip',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(InkWell, 'Extra chicken').first);
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Price (GH₵)'), '-3');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('An add-on price cannot be negative'), findsOneWidget);
    expect(requests.any((r) => r.method == 'PATCH'), isFalse);
  });

  testWidgets('removing asks first and says history is safe', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Remove Large'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Orders that already included it are not affected'),
        findsOneWidget);

    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();

    expect(requests.any((r) =>
        r.method == 'DELETE' && r.path == '/api/products/variants/v1'), isTrue);
  });

  testWidgets('cancelling a removal deletes nothing', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Remove Large'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(requests.any((r) => r.method == 'DELETE'), isFalse);
  });

  testWidgets('a new variant defaults to untracked stock', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Add variant'));
    await tester.pumpAndSettle();

    expect(find.text('New variant'), findsOneWidget);
    // Most shops do not count stock per size, so the switch starts off and
    // no quantity field is shown.
    expect(find.widgetWithText(TextField, 'How many left'), findsNothing);

    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Medium');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    final post = requests.lastWhere((r) => r.method == 'POST');
    expect(post.path, '/api/products/p1/variants');
    expect(post.body['stock_qty'], isNull);
    expect(post.body['price_delta_ghs'], 0);
  });

  testWidgets('a nameless variant is refused before the round trip',
      (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Add variant'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Give the variant a name'), findsOneWidget);
    expect(requests.any((r) => r.method == 'POST'), isFalse);
  });

  testWidgets('the variant sheet fits a short screen', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add variant'));
    await tester.pumpAndSettle();

    expect(find.text('New variant'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
