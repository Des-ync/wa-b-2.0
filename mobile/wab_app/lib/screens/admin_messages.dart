import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// All inbound and outbound traffic through the server, live across every
/// tenant, with direction / search filters.
class AdminMessagesTab extends StatefulWidget {
  const AdminMessagesTab({super.key});

  @override
  State<AdminMessagesTab> createState() => _AdminMessagesTabState();
}

class _AdminMessagesTabState extends State<AdminMessagesTab> {
  String _direction = 'all'; // all | inbound | outbound
  String _search = '';
  Timer? _debounce;
  int _reloadKey = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onSearch(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 450), () {
      if (mounted)
        setState(() {
          _search = value.trim();
          _reloadKey++;
        });
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: TextField(
            onChanged: _onSearch,
            decoration: InputDecoration(
              labelText: 'Search messages',
              hintText: 'Search message text…',
              prefixIcon: const Icon(Icons.search_rounded, size: 20),
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: WabColors.line)),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'all', label: Text('All')),
              ButtonSegment(
                  value: 'inbound',
                  label: Text('Inbound'),
                  icon: Icon(Icons.call_received_rounded, size: 16)),
              ButtonSegment(
                  value: 'outbound',
                  label: Text('Outbound'),
                  icon: Icon(Icons.call_made_rounded, size: 16)),
            ],
            selected: {_direction},
            onSelectionChanged: (s) => setState(() {
              _direction = s.first;
              _reloadKey++;
            }),
          ),
        ),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey(_reloadKey),
            child: AsyncList<Map<String, dynamic>>(
              load: () async {
                final res = await context
                    .read<Session>()
                    .api
                    .get('/api/admin/messages', query: {
                  'limit': 150,
                  if (_direction != 'all') 'direction': _direction,
                  if (_search.isNotEmpty) 'q': _search,
                });
                return ((res['messages'] as List?) ?? [])
                    .cast<Map<String, dynamic>>();
              },
              emptyTitle: 'No messages',
              emptySubtitle: 'Traffic will appear here as customers chat.',
              emptyIcon: Icons.forum_rounded,
              itemBuilder: (ctx, m) {
                final inbound = m['direction'] == 'inbound';
                return Card(
                  child: ListTile(
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                    leading: Semantics(
                      label: inbound ? 'Inbound message' : 'Outbound message',
                      child: CircleAvatar(
                        radius: 16,
                        backgroundColor: inbound
                            ? WabColors.gold.withValues(alpha: 0.15)
                            : WabColors.accentSoft,
                        child: Icon(
                          inbound
                              ? Icons.call_received_rounded
                              : Icons.call_made_rounded,
                          size: 16,
                          color:
                              inbound ? WabColors.goldInk : WabColors.accentInk,
                        ),
                      ),
                    ),
                    title: Text('${m['content'] ?? '[${m['message_type']}]'}',
                        maxLines: 2, overflow: TextOverflow.ellipsis),
                    subtitle: Text(
                      '${m['business_name'] ?? 'Platform'} · '
                      '${m['customer_name'] ?? m['customer_phone'] ?? ''} · '
                      '${timeAgo(m['created_at'])}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: WabColors.muted, fontSize: 12.5),
                    ),
                    trailing: StatusChip('${m['status']}'),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}
