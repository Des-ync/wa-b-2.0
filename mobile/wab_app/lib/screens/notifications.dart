import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/notifications_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat.dart';
import 'order_detail.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  int _reloadKey = 0;
  bool _markingAll = false;

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api.getNotifications(session.businessId!, limit: 100);
    return ((res['notifications'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _markAllRead() async {
    final session = context.read<Session>();
    setState(() => _markingAll = true);
    try {
      await session.api.markAllNotificationsRead(session.businessId!);
      if (mounted) setState(() => _reloadKey++);
    } finally {
      if (mounted) setState(() => _markingAll = false);
    }
  }

  Future<void> _open(Map<String, dynamic> n) async {
    final session = context.read<Session>();
    if (n['read_at'] == null) {
      // Fire-and-forget — the tap should feel instant either way.
      session.api.markNotificationRead('${n['id']}').catchError((_) => <String, dynamic>{});
      setState(() => n['read_at'] = DateTime.now().toIso8601String());
    }
    final data = (n['data'] as Map?)?.cast<String, dynamic>() ?? {};
    if (!mounted) return;
    switch (n['type']) {
      case 'new_order':
      case 'failed_payment':
        final orderId = data['order_id'];
        if (orderId != null) {
          await Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => OrderDetailScreen(orderId: '$orderId')));
        }
      case 'support_request':
        final customerId = data['customer_id'];
        if (customerId != null) {
          await Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => ChatScreen(customerId: '$customerId')));
        }
      case 'low_stock':
        // No dedicated single-product screen to deep-link to — the Products
        // tab is where it's fixed. Just leave it marked read.
        break;
    }
  }

  IconData _iconFor(String type) => switch (type) {
        'new_order' => Icons.shopping_bag_rounded,
        'failed_payment' => Icons.error_rounded,
        'low_stock' => Icons.inventory_2_rounded,
        'support_request' => Icons.front_hand_rounded,
        _ => Icons.notifications_rounded,
      };

  Color _colorFor(String type) => switch (type) {
        'new_order' => WabColors.accentInk,
        'failed_payment' => WabColors.danger,
        'low_stock' => WabColors.warning,
        'support_request' => WabColors.warning,
        _ => WabColors.muted,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          TextButton(
            onPressed: _markingAll ? null : _markAllRead,
            child: const Text('Mark all read'),
          ),
        ],
      ),
      body: AsyncList<Map<String, dynamic>>(
        key: ValueKey(_reloadKey),
        load: _load,
        emptyTitle: 'No notifications yet',
        emptySubtitle: 'New orders, failed payments, low stock, and handoff requests show up here.',
        emptyIcon: Icons.notifications_none_rounded,
        itemBuilder: (ctx, n) {
          final unread = n['read_at'] == null;
          final type = '${n['type']}';
          return Card(
            color: unread ? WabColors.accentSoft.withValues(alpha: 0.5) : null,
            child: ListTile(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              leading: CircleAvatar(
                backgroundColor: _colorFor(type).withValues(alpha: 0.12),
                child: Icon(_iconFor(type), color: _colorFor(type), size: 20),
              ),
              title: Text('${n['title']}',
                  style: TextStyle(
                      fontWeight: unread ? FontWeight.w800 : FontWeight.w600)),
              subtitle: n['body'] == null
                  ? null
                  : Text('${n['body']}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: WabColors.muted)),
              trailing: Text(timeAgo(n['created_at']),
                  style: const TextStyle(color: WabColors.muted2, fontSize: 12)),
              onTap: () => _open(n),
            ),
          );
        },
      ),
    );
  }
}
