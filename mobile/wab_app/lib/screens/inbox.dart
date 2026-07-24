import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../services/offline_cache.dart';
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
  bool _offline = false;
  final _searchCtrl = TextEditingController();

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    try {
      final res = await session.api.get('/api/conversations',
          query: {'business_id': session.businessId, 'limit': 100});
      final conversations =
          ((res['conversations'] as List?) ?? []).cast<Map<String, dynamic>>();
      unawaited(OfflineCache.saveConversations(conversations));
      if (mounted) setState(() => _offline = false);
      return conversations;
    } catch (e) {
      final cached = await OfflineCache.loadConversations();
      if (cached != null) {
        if (mounted) setState(() => _offline = true);
        return cached;
      }
      rethrow;
    }
  }

  Future<void> _togglePause(String customerId, bool currentlyPaused) async {
    final action = currentlyPaused ? 'resume' : 'pause';
    HapticFeedback.lightImpact();
    try {
      await context.read<Session>().api.post('/api/conversations/$customerId/$action');
      if (mounted) setState(() => _reloadKey++);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message))));
      }
    }
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
          if (_offline) const OfflineBanner(),
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
                final tile = Card(
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
                            child: Tooltip(
                              message: 'Bot paused for this conversation',
                              child: Icon(Icons.front_hand_rounded,
                                  size: 16, color: WabColors.warning),
                            ),
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
                            color: WabColors.muted, fontSize: 12)),
                    onTap: () => Navigator.of(ctx)
                        .push(MaterialPageRoute(
                            builder: (_) => ChatScreen(
                                customerId: '${c['id']}',
                                customerName: name,
                                botPaused: paused)))
                        .then((_) => setState(() => _reloadKey++)),
                  ),
                );
                return Dismissible(
                  key: ValueKey('inbox-swipe-${c['id']}'),
                  direction: DismissDirection.startToEnd,
                  background: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    alignment: Alignment.centerLeft,
                    decoration: BoxDecoration(
                        color: paused
                            ? WabColors.accentSoft
                            : WabColors.warning.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(14)),
                    child: Row(children: [
                      Icon(
                          paused
                              ? Icons.smart_toy_outlined
                              : Icons.front_hand_rounded,
                          color: paused
                              ? WabColors.accentInk
                              : WabColors.warning),
                      const SizedBox(width: 8),
                      Text(paused ? 'Resume bot' : 'Take over',
                          style: TextStyle(
                              color: paused
                                  ? WabColors.accentInk
                                  : WabColors.warning,
                              fontWeight: FontWeight.w700)),
                    ]),
                  ),
                  confirmDismiss: (_) async {
                    await _togglePause('${c['id']}', paused);
                    return false; // reveal the action, never remove the row
                  },
                  child: tile,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
