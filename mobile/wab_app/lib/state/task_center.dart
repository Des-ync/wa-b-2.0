import 'shell_tabs.dart';

/// What a Task Center row wants the merchant to do.
enum TaskAction { openOrders, openInbox, openProducts, openSettings, openOnboarding }

/// Urgency, which drives both sort order and colour.
///
/// `blocking` is reserved for things that stop the shop working at all — a
/// setup step that isn't done, a trial about to lapse. `attention` is money
/// or a customer waiting. `info` is worth knowing but nobody is stuck.
enum TaskUrgency { blocking, attention, info }

class MerchantTask {
  final String id;
  final String title;
  final String? subtitle;
  final TaskUrgency urgency;
  final TaskAction action;

  const MerchantTask({
    required this.id,
    required this.title,
    this.subtitle,
    required this.urgency,
    required this.action,
  });

  int get tabIndex => switch (action) {
        TaskAction.openOrders => ShellTab.orders,
        TaskAction.openInbox => ShellTab.inbox,
        TaskAction.openProducts => ShellTab.products,
        TaskAction.openSettings => ShellTab.more,
        TaskAction.openOnboarding => ShellTab.home,
      };
}

/// Turns the Today aggregates into a ranked to-do list.
///
/// Deliberately a pure function of data the home screen ALREADY fetches —
/// `/api/orders/stats/today`, the onboarding status, and the session's own
/// business row. A Task Center that costs an extra round trip on every cold
/// load would be paid for by a merchant on 3G every single morning, which is
/// exactly the trade this product cannot make.
///
/// Being pure also means the interesting part — which tasks appear, in what
/// order, and what wording — is unit-testable without a widget tree.
List<MerchantTask> buildTasks({
  Map<String, dynamic>? stats,
  Map<String, dynamic>? onboarding,
  Map<String, dynamic>? business,
}) {
  final s = stats ?? const {};
  final tasks = <MerchantTask>[];

  int count(String key) => (s[key] as num?)?.toInt() ?? 0;
  String plural(int n, String one, String many) => n == 1 ? one : many;

  // ---- blocking: the shop is not fully working ----------------------------

  // Setup steps come first because nothing else matters if the bot cannot
  // receive an order. Optional steps never block.
  final steps = (onboarding?['steps'] as List?) ?? const [];
  final incomplete = steps
      .whereType<Map>()
      .where((st) => st['complete'] != true && st['optional'] != true)
      .toList();
  if (incomplete.isNotEmpty) {
    final first = incomplete.first;
    tasks.add(MerchantTask(
      id: 'onboarding:${first['key']}',
      title: 'Finish setup: ${first['label']}',
      subtitle: incomplete.length > 1
          ? '${incomplete.length} steps left before your shop is live'
          : '${first['description']}',
      urgency: TaskUrgency.blocking,
      action: TaskAction.openOnboarding,
    ));
  }

  final trialEndsAt = DateTime.tryParse('${business?['trial_ends_at'] ?? ''}');
  if (business?['status'] == 'trial' && trialEndsAt != null) {
    final days = trialEndsAt.difference(DateTime.now()).inDays;
    if (days <= 7) {
      tasks.add(MerchantTask(
        id: 'trial',
        title: days <= 0
            ? 'Your trial has ended'
            : 'Your trial ends in $days ${plural(days, 'day', 'days')}',
        subtitle: 'Add a payment method to keep taking orders',
        urgency: TaskUrgency.blocking,
        action: TaskAction.openSettings,
      ));
    }
  }

  // ---- attention: money or a person is waiting ----------------------------

  final needsConfirmation = count('needs_confirmation_count');
  if (needsConfirmation > 0) {
    tasks.add(MerchantTask(
      id: 'orders:confirm',
      title: '$needsConfirmation ${plural(needsConfirmation, 'order needs', 'orders need')} confirmation',
      subtitle: 'Customers are waiting to hear back',
      urgency: TaskUrgency.attention,
      action: TaskAction.openOrders,
    ));
  }

  final awaitingReply = count('messages_needing_reply_count');
  if (awaitingReply > 0) {
    tasks.add(MerchantTask(
      id: 'inbox:reply',
      title: '$awaitingReply ${plural(awaitingReply, 'customer is', 'customers are')} waiting for a reply',
      // These are chats where the bot was paused for a human, so nobody is
      // answering them automatically.
      subtitle: 'The bot is paused on these chats',
      urgency: TaskUrgency.attention,
      action: TaskAction.openInbox,
    ));
  }

  final failedPayments = count('failed_payments_count');
  if (failedPayments > 0) {
    tasks.add(MerchantTask(
      id: 'payments:failed',
      title: '$failedPayments failed ${plural(failedPayments, 'payment', 'payments')} today',
      subtitle: 'Send a reminder so the sale is not lost',
      urgency: TaskUrgency.attention,
      action: TaskAction.openOrders,
    ));
  }

  // ---- info: worth knowing, nobody is stuck -------------------------------

  final lowStock = count('low_stock_count');
  if (lowStock > 0) {
    tasks.add(MerchantTask(
      id: 'products:lowstock',
      title: '$lowStock ${plural(lowStock, 'product is', 'products are')} running low',
      subtitle: 'Restock before they sell out',
      urgency: TaskUrgency.info,
      action: TaskAction.openProducts,
    ));
  }

  final awaitingPayment = count('awaiting_payment');
  if (awaitingPayment > 0) {
    tasks.add(MerchantTask(
      id: 'orders:unpaid',
      title: '$awaitingPayment ${plural(awaitingPayment, 'order is', 'orders are')} awaiting payment',
      subtitle: 'Nudge the customer if it has been a while',
      urgency: TaskUrgency.info,
      action: TaskAction.openOrders,
    ));
  }

  // Stable ordering: blocking first, then attention, then info. Within a
  // band the insertion order above is the intended priority, and List.sort
  // is not stable in Dart — so sort on the index rather than the enum.
  final indexed = tasks.asMap().entries.toList()
    ..sort((a, b) {
      final byUrgency = a.value.urgency.index.compareTo(b.value.urgency.index);
      return byUrgency != 0 ? byUrgency : a.key.compareTo(b.key);
    });
  return indexed.map((e) => e.value).toList();
}
