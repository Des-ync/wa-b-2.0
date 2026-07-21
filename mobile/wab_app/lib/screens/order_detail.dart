import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'orders.dart' show orderStatuses;

class OrderDetailScreen extends StatefulWidget {
  final String orderId;
  const OrderDetailScreen({super.key, required this.orderId});

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  Map<String, dynamic>? _order;
  String? _error;
  bool _updating = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res =
          await context.read<Session>().api.get('/api/orders/${widget.orderId}');
      if (mounted) setState(() => _order = res['order'] as Map<String, dynamic>?);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _setStatus(String status) async {
    setState(() => _updating = true);
    final body = {'status': status};
    try {
      final res = await context
          .read<Session>()
          .api
          .patch('/api/orders/${widget.orderId}/status', body: body);
      if (!mounted) return;
      setState(() => _order = res['order'] as Map<String, dynamic>?);
      await OfflineCache.patchCachedOrder(widget.orderId, body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Order marked $status — customer notified')));
    } on ApiException catch (e) {
      if (e.status == 0) {
        // No connection — queue it and reflect the change locally so the
        // merchant isn't left staring at a stale status.
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-status-${widget.orderId}-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/orders/${widget.orderId}/status',
          body: body,
          description: 'Mark order #${_order?['order_number']} $status',
        ));
        await OfflineCache.patchCachedOrder(widget.orderId, body);
        if (mounted) {
          setState(() => _order = {...?_order, 'status': status});
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Offline — queued, will sync when back online')));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = _order;
    return Scaffold(
      appBar: AppBar(
          title: Text(o == null ? 'Order' : '#${o['order_number']}')),
      body: o == null
          ? _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(ghs(o['total_ghs']),
                                style: const TextStyle(
                                    fontSize: 26, fontWeight: FontWeight.w800)),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                StatusChip('${o['status']}'),
                                const SizedBox(height: 4),
                                StatusChip('${o['payment_status']}'),
                              ],
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(shortDate(o['created_at']),
                            style: const TextStyle(color: WabColors.muted)),
                        if (o['delivery_address'] != null) ...[
                          const SizedBox(height: 12),
                          Row(children: [
                            const Icon(Icons.location_on_outlined,
                                size: 18, color: WabColors.muted),
                            const SizedBox(width: 6),
                            Expanded(
                                child: Text('${o['delivery_address']}',
                                    style: const TextStyle(color: WabColors.ink))),
                          ]),
                        ],
                        if (o['notes'] != null && '${o['notes']}'.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text('Note: ${o['notes']}',
                              style: const TextStyle(color: WabColors.muted)),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                const Text('Items',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                Card(
                  child: Column(
                    children: [
                      for (final item in (o['items'] as List? ?? []))
                        ListTile(
                          dense: true,
                          title: Text('${item['name']}',
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                          leading: Text('×${item['quantity']}',
                              style: const TextStyle(
                                  color: WabColors.accentInk,
                                  fontWeight: FontWeight.w800,
                                  fontSize: 15)),
                          trailing: Text(
                              ghs((item['price_ghs'] ?? 0) *
                                  (item['quantity'] ?? 1)),
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                        ),
                      const Divider(height: 1),
                      _row('Subtotal', ghs(o['subtotal_ghs'])),
                      if ((num.tryParse('${o['discount_ghs'] ?? 0}') ?? 0) > 0)
                        _row('Discount (${o['promo_code'] ?? ''})',
                            '-${ghs(o['discount_ghs'])}'),
                      _row('Delivery', ghs(o['delivery_fee'])),
                      _row('Total', ghs(o['total_ghs']), bold: true),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                const Text('Update status',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: orderStatuses
                      .where((s) => s != 'pending' && s != '${o['status']}')
                      .map((s) => ActionChip(
                            label: Text(s),
                            onPressed: _updating ? null : () => _setStatus(s),
                            backgroundColor: s == 'cancelled'
                                ? WabColors.danger.withValues(alpha: 0.08)
                                : WabColors.accentSoft,
                            labelStyle: TextStyle(
                                color: s == 'cancelled'
                                    ? WabColors.danger
                                    : WabColors.accentInk,
                                fontWeight: FontWeight.w700),
                            side: BorderSide.none,
                          ))
                      .toList(),
                ),
                const SizedBox(height: 8),
                const Text(
                  'The customer gets a WhatsApp update automatically when you change the status.',
                  style: TextStyle(color: WabColors.muted2, fontSize: 13),
                ),
              ],
            ),
    );
  }

  Widget _row(String label, String value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(
                  color: bold ? WabColors.ink : WabColors.muted,
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
          Text(value,
              style: TextStyle(
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                  fontSize: bold ? 16 : 14)),
        ],
      ),
    );
  }
}
