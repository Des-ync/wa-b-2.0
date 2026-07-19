import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class AdminHomeScreen extends StatefulWidget {
  const AdminHomeScreen({super.key});

  @override
  State<AdminHomeScreen> createState() => _AdminHomeScreenState();
}

class _AdminHomeScreenState extends State<AdminHomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    const pages = [_AdminStats(), _AdminBusinesses(), _AdminBilling()];
    return Scaffold(
      appBar: AppBar(
        title: const Text('WA-B Admin'),
        actions: [
          IconButton(
            onPressed: () async {
              final confirm = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Sign out?'),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: const Text('Cancel')),
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text('Sign out',
                            style: TextStyle(color: WabColors.danger))),
                  ],
                ),
              );
              if (confirm == true && context.mounted) {
                await context.read<Session>().logout();
              }
            },
            icon: const Icon(Icons.logout_rounded),
          ),
        ],
      ),
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.dashboard_outlined),
              selectedIcon: Icon(Icons.dashboard_rounded),
              label: 'Overview'),
          NavigationDestination(
              icon: Icon(Icons.storefront_outlined),
              selectedIcon: Icon(Icons.storefront_rounded),
              label: 'Businesses'),
          NavigationDestination(
              icon: Icon(Icons.payments_outlined),
              selectedIcon: Icon(Icons.payments_rounded),
              label: 'Billing'),
        ],
      ),
    );
  }
}

class _AdminStats extends StatefulWidget {
  const _AdminStats();

  @override
  State<_AdminStats> createState() => _AdminStatsState();
}

class _AdminStatsState extends State<_AdminStats> {
  Map<String, dynamic>? _stats;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final res = await context.read<Session>().api.get('/api/admin/stats');
      if (mounted) setState(() => _stats = res['stats'] as Map<String, dynamic>?);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return ErrorRetry(message: _error!, onRetry: _load);
    final s = _stats;
    if (s == null) {
      return const Center(child: CircularProgressIndicator(color: WabColors.accent));
    }
    final tiles = [
      ('MRR this month', ghs(s['mrr_ghs_this_month'] ?? 0), WabColors.accentInk),
      ('Total GMV', ghs(s['gmv_ghs'] ?? 0), WabColors.ink),
      ('Businesses', '${s['businesses_total'] ?? 0}', WabColors.ink),
      ('Active', '${s['businesses_active'] ?? 0}', WabColors.accentInk),
      ('On trial', '${s['businesses_trial'] ?? 0}', WabColors.warning),
      ('Suspended', '${s['businesses_suspended'] ?? 0}', WabColors.danger),
      ('Active subs', '${s['subscriptions_active'] ?? 0}', WabColors.accentInk),
      ('In grace', '${s['subscriptions_grace'] ?? 0}', WabColors.warning),
      ('Customers', '${s['customers_total'] ?? 0}', WabColors.ink),
      ('Orders (paid)', '${s['orders_paid'] ?? 0}/${s['orders_total'] ?? 0}',
          WabColors.ink),
      ('Msgs (24h)', '${s['messages_last_24h'] ?? 0}', WabColors.ink),
      ('Products', '${s['products_total'] ?? 0}', WabColors.ink),
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
                            style: TextStyle(
                                fontSize: 21,
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

class _AdminBusinesses extends StatelessWidget {
  const _AdminBusinesses();

  @override
  Widget build(BuildContext context) {
    return AsyncList<Map<String, dynamic>>(
      load: () async {
        final res = await context
            .read<Session>()
            .api
            .get('/api/admin/businesses', query: {'limit': 200});
        return ((res['businesses'] as List?) ?? []).cast<Map<String, dynamic>>();
      },
      emptyTitle: 'No businesses yet',
      emptyIcon: Icons.storefront_rounded,
      itemBuilder: (ctx, b) => Card(
        child: ListTile(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          title: Text('${b['name']}',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
              '${b['whatsapp_number'] ?? ''} · ${b['industry'] ?? ''} · joined ${timeAgo(b['created_at'])}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: WabColors.muted)),
          trailing: StatusChip('${b['status']}'),
        ),
      ),
    );
  }
}

class _AdminBilling extends StatelessWidget {
  const _AdminBilling();

  @override
  Widget build(BuildContext context) {
    return AsyncList<Map<String, dynamic>>(
      load: () async {
        final res = await context
            .read<Session>()
            .api
            .get('/api/admin/billing', query: {'limit': 100});
        return ((res['transactions'] as List?) ?? []).cast<Map<String, dynamic>>();
      },
      emptyTitle: 'No billing activity',
      emptyIcon: Icons.payments_rounded,
      itemBuilder: (ctx, t) => Card(
        child: ListTile(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
              const SizedBox(height: 4),
              StatusChip('${t['status']}'),
            ],
          ),
        ),
      ),
    );
  }
}
