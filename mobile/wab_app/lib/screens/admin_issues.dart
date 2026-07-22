import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/onboarding_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_incomplete_setup.dart';

/// Live problem feed: server errors, failed/stuck webhooks, failed message
/// sends and failed billing charges — with one-tap retries where possible.
class AdminIssuesTab extends StatefulWidget {
  const AdminIssuesTab({super.key});

  @override
  State<AdminIssuesTab> createState() => _AdminIssuesTabState();
}

class _AdminIssuesTabState extends State<AdminIssuesTab> {
  int _reloadKey = 0;
  int? _incompleteSetupCount;

  @override
  void initState() {
    super.initState();
    _loadIncompleteCount();
  }

  Future<void> _loadIncompleteCount() async {
    try {
      final res = await context.read<Session>().api.getIncompleteSetupBusinesses();
      if (mounted) {
        setState(() => _incompleteSetupCount = ((res['businesses'] as List?) ?? []).length);
      }
    } catch (_) {
      // Non-fatal — the banner just doesn't show.
    }
  }

  Future<void> _retryWebhook(String id) async {
    try {
      await context.read<Session>().api.post('/api/admin/webhooks/$id/retry');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Webhook requeued ✓'),
          backgroundColor: WabColors.accentInk));
      setState(() => _reloadKey++);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  Future<void> _retryAll() async {
    try {
      final res = await context
          .read<Session>()
          .api
          .post('/api/admin/webhooks/retry-failed');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('${res['requeued'] ?? 0} webhook(s) requeued'),
          backgroundColor: WabColors.accentInk));
      setState(() => _reloadKey++);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  (IconData, Color, String) _style(String kind) => switch (kind) {
        'server_error' => (Icons.bug_report_rounded, WabColors.danger, 'Server'),
        'webhook_failed' => (Icons.webhook_rounded, WabColors.danger, 'Webhook'),
        'webhook_stuck' => (Icons.hourglass_bottom_rounded, WabColors.warning, 'Webhook'),
        'message_failed' => (Icons.sms_failed_rounded, WabColors.warning, 'Message'),
        'billing_failed' => (Icons.credit_card_off_rounded, WabColors.brick, 'Billing'),
        _ => (Icons.error_outline_rounded, WabColors.muted, 'Issue'),
      };

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if ((_incompleteSetupCount ?? 0) > 0)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: Material(
              color: WabColors.warning.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(14),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const AdminIncompleteSetupScreen())),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      const Icon(Icons.checklist_rounded, size: 18, color: WabColors.warning),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text('$_incompleteSetupCount shop(s) mid-setup',
                            style: const TextStyle(
                                fontWeight: FontWeight.w700, color: WabColors.warning)),
                      ),
                      const Icon(Icons.chevron_right_rounded, size: 18, color: WabColors.warning),
                    ],
                  ),
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Row(
            children: [
              const Text('Live issues',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const Spacer(),
              TextButton.icon(
                onPressed: _retryAll,
                icon: const Icon(Icons.replay_rounded, size: 18),
                label: const Text('Retry all failed'),
              ),
            ],
          ),
        ),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey(_reloadKey),
            child: AsyncList<Map<String, dynamic>>(
              load: () async {
                final res =
                    await context.read<Session>().api.get('/api/admin/issues');
                return ((res['issues'] as List?) ?? [])
                    .cast<Map<String, dynamic>>();
              },
              emptyTitle: 'All clear 🎉',
              emptySubtitle:
                  'No server errors, failed webhooks or failed sends right now.',
              emptyIcon: Icons.verified_rounded,
              itemBuilder: (ctx, issue) {
                final (icon, color, label) = _style('${issue['kind']}');
                final detail = issue['detail'];
                final webhookId = issue['webhook_id'];
                return Card(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(icon, size: 18, color: color),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                  color: color.withValues(alpha: 0.1),
                                  borderRadius: BorderRadius.circular(999)),
                              child: Text(label,
                                  style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w700,
                                      color: color)),
                            ),
                            const Spacer(),
                            Text(timeAgo(issue['at']),
                                style: const TextStyle(
                                    color: WabColors.muted2, fontSize: 12)),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text('${issue['title']}',
                            style:
                                const TextStyle(fontWeight: FontWeight.w600)),
                        if (detail != null && '$detail'.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text('$detail',
                              maxLines: 4,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  color: WabColors.muted,
                                  fontSize: 12.5,
                                  height: 1.35)),
                        ],
                        if (webhookId != null &&
                            issue['kind'] == 'webhook_failed') ...[
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.centerRight,
                            child: OutlinedButton.icon(
                              onPressed: () => _retryWebhook('$webhookId'),
                              icon: const Icon(Icons.replay_rounded, size: 16),
                              label: const Text('Retry'),
                              style: OutlinedButton.styleFrom(
                                  visualDensity: VisualDensity.compact),
                            ),
                          ),
                        ],
                      ],
                    ),
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
