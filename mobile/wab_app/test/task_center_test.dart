import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wab_app/state/shell_tabs.dart';
import 'package:wab_app/state/task_center.dart';
import 'package:wab_app/widgets/task_center.dart';

/// The Task Center's judgement — which tasks appear, in what order, and how
/// they are worded — lives in a pure function precisely so it can be tested
/// like this, without a widget tree.
///
/// The thing being defended is a merchant's attention. A list that cries wolf
/// (a "task" for something nobody is stuck on) or that buries a blocked shop
/// under stock advice is worse than no list at all.

Map<String, dynamic> stats({
  int needsConfirmation = 0,
  int awaitingReply = 0,
  int failedPayments = 0,
  int lowStock = 0,
  int awaitingPayment = 0,
}) => {
      'needs_confirmation_count': needsConfirmation,
      'messages_needing_reply_count': awaitingReply,
      'failed_payments_count': failedPayments,
      'low_stock_count': lowStock,
      'awaiting_payment': awaitingPayment,
    };

Map<String, dynamic> onboarding(List<Map<String, dynamic>> steps) => {'steps': steps};

Map<String, dynamic> step(String key, {bool complete = true, bool optional = false}) => {
      'key': key, 'label': key, 'description': 'do $key',
      'complete': complete, 'optional': optional,
    };

void main() {
  widgetTests();
  group('empty state', () {
    test('a shop with nothing outstanding gets no tasks at all', () {
      final tasks = buildTasks(stats: stats(), onboarding: onboarding([]), business: {});
      expect(tasks, isEmpty,
          reason: 'an empty Task Center is a good morning, not a broken screen');
    });

    test('missing data produces no tasks rather than throwing', () {
      // Offline cold start: stats can be null, onboarding can fail its own
      // request without blanking the screen.
      expect(buildTasks(), isEmpty);
      expect(buildTasks(stats: {}, onboarding: {}, business: {}), isEmpty);
      expect(buildTasks(stats: {'needs_confirmation_count': null}), isEmpty);
    });
  });

  group('what earns a place', () {
    test('orders needing confirmation', () {
      final t = buildTasks(stats: stats(needsConfirmation: 3)).single;
      expect(t.title, '3 orders need confirmation');
      expect(t.urgency, TaskUrgency.attention);
      expect(t.action, TaskAction.openOrders);
    });

    test('customers waiting for a human', () {
      final t = buildTasks(stats: stats(awaitingReply: 2)).single;
      expect(t.title, '2 customers are waiting for a reply');
      expect(t.subtitle, contains('bot is paused'));
      expect(t.action, TaskAction.openInbox);
    });

    test('failed payments', () {
      final t = buildTasks(stats: stats(failedPayments: 1)).single;
      expect(t.title, '1 failed payment today');
      expect(t.urgency, TaskUrgency.attention, reason: 'this is lost money');
    });

    test('low stock is information, not an emergency', () {
      final t = buildTasks(stats: stats(lowStock: 5)).single;
      expect(t.title, '5 products are running low');
      expect(t.urgency, TaskUrgency.info);
      expect(t.action, TaskAction.openProducts);
    });

    test('orders awaiting payment', () {
      final t = buildTasks(stats: stats(awaitingPayment: 4)).single;
      expect(t.title, '4 orders are awaiting payment');
      expect(t.urgency, TaskUrgency.info);
    });
  });

  group('wording', () {
    test('singular and plural are both correct', () {
      expect(buildTasks(stats: stats(needsConfirmation: 1)).single.title,
          '1 order needs confirmation');
      expect(buildTasks(stats: stats(needsConfirmation: 2)).single.title,
          '2 orders need confirmation');

      expect(buildTasks(stats: stats(awaitingReply: 1)).single.title,
          '1 customer is waiting for a reply');
      expect(buildTasks(stats: stats(lowStock: 1)).single.title,
          '1 product is running low');
      expect(buildTasks(stats: stats(failedPayments: 2)).single.title,
          '2 failed payments today');
    });
  });

  group('onboarding', () {
    test('an incomplete required step blocks everything else', () {
      final tasks = buildTasks(
        stats: stats(needsConfirmation: 9, lowStock: 9),
        onboarding: onboarding([
          step('business_profile'),
          step('whatsapp_number', complete: false),
        ]),
      );

      // Nothing else matters if the bot cannot receive an order.
      expect(tasks.first.urgency, TaskUrgency.blocking);
      expect(tasks.first.title, contains('whatsapp_number'));
      expect(tasks.first.action, TaskAction.openOnboarding);
    });

    test('it counts the remaining steps when there is more than one', () {
      final tasks = buildTasks(onboarding: onboarding([
        step('a', complete: false),
        step('b', complete: false),
        step('c', complete: false),
      ]));

      expect(tasks.single.subtitle, '3 steps left before your shop is live');
    });

    test('a single remaining step shows what to actually do', () {
      final tasks = buildTasks(onboarding: onboarding([
        step('a'),
        step('payment_provider', complete: false),
      ]));

      expect(tasks.single.subtitle, 'do payment_provider');
    });

    test('an optional step never blocks', () {
      // A solo shopkeeper who never invites staff is a fully set-up shop.
      final tasks = buildTasks(onboarding: onboarding([
        step('business_profile'),
        step('invite_staff', complete: false, optional: true),
      ]));

      expect(tasks, isEmpty);
    });

    test('a fully complete checklist produces nothing', () {
      expect(buildTasks(onboarding: onboarding([step('a'), step('b')])), isEmpty);
    });
  });

  group('trial', () {
    Map<String, dynamic> trial(int daysFromNow) => {
          'status': 'trial',
          'trial_ends_at':
              DateTime.now().add(Duration(days: daysFromNow, hours: 1)).toIso8601String(),
        };

    test('warns inside the last week', () {
      final t = buildTasks(business: trial(2)).single;
      expect(t.title, 'Your trial ends in 2 days');
      expect(t.urgency, TaskUrgency.blocking);
      expect(t.action, TaskAction.openSettings);
    });

    test('says so once it has ended', () {
      final t = buildTasks(business: trial(-3)).single;
      expect(t.title, 'Your trial has ended');
    });

    test('stays quiet while the trial has room left', () {
      // Nagging from day one trains a merchant to ignore the list.
      expect(buildTasks(business: trial(30)), isEmpty);
    });

    test('says nothing for a business that is not on trial', () {
      expect(
          buildTasks(business: {
            'status': 'active',
            'trial_ends_at': DateTime.now().toIso8601String()
          }),
          isEmpty);
      expect(buildTasks(business: {'status': 'trial'}), isEmpty,
          reason: 'no end date means nothing useful to say');
    });
  });

  group('ordering', () {
    test('blocking, then attention, then info', () {
      final tasks = buildTasks(
        stats: stats(needsConfirmation: 1, lowStock: 1, awaitingReply: 1, awaitingPayment: 1),
        onboarding: onboarding([step('setup', complete: false)]),
        business: {'status': 'trial', 'trial_ends_at': DateTime.now().add(const Duration(days: 1)).toIso8601String()},
      );

      expect(tasks.map((t) => t.urgency).toList(), [
        TaskUrgency.blocking, TaskUrgency.blocking,
        TaskUrgency.attention, TaskUrgency.attention,
        TaskUrgency.info, TaskUrgency.info,
      ]);
    });

    test('order within a band is stable and intentional', () {
      // Dart's List.sort is NOT stable, so equal-urgency items are ordered by
      // their original index explicitly. A shuffling list would make the
      // merchant re-read it every refresh.
      final first = buildTasks(stats: stats(needsConfirmation: 1, awaitingReply: 1, failedPayments: 1));
      final again = buildTasks(stats: stats(needsConfirmation: 1, awaitingReply: 1, failedPayments: 1));

      expect(first.map((t) => t.id).toList(), again.map((t) => t.id).toList());
      expect(first.map((t) => t.id).toList(),
          ['orders:confirm', 'inbox:reply', 'payments:failed']);
    });
  });

  group('navigation', () {
    test('every action maps to a real shell tab', () {
      final tasks = buildTasks(
        stats: stats(needsConfirmation: 1, awaitingReply: 1, lowStock: 1),
        business: {'status': 'trial', 'trial_ends_at': DateTime.now().toIso8601String()},
      );

      for (final t in tasks) {
        expect(t.tabIndex, inInclusiveRange(ShellTab.home, ShellTab.more),
            reason: '${t.id} points outside the tab bar');
      }
    });

    test('each task type lands on the screen that resolves it', () {
      expect(buildTasks(stats: stats(needsConfirmation: 1)).single.tabIndex, ShellTab.orders);
      expect(buildTasks(stats: stats(awaitingReply: 1)).single.tabIndex, ShellTab.inbox);
      expect(buildTasks(stats: stats(lowStock: 1)).single.tabIndex, ShellTab.products);
    });

    test('task ids are unique, so a list can key on them', () {
      final tasks = buildTasks(
        stats: stats(needsConfirmation: 1, awaitingReply: 1, failedPayments: 1, lowStock: 1, awaitingPayment: 1),
        onboarding: onboarding([step('s', complete: false)]),
      );
      expect(tasks.map((t) => t.id).toSet().length, tasks.length);
    });
  });
}

/// --------------------------------------------------------------------------
/// The widget half: that a tap actually resolves somewhere.
/// --------------------------------------------------------------------------
void widgetTests() {
  group('TaskCenter widget', () {
    testWidgets('renders nothing at all when there is nothing to do',
        (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: TaskCenter(tasks: [])),
      ));

      // Not an "all clear" card — a cheerful empty state every morning is
      // noise the merchant learns to scroll past.
      expect(find.text('Things to do'), findsNothing);
      expect(find.byType(InkWell), findsNothing);
    });

    testWidgets('shows each task with its count badge', (tester) async {
      final tasks = buildTasks(stats: stats(needsConfirmation: 3, lowStock: 2));

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: TaskCenter(tasks: tasks)),
      ));

      expect(find.text('Things to do'), findsOneWidget);
      expect(find.text('2'), findsOneWidget, reason: 'the badge counts tasks');
      expect(find.text('3 orders need confirmation'), findsOneWidget);
      expect(find.text('2 products are running low'), findsOneWidget);
    });

    testWidgets('tapping a task asks the shell for that tab', (tester) async {
      final requested = <int>[];
      final sub = shellTabRequests.stream.listen(requested.add);
      addTearDown(sub.cancel);

      final tasks = buildTasks(stats: stats(awaitingReply: 1));
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: TaskCenter(tasks: tasks)),
      ));

      await tester.tap(find.text('1 customer is waiting for a reply'));
      await tester.pump();

      // Resolves IN PLACE — the shell switches tab rather than pushing a
      // second Inbox over Home with a back arrow.
      expect(requested, [ShellTab.inbox]);
    });

    testWidgets('a blocking task is visually distinct from an informational one',
        (tester) async {
      final tasks = buildTasks(
        stats: stats(lowStock: 1),
        onboarding: onboarding([step('setup', complete: false)]),
      );

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: TaskCenter(tasks: tasks)),
      ));

      expect(find.byIcon(Icons.error_rounded), findsOneWidget);
      expect(find.byIcon(Icons.info_outline_rounded), findsOneWidget);
    });
  });
}
