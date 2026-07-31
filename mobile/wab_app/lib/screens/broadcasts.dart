import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/broadcast_api.dart';
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

/// Opens the broadcast composer already aimed at an audience.
///
/// Exists so the Segments screen can go straight from "23 customers are
/// slipping away" to writing to those 23 — the filter spec is the same one
/// the composer already sends, so this passes it rather than asking the
/// merchant to re-pick a segment they just tapped.
Future<bool?> showBroadcastComposer(BuildContext context,
    {String? segment, String? tag}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _ComposeSheet(initialSegment: segment, initialTag: tag),
  );
}

class _ComposeSheet extends StatefulWidget {
  const _ComposeSheet({this.initialSegment, this.initialTag});

  final String? initialSegment;
  final String? initialTag;

  @override
  State<_ComposeSheet> createState() => _ComposeSheetState();
}

class _ComposeSheetState extends State<_ComposeSheet> {
  final _bodyCtrl = TextEditingController();
  final _tagCtrl = TextEditingController();
  final _minSpendCtrl = TextEditingController();
  String? _segment;
  bool _sending = false;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    _segment = widget.initialSegment;
    if (widget.initialTag != null) _tagCtrl.text = widget.initialTag!;
  }

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

  Map<String, dynamic> _audience() => {
        if (_segment != null) 'segment': _segment,
        if (_tagCtrl.text.trim().isNotEmpty) 'tag': _tagCtrl.text.trim(),
        if (_minSpendCtrl.text.trim().isNotEmpty)
          'min_spend_ghs': double.tryParse(_minSpendCtrl.text.trim()),
      };

  /// Ask the server who this would reach, and make the merchant confirm.
  ///
  /// The count is the point: "inactive 60+ days" could be four people or four
  /// thousand, and the merchant has no way to tell from the filter alone.
  Future<bool> _confirmAudience() async {
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return false;

    Map<String, dynamic> preview;
    try {
      preview = await session.api.previewBroadcast(bid, audience: _audience());
    } catch (e) {
      // Never block a send on the preview failing — but say so, rather than
      // letting the merchant think they saw a count they didn't.
      if (!mounted) return false;
      return await _confirmDialog(
        title: 'Send without a preview?',
        body: "We couldn't check how many customers this reaches.\n\n$e",
        confirmLabel: 'Send anyway',
      );
    }
    if (!mounted) return false;

    final count = (preview['recipient_count'] as num?)?.toInt() ?? 0;
    final optedOut = (preview['opted_out_count'] as num?)?.toInt() ?? 0;
    final desc = '${preview['audience_desc'] ?? 'your customers'}';

    if (count == 0) {
      _toast('Nobody matches that audience — nothing would be sent.', error: true);
      return false;
    }
    return _confirmDialog(
      title: 'Send to $count customer${count == 1 ? '' : 's'}?',
      body: '$desc.\n\n'
          '${optedOut > 0 ? '$optedOut matching customer${optedOut == 1 ? ' has' : 's have'} opted out and will not be included.\n\n' : ''}'
          'This cannot be undone once it starts sending.',
      confirmLabel: 'Send now',
    );
  }

  Future<bool> _confirmDialog({
    required String title, required String body, required String confirmLabel,
  }) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(confirmLabel)),
        ],
      ),
    );
    return ok == true;
  }

  /// Send the draft to the merchant's own number so they can read it as a
  /// customer will. Catches the typo, not the bug.
  Future<void> _sendTest() async {
    final text = _bodyCtrl.text.trim();
    if (text.isEmpty) {
      _toast('Write your message first.', error: true);
      return;
    }
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;
    setState(() => _testing = true);
    try {
      final res = await session.api.sendBroadcastTest(bid, body: text);
      if (mounted) _toast('Test sent to ${res['sent_to'] ?? 'your WhatsApp'}.');
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: error ? WabColors.danger : WabColors.accentInk,
    ));
  }

  Future<void> _send() async {
    final text = _bodyCtrl.text.trim();
    if (text.isEmpty) return;
    // Preview and confirm BEFORE anything is created — the fan-out starts the
    // instant the broadcast row exists.
    if (!await _confirmAudience()) return;
    if (!mounted) return;
    setState(() => _sending = true);
    final session = context.read<Session>();
    try {
      final audience = _audience();
      final res = await session.api.post('/api/broadcasts', body: {
        'business_id': session.businessId,
        'body': text,
        if (audience.isNotEmpty) 'audience': audience,
      });
      if (mounted) {
        Navigator.pop(context, true);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(
                liveRegion: true,
                child: Text(
                    'Broadcast queued to ${res['target_count']} customer(s)'))));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
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
                    color: WabColors.muted)),
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
                  labelText: 'Message',
                  hintText:
                      'e.g. Fresh stock just arrived! Reply MENU to see what\'s new 🎉'),
            ),
            const SizedBox(height: 8),
            const Text('Send to',
                style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                    color: WabColors.muted)),
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
                style: TextStyle(color: WabColors.muted, fontSize: 12)),
            const SizedBox(height: 16),
            // Reading the draft as a customer will is the cheapest way to
            // catch a typo or a missing price — none of which is recoverable
            // once the fan-out starts.
            OutlinedButton.icon(
              onPressed: (_sending || _testing) ? null : _sendTest,
              icon: _testing
                  ? const SizedBox(
                      width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.send_rounded, size: 18),
              label: Text(_testing ? 'Sending test…' : 'Send a test to myself'),
            ),
            const SizedBox(height: 10),
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
