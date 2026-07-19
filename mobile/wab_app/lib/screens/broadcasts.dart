import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class BroadcastsScreen extends StatefulWidget {
  const BroadcastsScreen({super.key});

  @override
  State<BroadcastsScreen> createState() => _BroadcastsScreenState();
}

class _BroadcastsScreenState extends State<BroadcastsScreen> {
  int _reloadKey = 0;

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api
        .get('/api/broadcasts', query: {'business_id': session.businessId});
    return ((res['broadcasts'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _composeSheet() async {
    final bodyCtrl = TextEditingController();
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding:
            EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('New broadcast',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            const Text(
                'Goes to every customer who hasn\'t opted out. Sends are rate-limited in the background.',
                style: TextStyle(color: WabColors.muted, height: 1.4)),
            const SizedBox(height: 20),
            TextField(
              controller: bodyCtrl,
              minLines: 4,
              maxLines: 8,
              maxLength: 1024,
              autofocus: true,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                  hintText: 'e.g. Fresh stock just arrived! Reply MENU to see what\'s new 🎉'),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                final text = bodyCtrl.text.trim();
                if (text.isEmpty) return;
                final session = context.read<Session>();
                final messenger = ScaffoldMessenger.of(context);
                try {
                  final res = await session.api.post('/api/broadcasts', body: {
                    'business_id': session.businessId,
                    'body': text,
                  });
                  if (ctx.mounted) {
                    Navigator.pop(ctx, true);
                    messenger.showSnackBar(SnackBar(
                        content: Text(
                            'Broadcast queued to ${res['target_count']} customer(s)')));
                  }
                } on ApiException catch (e) {
                  if (ctx.mounted) {
                    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
                        content: Text(e.message), backgroundColor: WabColors.danger));
                  }
                }
              },
              child: const Text('Send broadcast'),
            ),
          ],
        ),
      ),
    );
    if (sent == true) setState(() => _reloadKey++);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Broadcasts')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _composeSheet,
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.campaign_rounded),
        label: const Text('New broadcast'),
      ),
      body: AsyncList<Map<String, dynamic>>(
        key: ValueKey(_reloadKey),
        load: _load,
        emptyTitle: 'No broadcasts yet',
        emptySubtitle: 'Re-engage your customers with a message blast.',
        emptyIcon: Icons.campaign_rounded,
        itemBuilder: (ctx, b) => Card(
          child: ListTile(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            title: Text('${b['body']}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w600, height: 1.3)),
            subtitle: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                  '${b['sent_count'] ?? 0}/${b['target_count'] ?? 0} sent'
                  '${(b['failed_count'] ?? 0) > 0 ? ' · ${b['failed_count']} failed' : ''}'
                  ' · ${timeAgo(b['created_at'])}',
                  style: const TextStyle(color: WabColors.muted)),
            ),
            trailing: StatusChip('${b['status']}'),
          ),
        ),
      ),
    );
  }
}
