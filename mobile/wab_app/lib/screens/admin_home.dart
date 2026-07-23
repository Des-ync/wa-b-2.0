import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_business_detail.dart';
import 'admin_issues.dart';
import 'admin_messages.dart';
import 'admin_onboard.dart';
import 'admin_ops.dart';

class AdminHomeScreen extends StatefulWidget {
  const AdminHomeScreen({super.key});

  @override
  State<AdminHomeScreen> createState() => _AdminHomeScreenState();
}

class _AdminHomeScreenState extends State<AdminHomeScreen> {
  int _tab = 0;
  final _businessesKey = GlobalKey<_AdminBusinessesState>();

  @override
  Widget build(BuildContext context) {
    final pages = [
      const _AdminStats(),
      _AdminBusinesses(key: _businessesKey),
      const AdminMessagesTab(),
      const AdminIssuesTab(),
      const AdminOpsTab(),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Text('WA-B Admin'),
        actions: [
          IconButton(
            tooltip: 'Sign out',
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
      floatingActionButton: _tab == 1
          ? FloatingActionButton.extended(
              onPressed: () async {
                final created = await Navigator.push<bool>(
                  context,
                  MaterialPageRoute(builder: (_) => const AdminOnboardScreen()),
                );
                if (created == true) {
                  _businessesKey.currentState?.reload();
                }
              },
              backgroundColor: WabColors.accent,
              foregroundColor: Colors.white,
              icon: const Icon(Icons.add_business_rounded),
              label: const Text('Onboard'),
            )
          : null,
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
              label: 'Clients'),
          NavigationDestination(
              icon: Icon(Icons.forum_outlined),
              selectedIcon: Icon(Icons.forum_rounded),
              label: 'Messages'),
          NavigationDestination(
              icon: Icon(Icons.report_problem_outlined),
              selectedIcon: Icon(Icons.report_problem_rounded),
              label: 'Issues'),
          NavigationDestination(
              icon: Icon(Icons.tune_outlined),
              selectedIcon: Icon(Icons.tune_rounded),
              label: 'Ops'),
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
      if (mounted)
        setState(() => _stats = res['stats'] as Map<String, dynamic>?);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return ErrorRetry(message: _error!, onRetry: _load);
    final s = _stats;
    if (s == null) {
      return const Center(
          child: CircularProgressIndicator(color: WabColors.accent));
    }
    final tiles = [
      (
        'MRR this month',
        ghs(s['mrr_ghs_this_month'] ?? 0),
        WabColors.accentInk
      ),
      ('Total GMV', ghs(s['gmv_ghs'] ?? 0), WabColors.ink),
      ('Businesses', '${s['businesses_total'] ?? 0}', WabColors.ink),
      ('Active', '${s['businesses_active'] ?? 0}', WabColors.accentInk),
      ('On trial', '${s['businesses_trial'] ?? 0}', WabColors.warning),
      ('Suspended', '${s['businesses_suspended'] ?? 0}', WabColors.danger),
      ('Active subs', '${s['subscriptions_active'] ?? 0}', WabColors.accentInk),
      ('In grace', '${s['subscriptions_grace'] ?? 0}', WabColors.warning),
      ('Customers', '${s['customers_total'] ?? 0}', WabColors.ink),
      (
        'Orders (paid)',
        '${s['orders_paid'] ?? 0}/${s['orders_total'] ?? 0}',
        WabColors.ink
      ),
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

class _AdminBusinesses extends StatefulWidget {
  const _AdminBusinesses({super.key});

  @override
  State<_AdminBusinesses> createState() => _AdminBusinessesState();
}

class _AdminBusinessesState extends State<_AdminBusinesses> {
  String _search = '';
  int _reloadKey = 0;

  void reload() => setState(() => _reloadKey++);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: TextField(
            onChanged: (v) => setState(() => _search = v.trim().toLowerCase()),
            decoration: InputDecoration(
              hintText: 'Search by name, phone or industry…',
              prefixIcon: const Icon(Icons.search_rounded, size: 20),
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: WabColors.line)),
            ),
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
                    .get('/api/admin/businesses', query: {'limit': 200});
                var list = ((res['businesses'] as List?) ?? [])
                    .cast<Map<String, dynamic>>();
                if (_search.isNotEmpty) {
                  list = list.where((b) {
                    final hay =
                        '${b['name']} ${b['whatsapp_number']} ${b['industry']} ${b['owner_name']}'
                            .toLowerCase();
                    return hay.contains(_search);
                  }).toList();
                }
                return list;
              },
              emptyTitle: _search.isEmpty ? 'No businesses yet' : 'No matches',
              emptySubtitle: _search.isEmpty
                  ? 'Tap Onboard to sign up your first client.'
                  : '',
              emptyIcon: Icons.storefront_rounded,
              itemBuilder: (ctx, b) => Card(
                child: ListTile(
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                  title: Text('${b['name']}',
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                      '${b['whatsapp_number'] ?? ''} · ${b['industry'] ?? ''} · joined ${timeAgo(b['created_at'])}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: WabColors.muted)),
                  trailing: StatusChip('${b['status']}'),
                  onTap: () async {
                    await Navigator.push(
                      ctx,
                      MaterialPageRoute(
                          builder: (_) => AdminBusinessDetailScreen(
                              businessId: '${b['id']}')),
                    );
                    reload();
                  },
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
