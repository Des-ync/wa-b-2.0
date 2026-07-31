import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wab_app/api/analytics_api.dart';
import 'package:wab_app/screens/analytics_views.dart';

/// The four deeper analytics views, driven by the shapes analytics.routes.js
/// actually returns.
///
/// The interesting cases here are all about honesty rather than layout: a
/// margin that ignores products with no cost price, a 0% late rate that
/// really means "no ETA was ever set", and a repeat rate with too little
/// history to mean anything. Each of those reads as a fact about the business
/// when it is really a fact about the data, so each has a test.

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: child));

// Shapes copied from the route handlers, including the nulls they emit.
Map<String, dynamic> _profit({int? knownPct = 100}) => {
      'profit': {
        'days': 30,
        'by_product': [
          {
            'product_id': 'p1', 'name': 'Shito', 'units_sold': 10,
            'revenue_ghs': 200.0, 'cost_ghs': 120.0, 'margin_ghs': 80.0,
            'margin_pct': 40, 'cost_known': true
          },
          {
            'product_id': null, 'name': 'Bundle line', 'units_sold': 4,
            'revenue_ghs': 100.0, 'cost_ghs': null, 'margin_ghs': null,
            'margin_pct': null, 'cost_known': false
          },
        ],
        'by_day': [
          {'date': '2026-07-01', 'revenue_ghs': 300.0, 'cost_ghs': 120.0, 'margin_ghs': 80.0},
        ],
        'best_margin_product': null,
        'margin_known_pct': knownPct,
        'note': 'x'
      }
    };

void main() {
  group('profit', () {
    testWidgets('margin % is taken against revenue that HAS a cost price',
        (tester) async {
      await tester.pumpWidget(_wrap(profitView(_profit(knownPct: 67))));
      await tester.pumpAndSettle();

      // 80 profit on the 200 of revenue whose cost is known = 40%.
      // Against total revenue (300) it would be 27% — which would make the
      // shop look worse purely because one product lacks a cost price.
      expect(find.text('40%'), findsOneWidget);
      expect(find.text('27%'), findsNothing);
    });

    testWidgets('says how much of revenue the profit figure covers',
        (tester) async {
      await tester.pumpWidget(_wrap(profitView(_profit(knownPct: 67))));
      await tester.pumpAndSettle();

      expect(find.textContaining('covers 67%'), findsOneWidget);
      expect(find.textContaining('1 product'), findsOneWidget);
    });

    testWidgets('no caveat when every product has a cost price',
        (tester) async {
      await tester.pumpWidget(_wrap(profitView(_profit(knownPct: 100))));
      await tester.pumpAndSettle();
      expect(find.textContaining('covers'), findsNothing);
    });

    testWidgets('a product with no cost price is named as such, not zeroed',
        (tester) async {
      await tester.pumpWidget(_wrap(profitView(_profit())));
      await tester.pumpAndSettle();
      expect(find.textContaining('no cost price set'), findsOneWidget);
    });

    testWidgets('empty is scrollable so pull-to-refresh still works',
        (tester) async {
      await tester.pumpWidget(_wrap(profitView({
        'profit': {'by_product': [], 'by_day': []}
      })));
      await tester.pumpAndSettle();
      expect(find.text('No paid orders yet'), findsOneWidget);
      expect(find.byType(Scrollable), findsWidgets);
    });
  });

  group('delivery', () {
    testWidgets('a null late rate is explained, not shown as 0%',
        (tester) async {
      await tester.pumpWidget(_wrap(deliveryView({
        'delivery_sla': {
          'completed_deliveries': 3,
          'avg_minutes_to_deliver': 95,
          'late_count': 0,
          'late_rate_pct': null, // no order had an ETA
          'by_rider': [],
          'recent': []
        }
      })));
      await tester.pumpAndSettle();

      expect(find.textContaining('No delivery times were promised'),
          findsOneWidget);
      expect(find.text('0%'), findsNothing);
    });

    testWidgets('formats minutes as hours and minutes', (tester) async {
      await tester.pumpWidget(_wrap(deliveryView({
        'delivery_sla': {
          'completed_deliveries': 1,
          'avg_minutes_to_deliver': 95,
          'late_count': 0,
          'late_rate_pct': 0,
          'by_rider': [],
          'recent': [
            {'order_number': 'A1', 'rider_name': 'Kofi', 'minutes_to_deliver': 45, 'late': false}
          ]
        }
      })));
      await tester.pumpAndSettle();

      expect(find.text('1h 35m'), findsOneWidget);
      expect(find.text('45m'), findsOneWidget);
    });

    testWidgets('marks a late delivery and survives a null rider',
        (tester) async {
      await tester.pumpWidget(_wrap(deliveryView({
        'delivery_sla': {
          'completed_deliveries': 1,
          'avg_minutes_to_deliver': 30,
          'late_count': 1,
          'late_rate_pct': 100,
          'by_rider': [
            {'rider_name': '(unassigned)', 'deliveries': 1, 'avg_minutes': 30,
             'late_count': 1, 'late_rate_pct': 100}
          ],
          // recent uses the RAW rider_name, which can be null — by_rider
          // substitutes '(unassigned)' but recent does not.
          'recent': [
            {'order_number': 'A1', 'rider_name': null, 'minutes_to_deliver': 30, 'late': true}
          ]
        }
      })));
      await tester.pumpAndSettle();

      expect(find.text('Late'), findsOneWidget);
      expect(find.text('No rider recorded'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('cohorts', () {
    testWidgets('too little history reads as such, not as 0%', (tester) async {
      await tester.pumpWidget(_wrap(cohortsView({
        'cohorts': {
          'days': 30,
          'new_customers': {'customers': 5, 'orders': 5, 'revenue_ghs': 250.0},
          'returning_customers': {'customers': 0, 'orders': 0, 'revenue_ghs': 0},
          'repeat_rate_7d': {'window_days': 7, 'eligible_customers': 0,
                             'repeated_customers': 0, 'repeat_rate_pct': null},
          'repeat_rate_30d': {'window_days': 30, 'eligible_customers': 4,
                              'repeated_customers': 1, 'repeat_rate_pct': 25},
        }
      })));
      await tester.pumpAndSettle();

      expect(find.text('Not enough history yet'), findsOneWidget);
      expect(find.text('—'), findsOneWidget);
      expect(find.text('25%'), findsOneWidget);
      expect(find.text('1 of 4 customers'), findsOneWidget);
    });

    testWidgets('no customers at all is an empty state', (tester) async {
      await tester.pumpWidget(_wrap(cohortsView({
        'cohorts': {
          'new_customers': {'customers': 0, 'orders': 0, 'revenue_ghs': 0},
          'returning_customers': {'customers': 0, 'orders': 0, 'revenue_ghs': 0},
        }
      })));
      await tester.pumpAndSettle();
      expect(find.text('No paid customers in this period'), findsOneWidget);
    });
  });

  group('channels', () {
    testWidgets('reads the top-level array, not a nested object',
        (tester) async {
      await tester.pumpWidget(_wrap(channelsView({
        'channels': [
          {'channel': 'whatsapp', 'orders': 10, 'paid_orders': 8,
           'revenue_ghs': 400.0, 'unique_customers': 6},
          {'channel': 'storefront', 'orders': 3, 'paid_orders': 3,
           'revenue_ghs': 150.0, 'unique_customers': 3},
          {'channel': null, 'orders': 1, 'paid_orders': 0,
           'revenue_ghs': 0, 'unique_customers': 1},
        ],
        'days': 30
      })));
      await tester.pumpAndSettle();

      expect(find.text('WhatsApp'), findsOneWidget);
      expect(find.text('Storefront'), findsOneWidget);
      // A null channel is missing data, not a channel named "null".
      expect(find.text('Not recorded'), findsOneWidget);
      expect(find.text('14'), findsOneWidget); // total orders
    });

    testWidgets('empty channels is an empty state', (tester) async {
      await tester.pumpWidget(_wrap(channelsView({'channels': []})));
      await tester.pumpAndSettle();
      expect(find.text('No orders in this period'), findsOneWidget);
    });
  });

  group('windows', () {
    test('mirror what each route accepts', () {
      // The server silently falls back to its default for an unsupported
      // window, so offering one would mislabel the data.
      expect(analyticsWindows['overview'], [7, 30]);
      expect(analyticsWindows['cohorts'], [7, 30]);
      expect(analyticsWindows['profit'], [7, 30, 90]);
      expect(analyticsWindows['delivery'], [7, 30, 90]);
      expect(analyticsWindows['channels'], [7, 30, 90]);
    });
  });

  group('labels', () {
    test('durationLabel', () {
      expect(durationLabel(null), '—');
      expect(durationLabel(0), '0m');
      expect(durationLabel(59), '59m');
      expect(durationLabel(60), '1h 00m');
      expect(durationLabel(125), '2h 05m');
    });

    test('channelLabel', () {
      expect(channelLabel('whatsapp'), 'WhatsApp');
      expect(channelLabel(null), 'Not recorded');
      expect(channelLabel('tiktok'), 'Tiktok');
    });
  });
}
