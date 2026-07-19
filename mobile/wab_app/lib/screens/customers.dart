import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat.dart';

class CustomersScreen extends StatefulWidget {
  const CustomersScreen({super.key});

  @override
  State<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends State<CustomersScreen> {
  String _sort = 'top';
  int _reloadKey = 0;
  String _search = '';

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api.get('/api/customers', query: {
      'business_id': session.businessId,
      'limit': 200,
      if (_sort == 'recent') 'sort': 'recent',
    });
    return ((res['customers'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Customers'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'top', label: Text('Top')),
                ButtonSegment(value: 'recent', label: Text('Recent')),
              ],
              selected: {_sort},
              onSelectionChanged: (s) => setState(() {
                _sort = s.first;
                _reloadKey++;
              }),
              style: SegmentedButton.styleFrom(
                  selectedBackgroundColor: WabColors.accentSoft,
                  selectedForegroundColor: WabColors.accentInk,
                  visualDensity: VisualDensity.compact),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search name or number…',
                prefixIcon: Icon(Icons.search_rounded, color: WabColors.muted),
                contentPadding: EdgeInsets.symmetric(vertical: 10, horizontal: 16),
              ),
              onChanged: (v) => setState(() => _search = v.toLowerCase()),
            ),
          ),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: () async {
                final all = await _load();
                if (_search.isEmpty) return all;
                return all
                    .where((c) =>
                        '${c['display_name'] ?? ''}'.toLowerCase().contains(_search) ||
                        '${c['whatsapp_number'] ?? ''}'.contains(_search))
                    .toList();
              },
              emptyTitle: 'No customers yet',
              emptySubtitle:
                  'Anyone who messages your WhatsApp number becomes a customer here.',
              emptyIcon: Icons.people_alt_rounded,
              itemBuilder: (ctx, c) {
                final name =
                    (c['display_name'] ?? c['whatsapp_number'] ?? '?').toString();
                return Card(
                  child: ListTile(
                    shape:
                        RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    leading: CircleAvatar(
                      backgroundColor: WabColors.accentSoft,
                      child: Text(name.isEmpty ? '?' : name[0].toUpperCase(),
                          style: const TextStyle(
                              color: WabColors.accentInk, fontWeight: FontWeight.w800)),
                    ),
                    title: Text(name,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(
                        '${c['total_orders'] ?? 0} orders · last seen ${timeAgo(c['last_seen_at'])}',
                        style: const TextStyle(color: WabColors.muted)),
                    trailing: Text(ghs(c['total_spent_ghs']),
                        style: const TextStyle(
                            fontWeight: FontWeight.w800,
                            color: WabColors.accentInk,
                            fontSize: 15)),
                    onTap: () => Navigator.of(ctx).push(MaterialPageRoute(
                        builder: (_) =>
                            ChatScreen(customerId: '${c['id']}', customerName: name))),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
