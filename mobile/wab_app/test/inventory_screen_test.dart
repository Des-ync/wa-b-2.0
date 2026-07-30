import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/inventory.dart';
import 'package:wab_app/state/session.dart';

/// The stock screen, driven by the EXACT rows the endpoints return.
///
/// Postgres NUMERIC columns arrive as STRINGS over JSON — margin_pct and
/// margin_ghs among them — which is the shape that has caught this codebase
/// out repeatedly. These fixtures use strings deliberately.

const _suggestions = {
  'success': true,
  'suggestions': [
    {
      'id': 'p1', 'name': 'Jollof Rice', 'category': 'mains',
      'stock_qty': 2, 'low_stock_threshold': 5, 'suggested_reorder_qty': 13,
      'supplier_id': 's1', 'supplier_name': 'Kofi Wholesale',
      'supplier_phone': '+233241110000'
    }
  ]
};

const _margins = {
  'success': true,
  'products': [
    // Healthy margin.
    {'id': 'p1', 'name': 'Jollof Rice', 'category': 'mains',
     'price_ghs': '40.00', 'cost_price_ghs': '25.00',
     'margin_ghs': '15.00', 'margin_pct': '37.5'},
    // Thin margin — worth flagging before a discount is offered on top.
    {'id': 'p2', 'name': 'Malt', 'category': 'drinks',
     'price_ghs': '8.00', 'cost_price_ghs': '7.40',
     'margin_ghs': '0.60', 'margin_pct': '7.5'},
    // No cost price set: excluded rather than shown as 100% margin.
    {'id': 'p3', 'name': 'Water', 'category': 'drinks',
     'price_ghs': '2.00', 'cost_price_ghs': null,
     'margin_ghs': null, 'margin_pct': null},
  ]
};

const _movements = {
  'success': true,
  'movements': [
    {'id': 'm1', 'type': 'restock', 'quantity_delta': 20, 'quantity_after': 22,
     'product_name': 'Jollof Rice', 'created_at': '2026-07-30T09:00:00Z', 'note': null},
    {'id': 'm2', 'type': 'sale', 'quantity_delta': -2, 'quantity_after': 20,
     'product_name': 'Jollof Rice', 'created_at': '2026-07-30T10:00:00Z', 'note': null},
    {'id': 'm3', 'type': 'adjustment', 'quantity_delta': -3, 'quantity_after': 17,
     'product_name': 'Malt', 'created_at': '2026-07-30T11:00:00Z', 'note': 'Stock take'},
  ]
};

Widget _app(ApiClient api) {
  final session = Session(api: api)
    ..business = {'id': 'biz-1', 'name': 'Ama'}
    ..role = SessionRole.merchant;
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(home: InventoryScreen()),
  );
}

ApiClient _client({Map<String, dynamic>? suppliers}) =>
    ApiClient(httpClient: MockClient((req) async {
      final p = req.url.path;
      final body = p.endsWith('reorder-suggestions')
          ? _suggestions
          : p.endsWith('margins')
              ? _margins
              : p.endsWith('movements')
                  ? _movements
                  : suppliers ?? {'success': true, 'suppliers': []};
      return http.Response(jsonEncode(body), 200,
          headers: {'content-type': 'application/json'});
    }));

void main() {
  testWidgets('running-low tab shows what to buy and from whom', (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    expect(find.text('Jollof Rice'), findsOneWidget);
    expect(find.text('2 left'), findsOneWidget);
    expect(find.text('Supplier: Kofi Wholesale'), findsOneWidget);
    // The action that was missing entirely: recording that it was restocked.
    expect(find.textContaining('Restock'), findsWidgets);
    expect(find.text('Count'), findsOneWidget);
  });

  testWidgets('margins render from STRING numerics and flag thin ones',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Margins'));
    await tester.pumpAndSettle();

    expect(find.text('GH₵15.00'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('8%'), findsOneWidget, reason: 'the thin one');
    // A product with no cost price is excluded rather than shown as pure
    // profit, which is what a null cost would otherwise imply.
    expect(find.text('Water'), findsNothing);
  });

  testWidgets('history distinguishes a sale, a restock and a stock take',
      (tester) async {
    await tester.pumpWidget(_app(_client()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();

    expect(find.text('+20'), findsOneWidget);
    expect(find.text('-2'), findsOneWidget);
    expect(find.textContaining('Restocked'), findsOneWidget);
    expect(find.textContaining('Sold'), findsOneWidget);
    // A correction is not a delivery; the ledger must say which.
    expect(find.textContaining('Adjusted'), findsOneWidget);
    expect(find.textContaining('Stock take'), findsOneWidget);
  });

  testWidgets('an empty low-stock list is good news, not an error',
      (tester) async {
    final api = ApiClient(httpClient: MockClient((req) async {
      final body = req.url.path.endsWith('reorder-suggestions')
          ? {'success': true, 'suggestions': []}
          : req.url.path.endsWith('margins')
              ? {'success': true, 'products': []}
              : {'success': true, 'movements': [], 'suppliers': []};
      return http.Response(jsonEncode(body), 200,
          headers: {'content-type': 'application/json'});
    }));

    await tester.pumpWidget(_app(api));
    await tester.pumpAndSettle();

    expect(find.text('Nothing running low'), findsOneWidget);
  });

  testWidgets('a failing suppliers call does not blank the page',
      (tester) async {
    // Suppliers only populate a picker inside the restock sheet.
    final api = ApiClient(httpClient: MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('suppliers')) return http.Response('{"success":false}', 500);
      final body = p.endsWith('reorder-suggestions')
          ? _suggestions
          : p.endsWith('margins') ? _margins : _movements;
      return http.Response(jsonEncode(body), 200,
          headers: {'content-type': 'application/json'});
    }));

    await tester.pumpWidget(_app(api));
    await tester.pumpAndSettle();

    expect(find.text('Jollof Rice'), findsOneWidget);
  });
}
