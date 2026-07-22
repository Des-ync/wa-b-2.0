import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

// Mirrors src/utils/audience.js's SEGMENTS exactly — "who's in this segment"
// means the same thing here as it does server-side.
const _segments = <String?, String>{
  null: 'All customers',
  'ordered_30d': 'Ordered in last 30 days',
  'inactive_60d': 'Inactive for 60+ days',
  'abandoned_cart': 'Has an abandoned cart',
};

class _CampaignTemplate {
  final String label;
  final String? segment;
  final String body;
  const _CampaignTemplate(this.label, this.segment, this.body);
}

const _templates = [
  _CampaignTemplate('Recover abandoned carts', 'abandoned_cart',
      "You left something in your cart! Reply MENU to pick up where you left off 🛒"),
  _CampaignTemplate('Bring customers back', 'inactive_60d',
      "We miss you! It's been a while — come see what's new. Reply MENU to shop."),
  _CampaignTemplate('Promote slow-moving stock', null,
      "🔥 Special prices on select items this week! Reply MENU to see what's on offer."),
  _CampaignTemplate('Reward loyal customers', 'ordered_30d',
      "Thanks for being a loyal customer! Here's something special just for you 🎁"),
  _CampaignTemplate('Announce new arrivals', null,
      "✨ New arrivals just dropped! Reply MENU to check them out."),
];

class BroadcastsScreen extends StatefulWidget {
  const BroadcastsScreen({super.key});

  @override
  State<BroadcastsScreen> createState() => _BroadcastsScreenState();
}

class _BroadcastsScreenState extends State<BroadcastsScreen> {
  int _reloadKey = 0;
  String _query = '';
  final _searchCtrl = TextEditingController();

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api
        .get('/api/broadcasts', query: {'business_id': session.businessId});
    return ((res['broadcasts'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  List<Map<String, dynamic>> _filter(List<Map<String, dynamic>> items) {
    if (_query.isEmpty) return items;
    final q = _query.toLowerCase();
    return items
        .where((b) => '${b['body']}'.toLowerCase().contains(q))
        .toList();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _composeSheet() async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => const _ComposeSheet(),
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
      body: Column(
        children: [
          SearchField(
            controller: _searchCtrl,
            hint: 'Search broadcasts',
            onChanged: (v) => setState(() => _query = v),
          ),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: _load,
              transform: _filter,
              emptyFilteredTitle: 'No broadcasts match "$_query"',
              emptyTitle: 'No broadcasts yet',
              emptySubtitle: 'Re-engage your customers with a message blast.',
              emptyIcon: Icons.campaign_rounded,
              itemBuilder: (ctx, b) => Card(
                child: ListTile(
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                  title: Text('${b['body']}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontWeight: FontWeight.w600, height: 1.3)),
                  subtitle: Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (b['audience_desc'] != null)
                          Text('${b['audience_desc']}',
                              style: const TextStyle(
                                  color: WabColors.accentInk,
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600)),
                        Text(
                            '${b['sent_count'] ?? 0}/${b['target_count'] ?? 0} sent'
                            '${(b['failed_count'] ?? 0) > 0 ? ' · ${b['failed_count']} failed' : ''}'
                            ' · ${timeAgo(b['created_at'])}',
                            style: const TextStyle(color: WabColors.muted)),
                      ],
                    ),
                  ),
                  trailing: StatusChip('${b['status']}'),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ComposeSheet extends StatefulWidget {
  const _ComposeSheet();

  @override
  State<_ComposeSheet> createState() => _ComposeSheetState();
}

class _ComposeSheetState extends State<_ComposeSheet> {
  final _bodyCtrl = TextEditingController();
  final _tagCtrl = TextEditingController();
  final _minSpendCtrl = TextEditingController();
  String? _segment;
  bool _sending = false;

  @override
  void dispose() {
    _bodyCtrl.dispose();
    _tagCtrl.dispose();
    _minSpendCtrl.dispose();
    super.dispose();
  }

  void _applyTemplate(_CampaignTemplate tpl) {
    setState(() {
      _segment = tpl.segment;
      _bodyCtrl.text = tpl.body;
    });
  }

  Future<void> _send() async {
    final text = _bodyCtrl.text.trim();
    if (text.isEmpty) return;
    setState(() => _sending = true);
    final session = context.read<Session>();
    try {
      final audience = <String, dynamic>{
        if (_segment != null) 'segment': _segment,
        if (_tagCtrl.text.trim().isNotEmpty) 'tag': _tagCtrl.text.trim(),
        if (_minSpendCtrl.text.trim().isNotEmpty)
          'min_spend_ghs': double.tryParse(_minSpendCtrl.text.trim()),
      };
      final res = await session.api.post('/api/broadcasts', body: {
        'business_id': session.businessId,
        'body': text,
        if (audience.isNotEmpty) 'audience': audience,
      });
      if (mounted) {
        Navigator.pop(context, true);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(
                'Broadcast queued to ${res['target_count']} customer(s)')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('New broadcast',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 16),
            const Text('Quick start',
                style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                    color: WabColors.muted2)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final tpl in _templates)
                  ActionChip(
                    label: Text(tpl.label),
                    onPressed: () => _applyTemplate(tpl),
                    backgroundColor: WabColors.accentSoft,
                    labelStyle: const TextStyle(
                        color: WabColors.accentInk,
                        fontWeight: FontWeight.w600,
                        fontSize: 12),
                    side: BorderSide.none,
                  ),
              ],
            ),
            const SizedBox(height: 20),
            TextField(
              controller: _bodyCtrl,
              minLines: 4,
              maxLines: 8,
              maxLength: 1024,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                  hintText:
                      'e.g. Fresh stock just arrived! Reply MENU to see what\'s new 🎉'),
            ),
            const SizedBox(height: 8),
            const Text('Send to',
                style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                    color: WabColors.muted2)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final entry in _segments.entries)
                  ChoiceChip(
                    label: Text(entry.value),
                    selected: _segment == entry.key,
                    onSelected: (_) => setState(() => _segment = entry.key),
                    selectedColor: WabColors.accentSoft,
                    labelStyle: TextStyle(
                        color: _segment == entry.key
                            ? WabColors.accentInk
                            : WabColors.muted,
                        fontWeight: FontWeight.w600,
                        fontSize: 12),
                    side: const BorderSide(color: WabColors.line),
                    showCheckmark: false,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _tagCtrl,
                    decoration:
                        const InputDecoration(labelText: 'Tag (optional)'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _minSpendCtrl,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: 'Min spent GH₵ (optional)'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            const Text(
                'Only customers who haven\'t opted out are ever included. Sends are rate-limited in the background.',
                style: TextStyle(color: WabColors.muted2, fontSize: 12)),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _sending ? null : _send,
              child: _sending
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Send broadcast'),
            ),
          ],
        ),
      ),
    );
  }
}
