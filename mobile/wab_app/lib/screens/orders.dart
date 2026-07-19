import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'order_detail.dart';

const orderStatuses = [
  'pending', 'confirmed', 'paid', 'preparing', 'ready', 'delivered', 'cancelled'
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

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api.get('/api/orders', query: {
      'business_id': session.businessId,
      'limit': 100,
      if (_filter != null) 'status': _filter,
    });
    return ((res['orders'] as List?) ?? []).cast<Map<String, dynamic>>();
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
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: _load,
              emptyTitle: 'No orders here',
              emptySubtitle: 'Orders placed through your WhatsApp bot appear here.',
              emptyIcon: Icons.receipt_long_rounded,
              itemBuilder: (ctx, o) => Card(
                child: ListTile(
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                      const SizedBox(height: 4),
                      StatusChip('${o['status']}'),
                    ],
                  ),
                  onTap: () => Navigator.of(ctx)
                      .push(MaterialPageRoute(
                          builder: (_) => OrderDetailScreen(orderId: '${o['id']}')))
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
