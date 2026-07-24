import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/notifications_api.dart';
import '../api/onboarding_api.dart';
import '../services/offline_cache.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'notifications.dart';
import 'onboarding_checklist.dart';
import 'order_detail.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _stats;
  List<dynamic> _recentOrders = [];
  List<dynamic> _lowStock = [];
  int _unreadNotifications = 0;
  Map<String, dynamic>? _onboarding;
  String? _error;
  bool _loading = true;
  bool _offline = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;
    setState(() {
      _loading = _stats == null;
      _error = null;
    });
    try {
      final results = await Future.wait([
        session.api.get('/api/orders/stats/today', query: {'business_id': bid}),
        session.api
            .get('/api/orders', query: {'business_id': bid, 'limit': 10}),
        session.api.get('/api/inventory/reorder-suggestions',
            query: {'business_id': bid}),
        session.api.getNotifications(bid, limit: 1),
        // A banner about setup progress is a nice-to-have, not core to the
        // Today view — a failure here must never blank out the rest of it.
        session.api
            .getOnboardingStatus(bid)
            .catchError((_) => <String, dynamic>{}),
      ]);
      if (!mounted) return;
      setState(() {
        _stats = results[0]['stats'] as Map<String, dynamic>?;
        _recentOrders = (results[1]['orders'] as List?) ?? [];
        _lowStock = (results[2]['suggestions'] as List?) ?? [];
        _unreadNotifications =
            (results[3]['unread_count'] as num?)?.toInt() ?? 0;
        _onboarding = results[4];
        _loading = false;
        _offline = false;
      });
      unawaited(OfflineCache.saveHomeSnapshot(
        stats: _stats ?? {},
        recentOrders: _recentOrders,
        lowStock: _lowStock,
        unreadNotifications: _unreadNotifications,
      ));
    } catch (e) {
      if (!mounted) return;
      final cached = await OfflineCache.loadHomeSnapshot();
      if (cached != null) {
        setState(() {
          _stats = cached['stats'] as Map<String, dynamic>?;
          _recentOrders = (cached['recent_orders'] as List?) ?? [];
          _lowStock = (cached['low_stock'] as List?) ?? [];
          _unreadNotifications =
              (cached['unread_notifications'] as num?)?.toInt() ?? 0;
          _loading = false;
          _offline = true;
        });
        return;
      }
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _openNotifications() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const NotificationsScreen()));
    _load();
  }

  void _showLowStockSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: WabColors.bg,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        maxChildSize: 0.9,
        expand: false,
        builder: (_, scrollCtrl) => Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Low stock',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              const Text('At or below their reorder threshold',
                  style: TextStyle(
                      color: WabColors.muted, fontWeight: FontWeight.w600)),
              const SizedBox(height: 16),
              Expanded(
                child: _lowStock.isEmpty
                    ? const Center(
                        child: EmptyState(
                            icon: Icons.inventory_2_rounded,
                            title: 'Nothing low right now'))
                    : ListView.separated(
                        controller: scrollCtrl,
                        itemCount: _lowStock.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final p = _lowStock[i] as Map<String, dynamic>;
                          final qty = p['stock_qty'];
                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text('${p['name']}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700)),
                            subtitle: Text(
                                p['supplier_name'] != null
                                    ? 'Supplier: ${p['supplier_name']}'
                                    : 'No supplier on file',
                                style: const TextStyle(
                                    color: WabColors.muted, fontSize: 13)),
                            trailing: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text('$qty left',
                                    style: const TextStyle(
                                        fontWeight: FontWeight.w800,
                                        color: WabColors.warning)),
                                Text('reorder ${p['suggested_reorder_qty']}',
                                    style: const TextStyle(
                                        color: WabColors.muted, fontSize: 12)),
                              ],
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final name = session.business?['name']?.toString() ?? 'Your shop';
    final status = session.business?['status']?.toString();

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(name),
            const Text('Today',
                style: TextStyle(
                    fontSize: 13,
                    color: WabColors.muted,
                    fontWeight: FontWeight.w500)),
          ],
        ),
        toolbarHeight: 68,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Badge(
              label: Text('$_unreadNotifications'),
              isLabelVisible: _unreadNotifications > 0,
              child: IconButton(
                tooltip: 'Notifications',
                onPressed: _openNotifications,
                icon: const Icon(Icons.notifications_outlined),
              ),
            ),
          ),
          if (status != null)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(child: StatusChip(status)),
            ),
        ],
      ),
      body: _loading
          ? _loadingBody()
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (_offline) ...[
                        const OfflineBanner(),
                        const SizedBox(height: 16),
                      ],
                      if (_onboarding?['all_complete'] == false) ...[
                        _setupBanner(),
                        const SizedBox(height: 16),
                      ],
                      _statGrid(),
                      const SizedBox(height: 24),
                      const Text('Recent orders',
                          style: TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w800,
                              color: WabColors.ink)),
                      const SizedBox(height: 12),
                      if (_recentOrders.isEmpty)
                        const Padding(
                          padding: EdgeInsets.only(top: 32),
                          child: EmptyState(
                              icon: Icons.receipt_long_rounded,
                              title: 'No orders yet today',
                              subtitle:
                                  'When customers order on WhatsApp, they show up here instantly.'),
                        )
                      else
                        ..._recentOrders.map((o) => Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _orderTile(o as Map<String, dynamic>),
                            )),
                    ],
                  ),
                ),
    );
  }

  /// Mirrors _statGrid + a few recent-order rows so the first paint reads as
  /// "content on the way" instead of a bare spinner — same idea as
  /// AsyncList's SkeletonCard, sized for this screen's own layout.
  Widget _loadingBody() {
    Widget block({double height = 66}) => Container(
          height: height,
          decoration: BoxDecoration(
            color: WabColors.paper,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: WabColors.line),
          ),
        );
    return ListView(
      physics: const NeverScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
              color: WabColors.ink, borderRadius: BorderRadius.circular(20)),
          child: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Skeleton(width: 90, height: 12),
              SizedBox(height: 10),
              Skeleton(width: 140, height: 30),
            ],
          ),
        ),
        const SizedBox(height: 10),
        block(),
        const SizedBox(height: 10),
        block(),
        const SizedBox(height: 24),
        const Skeleton(width: 120, height: 17),
        const SizedBox(height: 12),
        const SkeletonCard(),
        const SizedBox(height: 10),
        const SkeletonCard(),
        const SizedBox(height: 10),
        const SkeletonCard(),
      ],
    );
  }

  Widget _setupBanner() {
    final completed = _onboarding?['completed_count'] ?? 0;
    final total = _onboarding?['total_count'] ?? 0;
    return Material(
      color: WabColors.accentSoft,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () async {
          await Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => const OnboardingChecklistScreen()));
          _load();
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Icon(Icons.checklist_rounded, color: WabColors.accentInk),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Finish setting up your shop',
                        style: TextStyle(
                            fontWeight: FontWeight.w800,
                            color: WabColors.accentInk)),
                    Text('$completed of $total steps complete',
                        style: const TextStyle(
                            color: WabColors.accentInk, fontSize: 13)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded,
                  color: WabColors.accentInk),
            ],
          ),
        ),
      ),
    );
  }

  /// Hero metric card (sales today, forest ink + gold) over a compact strip
  /// of the three counts that explain it.
  Widget _statGrid() {
    final s = _stats ?? {};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          decoration: BoxDecoration(
            color: WabColors.ink,
            borderRadius: BorderRadius.circular(20),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Sales today',
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.4,
                            color: Color(0xB3FFFFFF))),
                    const SizedBox(height: 6),
                    Text(ghs(s['gmv_ghs'] ?? 0),
                        style: const TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.w800,
                            letterSpacing: -0.8,
                            color: WabColors.gold)),
                  ],
                ),
              ),
              const KenteStrip(height: 5),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: WabColors.paper,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: WabColors.line),
          ),
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(
            children: [
              _statCell('Paid', '${s['paid_count'] ?? 0}', WabColors.accentInk),
              _divider(),
              _statCell('Awaiting', '${s['awaiting_payment'] ?? 0}',
                  WabColors.warning),
              _divider(),
              _statCell('Open', '${s['open_orders'] ?? 0}', WabColors.ink),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: WabColors.paper,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: WabColors.line),
          ),
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(
            children: [
              _statCell('New customers', '${s['new_customers_count'] ?? 0}',
                  WabColors.accentInk),
              _divider(),
              _statCell(
                'Needs reply',
                '${s['messages_needing_reply_count'] ?? 0}',
                (s['messages_needing_reply_count'] ?? 0) > 0
                    ? WabColors.warning
                    : WabColors.muted,
              ),
              _divider(),
              _statCell(
                'Low stock',
                '${_lowStock.length}',
                _lowStock.isNotEmpty ? WabColors.warning : WabColors.muted,
                onTap: _lowStock.isNotEmpty ? _showLowStockSheet : null,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _divider() => Container(width: 1, height: 34, color: WabColors.line);

  Widget _statCell(String label, String value, Color color,
      {VoidCallback? onTap}) {
    final content = Column(
      children: [
        Text(value,
            style: TextStyle(
                fontSize: 20, fontWeight: FontWeight.w800, color: color)),
        const SizedBox(height: 2),
        Text(label,
            style: const TextStyle(fontSize: 12.5, color: WabColors.muted)),
      ],
    );
    // Bare GestureDetector produces no accessibility node — screen readers
    // can't reach it. Material+InkWell gives a real semantics button plus
    // visible tap feedback.
    if (onTap == null) return Expanded(child: content);
    return Expanded(
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: content,
          ),
        ),
      ),
    );
  }

  Widget _orderTile(Map<String, dynamic> o) {
    return Card(
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: Text('#${o['order_number']}',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
            '${(o['items'] as List?)?.length ?? 0} item(s) · ${timeAgo(o['created_at'])}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: WabColors.muted)),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(ghs(o['total_ghs']),
                style:
                    const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const SizedBox(height: 4),
            StatusChip('${o['payment_status'] ?? o['status']}',
                label: paymentStatusLabel(
                    '${o['payment_status'] ?? o['status']}')),
          ],
        ),
        onTap: () => Navigator.of(context)
            .push(MaterialPageRoute(
                builder: (_) => OrderDetailScreen(orderId: '${o['id']}')))
            .then((_) => _load()),
      ),
    );
  }
}
