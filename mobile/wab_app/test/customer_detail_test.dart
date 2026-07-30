import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:wab_app/api/client.dart';
import 'package:wab_app/screens/customer_detail.dart';
import 'package:wab_app/state/session.dart';

/// The customer profile screen, driven by the EXACT payload the backend
/// sends — including the shapes that are easy to assume wrong.
///
/// `last_products_ordered` elements are `{ name, ordered_at }` objects rather
/// than bare strings, and the profile's derived metrics arrive flat (the
/// legacy envelope spreads `meta` at the top level). Both were assumed
/// incorrectly while writing this screen; these tests pin them.

/// Mirrors GET /api/customers/:id/profile in the LEGACY envelope, which is
/// what every deployed client receives.
const _profileBody = {
  'success': true,
  'customer': {
    'id': 'cust-1',
    'display_name': 'Kojo',
    'tags': ['vip', 'wholesale'],
    'address_note': 'Blue gate opposite the mosque',
  },
  'last_products_ordered': [
    {'name': 'Jollof Rice', 'ordered_at': '2026-07-01T10:00:00Z'},
    {'name': 'Waakye', 'ordered_at': '2026-06-20T10:00:00Z'},
  ],
  'recent_orders': [
    {
      'id': 'ord-1', 'order_number': 'ORD-77',
      'total_ghs': '45.00', 'payment_status': 'paid',
      'created_at': '2026-07-01T10:00:00Z'
    }
  ],
  'conversation_history': [],
  // meta, spread flat by the legacy envelope
  'lifetime_spend_ghs': 450,
  'total_orders': 12,
  'order_frequency_per_month': 2.5,
  'preferred_payment_method': 'momo',
};

const _loyaltyBody = {
  'success': true,
  'loyalty': {
    'points': 120, 'points_value_ghs': 12, 'stamps': 3, 'stamps_target': 5,
    'vip_tier': 'Gold', 'referral_code': 'KOJO123', 'date_of_birth': null,
    'rewards': []
  }
};

Widget _app(ApiClient api) {
  final session = Session(api: api);
  return ChangeNotifierProvider<Session>.value(
    value: session,
    child: const MaterialApp(
      home: CustomerDetailScreen(customerId: 'cust-1', customerName: 'Kojo'),
    ),
  );
}

ApiClient _clientFor({Map<String, dynamic>? loyalty, int loyaltyStatus = 200}) {
  return ApiClient(httpClient: MockClient((req) async {
    if (req.url.path.endsWith('/loyalty')) {
      return http.Response(jsonEncode(loyalty ?? _loyaltyBody), loyaltyStatus,
          headers: {'content-type': 'application/json'});
    }
    return http.Response(jsonEncode(_profileBody), 200,
        headers: {'content-type': 'application/json'});
  }));
}

void main() {
  testWidgets('shows what the customer is worth', (tester) async {
    await tester.pumpWidget(_app(_clientFor()));
    await tester.pumpAndSettle();

    // The question the screen exists to answer.
    expect(find.textContaining('450'), findsWidgets);
    expect(find.text('12'), findsWidgets, reason: 'total orders');
    expect(find.text('2.5'), findsOneWidget, reason: 'orders per month');
    expect(find.text('momo'), findsOneWidget);
  });

  testWidgets('renders product names, not raw maps', (tester) async {
    await tester.pumpWidget(_app(_clientFor()));
    await tester.pumpAndSettle();

    // The bug this pins: elements are { name, ordered_at }, so '$p' would
    // render "{name: Jollof Rice, ordered_at: ...}" on screen.
    expect(find.text('Jollof Rice'), findsOneWidget);
    expect(find.text('Waakye'), findsOneWidget);
    expect(find.textContaining('ordered_at'), findsNothing);
  });

  testWidgets('shows tags and the rider directions', (tester) async {
    await tester.pumpWidget(_app(_clientFor()));
    await tester.pumpAndSettle();

    expect(find.text('vip'), findsOneWidget);
    expect(find.text('wholesale'), findsOneWidget);
    expect(find.text('Blue gate opposite the mosque'), findsOneWidget);
  });

  testWidgets('shows loyalty when the shop runs a programme', (tester) async {
    await tester.pumpWidget(_app(_clientFor()));
    await tester.pumpAndSettle();

    expect(find.text('120'), findsOneWidget, reason: 'points');
    expect(find.text('3/5'), findsOneWidget, reason: 'stamp progress');
    expect(find.text('Gold'), findsOneWidget);
  });

  testWidgets('a failing loyalty call still renders the profile',
      (tester) async {
    // A shop with the programme switched off must still see who its best
    // customers are — loyalty is additive, not load-bearing.
    await tester.pumpWidget(_app(_clientFor(loyalty: {'success': false, 'error': 'nope'}, loyaltyStatus: 500)));
    await tester.pumpAndSettle();

    expect(find.textContaining('450'), findsWidgets);
    expect(find.text('Gold'), findsNothing);
  });

  testWidgets('lists recent orders with a humanized payment status',
      (tester) async {
    await tester.pumpWidget(_app(_clientFor()));
    await tester.pumpAndSettle();

    // The list is lazy, so the order card sits below the test viewport until
    // scrolled into range.
    await tester.scrollUntilVisible(find.text('ORD-77'), 300);
    await tester.pumpAndSettle();

    expect(find.text('ORD-77'), findsOneWidget);
    // Not the raw 'paid'.
    expect(find.text('Payment received'), findsOneWidget);
  });
}
