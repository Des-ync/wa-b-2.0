import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'order_detail.dart';

const orderStatuses = [
  'pending',
  'confirmed',
  'paid',
  'preparing',
  'ready',
  'delivered',
  'cancelled'
];

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  String? _filter;
  // Bumped to force AsyncList to reload when the filter changes.
  int _reloadKey = 0;
  bool _offline = false;
  StreamSubscription<List<ConnectivityResult>>? _connSub;

  @override
  void initState() {
    super.initState();
    // Pick up anything queued from a previous offline session as soon as
    // we're back, and keep watching for reconnects while this screen lives.
    _tryFlush();
    _connSub = Connectivity().onConnectivityChanged.listen((results) {
      if (results.any((r) => r != ConnectivityResult.none)) _tryFlush();
    });
  }

  @override
  void dispose() {
    _connSub?.cancel();
    super.dispose();
  }

  Future<void> _tryFlush() async {
    if (!mounted) return;
    final session = context.read<Session>();
    await OfflineQueue.flush(session.api);
    if (mounted) setState(() => _reloadKey++);
  }

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    try {
      final res = await session.api.get('/api/orders', query: {
        'business_id': session.businessId,
        'limit': 100,
        if (_filter != null) 'status': _filter,
      });
      final orders =
          ((res['orders'] as List?) ?? []).cast<Map<String, dynamic>>();
      unawaited(OfflineCache.saveOrders(orders));
      if (mounted) setState(() => _offline = false);
      return orders;
    } catch (e) {
      final cached = await OfflineCache.loadOrders();
      if (cached != null) {
        final filtered = _filter == null
            ? cached
            : cached.where((o) => o['status'] == _filter).toList();
        if (mounted) setState(() => _offline = true);
        return filtered;
      }
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: Column(
        children: [
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [null, ...orderStatuses].map((s) {
                final selected = _filter == s;
                return Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(s ?? 'All'),
                    selected: selected,
                    onSelected: (_) => setState(() {
                      _filter = s;
                      _reloadKey++;
                    }),
                    selectedColor: WabColors.accentSoft,
                    labelStyle: TextStyle(
                        color: selected ? WabColors.accentInk : WabColors.muted,
                        fontWeight: FontWeight.w600),
                    side: const BorderSide(color: WabColors.line),
                    showCheckmark: false,
                  ),
                );
              }).toList(),
            ),
          ),
          if (_offline) const OfflineBanner(),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: _load,
              emptyTitle: 'No orders here',
              emptySubtitle:
                  'Orders placed through your WhatsApp bot appear here.',
              emptyIcon: Icons.receipt_long_rounded,
              itemBuilder: (ctx, o) => Card(
                child: ListTile(
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                  title: Text('#${o['order_number']}',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                      '${(o['items'] as List?)?.length ?? 0} item(s) · ${timeAgo(o['created_at'])}',
                      style: const TextStyle(color: WabColors.muted)),
                  trailing: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(ghs(o['total_ghs']),
                          style: const TextStyle(
                              fontWeight: FontWeight.w800, fontSize: 15)),
                      const SizedBox(height: 4),
                      StatusChip('${o['status']}'),
                    ],
                  ),
                  onTap: () => Navigator.of(ctx)
                      .push(MaterialPageRoute(
                          builder: (_) =>
                              OrderDetailScreen(orderId: '${o['id']}')))
                      .then((_) => setState(() => _reloadKey++)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
