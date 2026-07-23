import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Backend control room: live server vitals, the inbound webhook queue
/// (with requeue controls) and SaaS billing activity — everything needed
/// to fix things from the road without SSH.
class AdminOpsTab extends StatefulWidget {
  const AdminOpsTab({super.key});

  @override
  State<AdminOpsTab> createState() => _AdminOpsTabState();
}

class _AdminOpsTabState extends State<AdminOpsTab> {
  String _section = 'health'; // health | webhooks | billing

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: SegmentedButton<String>(
            segments: const [
              ButtonSegment(
                  value: 'health',
                  label: Text('Health'),
                  icon: Icon(Icons.monitor_heart_rounded, size: 16)),
              ButtonSegment(
                  value: 'webhooks',
                  label: Text('Webhooks'),
                  icon: Icon(Icons.webhook_rounded, size: 16)),
              ButtonSegment(
                  value: 'billing',
                  label: Text('Billing'),
                  icon: Icon(Icons.payments_rounded, size: 16)),
            ],
            selected: {_section},
            onSelectionChanged: (s) => setState(() => _section = s.first),
          ),
        ),
        Expanded(
          child: switch (_section) {
            'webhooks' => const _WebhookQueue(),
            'billing' => const _BillingList(),
            _ => const _HealthPanel(),
          },
        ),
      ],
    );
  }
}

class _HealthPanel extends StatefulWidget {
  const _HealthPanel();

  @override
  State<_HealthPanel> createState() => _HealthPanelState();
}

class _HealthPanelState extends State<_HealthPanel> {
  Map<String, dynamic>? _health;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final res = await context.read<Session>().api.get('/api/admin/health');
      if (mounted) {
        setState(() => _health = res['health'] as Map<String, dynamic>?);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  String _uptime(int seconds) {
    final d = seconds ~/ 86400,
        h = (seconds % 86400) ~/ 3600,
        m = (seconds % 3600) ~/ 60;
    if (d > 0) return '${d}d ${h}h';
    if (h > 0) return '${h}h ${m}m';
    return '${m}m';
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return ErrorRetry(message: _error!, onRetry: _load);
    final h = _health;
    if (h == null) {
      return const Center(
          child: CircularProgressIndicator(color: WabColors.accent));
    }
    final failed = (h['webhooks_failed'] ?? 0) as num;
    final tiles = [
      (
        'DB latency',
        '${h['db_latency_ms'] ?? '—'} ms',
        (h['db_latency_ms'] ?? 0) > 250
            ? WabColors.warning
            : WabColors.accentInk
      ),
      ('Uptime', _uptime((h['uptime_seconds'] ?? 0) as int), WabColors.ink),
      ('Memory', '${h['memory_rss_mb'] ?? '—'} MB', WabColors.ink),
      ('Msgs last hour', '${h['messages_last_hour'] ?? 0}', WabColors.ink),
      (
        'Failed sends 24h',
        '${h['messages_failed_24h'] ?? 0}',
        (h['messages_failed_24h'] ?? 0) > 0
            ? WabColors.warning
            : WabColors.accentInk
      ),
      (
        'Webhooks pending',
        '${h['webhooks_pending'] ?? 0}',
        (h['webhooks_pending'] ?? 0) > 20 ? WabColors.warning : WabColors.ink
      ),
      (
        'Webhooks failed',
        '$failed',
        failed > 0 ? WabColors.danger : WabColors.accentInk
      ),
      (
        'Node',
        '${h['node_version'] ?? ''} · ${h['env'] ?? ''}',
        WabColors.muted
      ),
    ];
    return RefreshIndicator(
      onRefresh: _load,
      color: WabColors.accent,
      child: GridView.count(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        crossAxisCount: 2,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 1.7,
        children: tiles
            .map((t) => Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(t.$2,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 19,
                                fontWeight: FontWeight.w800,
                                color: t.$3)),
                        const SizedBox(height: 2),
                        Text(t.$1,
                            style: const TextStyle(
                                fontSize: 12.5, color: WabColors.muted)),
                      ],
                    ),
                  ),
                ))
            .toList(),
      ),
    );
  }
}

class _WebhookQueue extends StatefulWidget {
  const _WebhookQueue();

  @override
  State<_WebhookQueue> createState() => _WebhookQueueState();
}

class _WebhookQueueState extends State<_WebhookQueue> {
  String _status = 'failed';
  int _reloadKey = 0;

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

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final s in [
                        'failed',
                        'pending',
                        'processing',
                        'done'
                      ])
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(s),
                            selected: _status == s,
                            onSelected: (_) => setState(() {
                              _status = s;
                              _reloadKey++;
                            }),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (_status == 'failed')
                IconButton(
                    onPressed: _retryAll,
                    tooltip: 'Retry all failed',
                    icon: const Icon(Icons.replay_rounded,
                        color: WabColors.accentInk)),
            ],
          ),
        ),
        Expanded(
          child: KeyedSubtree(
            key: ValueKey('$_status-$_reloadKey'),
            child: AsyncList<Map<String, dynamic>>(
              load: () async {
                final res = await context.read<Session>().api.get(
                    '/api/admin/webhooks',
                    query: {'status': _status, 'limit': 100});
                return ((res['webhooks'] as List?) ?? [])
                    .cast<Map<String, dynamic>>();
              },
              emptyTitle: 'Queue is clear',
              emptySubtitle: 'No $_status webhooks.',
              emptyIcon: Icons.webhook_rounded,
              itemBuilder: (ctx, w) => Card(
                child: ListTile(
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                  title: Text('${w['source']} · ${w['attempts']} attempt(s)',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    '${w['last_error'] ?? w['external_id'] ?? ''}\n${timeAgo(w['received_at'])}',
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style:
                        const TextStyle(color: WabColors.muted, fontSize: 12.5),
                  ),
                  trailing: w['status'] == 'failed'
                      ? IconButton(
                          tooltip: 'Retry webhook',
                          icon: const Icon(Icons.replay_rounded,
                              color: WabColors.accentInk),
                          onPressed: () async {
                            try {
                              await context
                                  .read<Session>()
                                  .api
                                  .post('/api/admin/webhooks/${w['id']}/retry');
                              if (context.mounted) {
                                setState(() => _reloadKey++);
                              }
                            } catch (_) {}
                          },
                        )
                      : StatusChip('${w['status']}'),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _BillingList extends StatelessWidget {
  const _BillingList();

  @override
  Widget build(BuildContext context) {
    return AsyncList<Map<String, dynamic>>(
      load: () async {
        final res = await context
            .read<Session>()
            .api
            .get('/api/admin/billing', query: {'limit': 100});
        return ((res['transactions'] as List?) ?? [])
            .cast<Map<String, dynamic>>();
      },
      emptyTitle: 'No billing activity',
      emptyIcon: Icons.payments_rounded,
      itemBuilder: (ctx, t) => Card(
        child: ListTile(
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          title: Text('${t['business_name'] ?? t['business_id'] ?? ''}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
              '${t['gateway'] ?? ''} · ${timeAgo(t['initiated_at'] ?? t['created_at'])}',
              style: const TextStyle(color: WabColors.muted)),
          trailing: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(ghs(t['amount_ghs']),
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, fontSize: 15)),
              const SizedBox(height: 4),
              StatusChip('${t['status']}'),
            ],
          ),
        ),
      ),
    );
  }
}
