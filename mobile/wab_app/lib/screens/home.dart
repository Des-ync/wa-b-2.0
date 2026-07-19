import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'order_detail.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _stats;
  List<dynamic> _recentOrders = [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;
    setState(() {
      _loading = _stats == null;
      _error = null;
    });
    try {
      final results = await Future.wait([
        session.api.get('/api/orders/stats/today', query: {'business_id': bid}),
        session.api.get('/api/orders', query: {'business_id': bid, 'limit': 10}),
      ]);
      if (!mounted) return;
      setState(() {
        _stats = results[0]['stats'] as Map<String, dynamic>?;
        _recentOrders = (results[1]['orders'] as List?) ?? [];
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final name = session.business?['name']?.toString() ?? 'Your shop';
    final status = session.business?['status']?.toString();

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(name),
            const Text('Today',
                style: TextStyle(
                    fontSize: 13, color: WabColors.muted, fontWeight: FontWeight.w500)),
          ],
        ),
        toolbarHeight: 68,
        actions: [
          if (status != null)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(child: StatusChip(status)),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      _statGrid(),
                      const SizedBox(height: 24),
                      const Text('Recent orders',
                          style: TextStyle(
                              fontSize: 17, fontWeight: FontWeight.w800, color: WabColors.ink)),
                      const SizedBox(height: 12),
                      if (_recentOrders.isEmpty)
                        const Padding(
                          padding: EdgeInsets.only(top: 32),
                          child: EmptyState(
                              icon: Icons.receipt_long_rounded,
                              title: 'No orders yet today',
                              subtitle:
                                  'When customers order on WhatsApp, they show up here instantly.'),
                        )
                      else
                        ..._recentOrders.map((o) => Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _orderTile(o as Map<String, dynamic>),
                            )),
                    ],
                  ),
                ),
    );
  }

  Widget _statGrid() {
    final s = _stats ?? {};
    final tiles = [
      ('Sales today', ghs(s['gmv_ghs'] ?? 0), WabColors.accentInk),
      ('Paid orders', '${s['paid_count'] ?? 0}', WabColors.ink),
      ('Awaiting payment', '${s['awaiting_payment'] ?? 0}', WabColors.warning),
      ('Open orders', '${s['open_orders'] ?? 0}', WabColors.ink),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 1.55,
      children: tiles
          .map((t) => Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(t.$2,
                          style: TextStyle(
                              fontSize: 24, fontWeight: FontWeight.w800, color: t.$3)),
                      const SizedBox(height: 4),
                      Text(t.$1,
                          style: const TextStyle(fontSize: 13, color: WabColors.muted)),
                    ],
                  ),
                ),
              ))
          .toList(),
    );
  }

  Widget _orderTile(Map<String, dynamic> o) {
    return Card(
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: Text('#${o['order_number']}',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
            '${(o['items'] as List?)?.length ?? 0} item(s) · ${timeAgo(o['created_at'])}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: WabColors.muted)),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(ghs(o['total_ghs']),
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const SizedBox(height: 4),
            StatusChip('${o['payment_status'] ?? o['status']}'),
          ],
        ),
        onTap: () => Navigator.of(context)
            .push(MaterialPageRoute(
                builder: (_) => OrderDetailScreen(orderId: '${o['id']}')))
            .then((_) => _load()),
      ),
    );
  }
}
