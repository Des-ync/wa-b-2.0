import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wab_app/theme.dart';
import 'package:wab_app/widgets/common.dart';

/// Order state as the merchant reads it.
///
/// This is where the original "mark paid" bug was actually visible: the chip
/// flipped to a confident green "paid" while payment_status stayed pending
/// and the sale sat outside GMV. The backend is fixed, but the rendering
/// layer is still the last thing standing between a wrong value and a
/// merchant's decision, so the mapping is pinned here — colour and wording
/// both, since either alone can mislead.

Future<void> pumpChip(WidgetTester tester, StatusChip chip) =>
    tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: chip))));

Color chipColor(WidgetTester tester) =>
    tester.widget<Text>(find.byType(Text)).style!.color!;

void main() {
  group('paymentStatusLabel', () {
    test('turns raw backend values into merchant wording', () {
      // 'unpaid' and 'pending' are different states to the backend but mean
      // the same thing to a merchant standing in front of a customer.
      expect(paymentStatusLabel('paid'), 'Payment received');
      expect(paymentStatusLabel('pending'), 'Awaiting payment');
      expect(paymentStatusLabel('unpaid'), 'Awaiting payment');
      expect(paymentStatusLabel('failed'), 'Payment failed');
      expect(paymentStatusLabel('refunded'), 'Refunded');
    });

    test('passes unknown values through untouched', () {
      // Safe to call on a payment_status-or-status fallback: an order
      // lifecycle value must survive rather than being blanked out.
      expect(paymentStatusLabel('preparing'), 'preparing');
      expect(paymentStatusLabel('delivered'), 'delivered');
      expect(paymentStatusLabel(null), '—');
      expect(paymentStatusLabel(''), '');
    });

    test('never renders a raw value as if it were friendly copy', () {
      // The four real payment states must all be translated. If a new one is
      // added to the backend and not mapped here, this catches it as soon as
      // the value is listed.
      for (final raw in ['paid', 'pending', 'unpaid', 'failed', 'refunded']) {
        expect(paymentStatusLabel(raw), isNot(raw),
            reason: '"$raw" is leaking to the merchant untranslated');
      }
    });
  });

  group('StatusChip colour', () {
    testWidgets('settled states read as resolved', (tester) async {
      for (final status in ['paid', 'active', 'delivered', 'done', 'settled']) {
        await pumpChip(tester, StatusChip(status));
        expect(chipColor(tester), WabColors.accentInk, reason: status);
      }
    });

    testWidgets('in-flight states read as needing attention', (tester) async {
      for (final status in ['pending', 'confirmed', 'preparing', 'unpaid']) {
        await pumpChip(tester, StatusChip(status));
        expect(chipColor(tester), WabColors.warning, reason: status);
      }
    });

    testWidgets('broken states read as a problem', (tester) async {
      for (final status in ['failed', 'cancelled', 'expired', 'refunded']) {
        await pumpChip(tester, StatusChip(status));
        expect(chipColor(tester), WabColors.danger, reason: status);
      }
    });

    testWidgets('an unpaid order is never coloured as settled',
        (tester) async {
      // The exact confusion the mark-paid bug produced.
      await pumpChip(tester, const StatusChip('unpaid'));
      expect(chipColor(tester), isNot(WabColors.accentInk));
    });

    testWidgets('an unknown status degrades to neutral, not alarming',
        (tester) async {
      await pumpChip(tester, const StatusChip('some_future_state'));
      expect(chipColor(tester), WabColors.muted);
    });
  });

  group('StatusChip text', () {
    testWidgets('shows the raw status when no label is given', (tester) async {
      await pumpChip(tester, const StatusChip('preparing'));
      expect(find.text('preparing'), findsOneWidget);
    });

    testWidgets('a label overrides the text but not the colour',
        (tester) async {
      await pumpChip(
          tester, StatusChip('unpaid', label: paymentStatusLabel('unpaid')));

      expect(find.text('Awaiting payment'), findsOneWidget);
      expect(find.text('unpaid'), findsNothing);
      // Colour still comes from the raw value, so the two can never disagree.
      expect(chipColor(tester), WabColors.warning);
    });
  });

  group('timeAgo', () {
    test('reads recent activity in the units a merchant thinks in', () {
      final now = DateTime.now();
      expect(timeAgo(now.toIso8601String()), 'now');
      expect(timeAgo(now.subtract(const Duration(minutes: 5)).toIso8601String()),
          '5m ago');
      expect(timeAgo(now.subtract(const Duration(hours: 3)).toIso8601String()),
          '3h ago');
      expect(timeAgo(now.subtract(const Duration(days: 2)).toIso8601String()),
          '2d ago');
    });

    test('falls back to a date beyond a week', () {
      final old = DateTime.now().subtract(const Duration(days: 40));
      expect(timeAgo(old.toIso8601String()), isNot(contains('ago')));
    });

    test('survives null and garbage rather than throwing mid-list', () {
      // These render inside list builders — an exception here blanks a whole
      // screen rather than one row.
      expect(timeAgo(null), '');
      expect(timeAgo('not a date'), '');
      expect(timeAgo(''), '');
    });
  });
}
