import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/segments_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'broadcasts.dart';
import 'customers.dart';

/// Who your customers are, grouped.
///
/// The summary endpoint had no client anywhere. Shipping it as three numbers
/// would have missed the point: the same filter spec that produces these
/// counts (`segment`, `tag`) is what the customer list and broadcast
/// targeting already take, so every row here is one tap from seeing those
/// people and one tap from writing to them. That is the whole reason the
/// segment exists — a merchant does not want to know that 23 customers are
/// slipping away, they want to message those 23.
class SegmentsScreen extends StatefulWidget {
  const SegmentsScreen({super.key});

  @override
  State<SegmentsScreen> createState() => _SegmentsScreenState();
}

class _SegmentsScreenState extends State<SegmentsScreen> {
  List<Map<String, dynamic>>? _segments;
  List<Map<String, dynamic>>? _tags;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _error = null);
    try {
      final session = context.read<Session>();
      final res = await session.api.getSegmentSummary(session.businessId!);
      if (!mounted) return;
      setState(() {
        _segments =
            ((res['segments'] as List?) ?? []).cast<Map<String, dynamic>>();
        _tags = ((res['tags'] as List?) ?? []).cast<Map<String, dynamic>>();
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  void _openCustomers({String? segment, String? tag, required String label}) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) =>
          CustomersScreen(segment: segment, tag: tag, filterLabel: label),
    ));
  }

  Future<void> _broadcast({String? segment, String? tag}) async {
    final sent =
        await showBroadcastComposer(context, segment: segment, tag: tag);
    if (sent == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content:
            Semantics(liveRegion: true, child: const Text('Broadcast sent')),
        backgroundColor: WabColors.accentInk,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Segments')),
      body: _error != null
          ? ErrorRetry(message: _error!, onRetry: _load)
          : _segments == null
              ? const Center(
                  child: CircularProgressIndicator(color: WabColors.accent))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      for (final s in _segments!) ...[
                        _SegmentCard(
                          label: '${s['label']}',
                          purpose: segmentPurpose['${s['key']}'],
                          count: _count(s['count']),
                          onView: () => _openCustomers(
                              segment: '${s['key']}', label: '${s['label']}'),
                          onBroadcast: () =>
                              _broadcast(segment: '${s['key']}'),
                        ),
                        const SizedBox(height: 12),
                      ],
                      const SizedBox(height: 8),
                      _tagsCard(),
                    ],
                  ),
                ),
    );
  }

  static int _count(dynamic v) =>
      v is num ? v.toInt() : int.tryParse('$v') ?? 0;

  Widget _tagsCard() {
    final tags = _tags ?? [];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Your tags',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const SizedBox(height: 3),
            const Text(
                'Labels you put on customers yourself. Tap one to see who has it.',
                style: TextStyle(fontSize: 12.5, color: WabColors.muted)),
            const SizedBox(height: 12),
            if (tags.isEmpty)
              const Text(
                  'No tags yet. Open a customer and tag them — "wholesale", '
                  '"Kumasi", "pays late" — and they become a group you can '
                  'message.',
                  style: TextStyle(fontSize: 13, color: WabColors.muted2))
            else
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final t in tags)
                    ActionChip(
                      label: Text('${t['tag']}  ${_count(t['n'])}'),
                      backgroundColor: WabColors.accentSoft,
                      side: BorderSide.none,
                      labelStyle: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: WabColors.accentInk),
                      onPressed: () => _openCustomers(
                          tag: '${t['tag']}', label: '${t['tag']}'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _SegmentCard extends StatelessWidget {
  const _SegmentCard({
    required this.label,
    required this.purpose,
    required this.count,
    required this.onView,
    required this.onBroadcast,
  });

  final String label;
  final String? purpose;
  final int count;
  final VoidCallback onView;
  final VoidCallback onBroadcast;

  @override
  Widget build(BuildContext context) {
    // An empty segment is not a failure and should not offer actions that
    // would land on an empty list or a broadcast to nobody.
    final empty = count == 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(label,
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, fontSize: 15)),
                ),
                const SizedBox(width: 10),
                Text('$count',
                    style: TextStyle(
                        fontSize: 26,
                        fontWeight: FontWeight.w800,
                        color:
                            empty ? WabColors.muted2 : WabColors.accentInk)),
              ],
            ),
            if (purpose != null) ...[
              const SizedBox(height: 4),
              Text(purpose!,
                  style: const TextStyle(
                      fontSize: 12.5, color: WabColors.muted)),
            ],
            if (!empty) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: onView,
                      icon: const Icon(Icons.people_alt_outlined, size: 17),
                      label: const Text('See them'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: onBroadcast,
                      icon: const Icon(Icons.campaign_rounded, size: 17),
                      label: const Text('Message'),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
