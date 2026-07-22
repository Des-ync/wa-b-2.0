import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat.dart';

class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  int _reloadKey = 0;
  String _query = '';
  final _searchCtrl = TextEditingController();

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api.get('/api/conversations',
        query: {'business_id': session.businessId, 'limit': 100});
    return ((res['conversations'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  List<Map<String, dynamic>> _filter(List<Map<String, dynamic>> items) {
    if (_query.isEmpty) return items;
    final q = _query.toLowerCase();
    return items
        .where((c) =>
            '${c['display_name'] ?? ''}'.toLowerCase().contains(q) ||
            '${c['whatsapp_number'] ?? ''}'.contains(q) ||
            '${c['last_message'] ?? ''}'.toLowerCase().contains(q))
        .toList();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Inbox')),
      body: Column(
        children: [
          SearchField(
            controller: _searchCtrl,
            hint: 'Search conversations',
            onChanged: (v) => setState(() => _query = v),
          ),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: _load,
              transform: _filter,
              emptyFilteredTitle: 'No conversations match "$_query"',
              emptyTitle: 'No conversations yet',
              emptySubtitle:
                  'Customer chats with your WhatsApp bot show up here.',
              emptyIcon: Icons.chat_bubble_rounded,
              itemBuilder: (ctx, c) {
                final name = (c['display_name'] ?? c['whatsapp_number'] ?? '?')
                    .toString();
                final paused = c['bot_paused'] == true;
                return Card(
                  child: ListTile(
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                    leading: CircleAvatar(
                      backgroundColor: WabColors.accentSoft,
                      child: Text(name.isEmpty ? '?' : name[0].toUpperCase(),
                          style: const TextStyle(
                              color: WabColors.accentInk,
                              fontWeight: FontWeight.w800)),
                    ),
                    title: Row(
                      children: [
                        Expanded(
                            child: Text(name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700))),
                        if (paused)
                          const Padding(
                            padding: EdgeInsets.only(left: 6),
                            child: Icon(Icons.front_hand_rounded,
                                size: 16, color: WabColors.warning),
                          ),
                      ],
                    ),
                    subtitle: Text(
                      (c['last_message'] ?? '').toString(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: WabColors.muted),
                    ),
                    trailing: Text(
                        timeAgo(c['last_message_at'] ?? c['last_seen_at']),
                        style: const TextStyle(
                            color: WabColors.muted2, fontSize: 12)),
                    onTap: () => Navigator.of(ctx)
                        .push(MaterialPageRoute(
                            builder: (_) => ChatScreen(
                                customerId: '${c['id']}',
                                customerName: name,
                                botPaused: paused)))
                        .then((_) => setState(() => _reloadKey++)),
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
