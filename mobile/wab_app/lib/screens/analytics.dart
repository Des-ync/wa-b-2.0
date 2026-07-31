import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../api/analytics_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'analytics_views.dart';

/// One tab: fetches on first build, then holds its result.
///
/// [AutomaticKeepAliveClientMixin] is the point of it. Without it a
/// [TabBarView] disposes a tab as soon as you swipe away, so flicking between
/// Profit and Channels would re-download both every time — which on a metered
/// 3G connection is a real cost to the merchant, not just a slow screen.
class _AnalyticsTab extends StatefulWidget {
  const _AnalyticsTab(
      {super.key,
      required this.days,
      required this.fetch,
      required this.builder});

  final int days;
  final Future<Map<String, dynamic>> Function(Session, int) fetch;
  final Widget Function(Map<String, dynamic>) builder;

  @override
  State<_AnalyticsTab> createState() => _AnalyticsTabState();
}

class _AnalyticsTabState extends State<_AnalyticsTab>
    with AutomaticKeepAliveClientMixin {
  Map<String, dynamic>? _data;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _error = null);
    try {
      final session = context.read<Session>();
      if (session.businessId == null) return;
      final res = await widget.fetch(session, widget.days);
      if (mounted) setState(() => _data = res);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    if (_error != null) return ErrorRetry(message: _error!, onRetry: _load);
    if (_data == null) {
      return const Center(
          child: CircularProgressIndicator(color: WabColors.accent));
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: WabColors.accent,
      child: widget.builder(_data!),
    );
  }
}

/// Analytics, in five views.
///
/// The overview was the only one with a client; profit, cohorts, delivery SLA
/// and channels were all backend-complete and unreachable. They are tabs
/// rather than five more rows in the More list because they answer versions
/// of the same question and a merchant comparing them should not have to
/// navigate back out each time.
///
/// Each tab fetches only when it is first opened and then keeps its result,
/// so opening Analytics costs one request rather than five — the same reason
/// the whole app avoids speculative loading on a metered connection.
class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});

  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

const _tabs = ['overview', 'profit', 'cohorts', 'delivery', 'channels'];

class _AnalyticsScreenState extends State<AnalyticsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tab;
  int _days = 7;
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: _tabs.length, vsync: this)
      ..addListener(() {
        if (_tab.indexIsChanging) return;
        // The views do not accept the same windows. The server silently falls
        // back to its own default when handed one it does not support, so
        // carrying 90d onto a view that only does 7 and 30 would label
        // 30-day figures as 90. Clamp instead.
        final allowed = analyticsWindows[_tabs[_tab.index]]!;
        setState(() => _days = allowed.contains(_days) ? _days : allowed.last);
      });
    _load();
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _data = null;
      _error = null;
    });
    try {
      final session = context.read<Session>();
      final res = await session.api.get('/api/analytics',
          query: {'business_id': session.businessId, 'days': _days});
      if (mounted)
        setState(() => _data = res['analytics'] as Map<String, dynamic>?);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = _data;
    final allowed = analyticsWindows[_tabs[_tab.index]]!;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Analytics'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: SegmentedButton<int>(
              segments: [
                for (final d in allowed)
                  ButtonSegment(value: d, label: Text('${d}d')),
              ],
              selected: {_days},
              showSelectedIcon: false,
              onSelectionChanged: (s) {
                setState(() => _days = s.first);
                _load();
              },
              style: SegmentedButton.styleFrom(
                  selectedBackgroundColor: WabColors.accentSoft,
                  selectedForegroundColor: WabColors.accentInk,
                  visualDensity: VisualDensity.compact),
            ),
          ),
        ],
        bottom: TabBar(
          controller: _tab,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          labelColor: WabColors.accentInk,
          unselectedLabelColor: WabColors.muted,
          indicatorColor: WabColors.accent,
          tabs: const [
            Tab(text: 'Overview'),
            Tab(text: 'Profit'),
            Tab(text: 'Customers'),
            Tab(text: 'Delivery'),
            Tab(text: 'Channels'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tab,
        children: [
          _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : a == null
                  ? const Center(
                      child: CircularProgressIndicator(color: WabColors.accent))
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: WabColors.accent,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.all(16),
                        children: [
                          _revenueCard(a),
                          const SizedBox(height: 16),
                          _kpiRow(a),
                          const SizedBox(height: 16),
                          _topProducts(a),
                          const SizedBox(height: 16),
                          _busiestHours(a),
                        ],
                      ),
                    ),
          _AnalyticsTab(
            key: ValueKey('profit-$_days'),
            days: _days,
            fetch: (s, d) => s.api.getProfit(s.businessId!, days: d),
            builder: (res) => profitView(res),
          ),
          _AnalyticsTab(
            key: ValueKey('cohorts-$_days'),
            days: _days,
            fetch: (s, d) => s.api.getCohorts(s.businessId!, days: d),
            builder: (res) => cohortsView(res),
          ),
          _AnalyticsTab(
            key: ValueKey('delivery-$_days'),
            days: _days,
            fetch: (s, d) => s.api.getDeliverySla(s.businessId!, days: d),
            builder: (res) => deliveryView(res),
          ),
          _AnalyticsTab(
            key: ValueKey('channels-$_days'),
            days: _days,
            fetch: (s, d) => s.api.getChannels(s.businessId!, days: d),
            builder: (res) => channelsView(res),
          ),
        ],
      ),
    );
  }

  Widget _revenueCard(Map<String, dynamic> a) {
    final trend =
        ((a['revenue_trend'] as List?) ?? []).cast<Map<String, dynamic>>();
    final total = trend.fold<double>(
        0, (sum, d) => sum + (double.tryParse('${d['gmv_ghs']}') ?? 0));
    final maxV = trend.fold<double>(
        1,
        (m, d) => (double.tryParse('${d['gmv_ghs']}') ?? 0) > m
            ? double.parse('${d['gmv_ghs']}')
            : m);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Revenue',
                style: TextStyle(color: WabColors.muted, fontSize: 13)),
            const SizedBox(height: 4),
            Text(ghs(total),
                style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                    color: WabColors.accentInk)),
            const SizedBox(height: 16),
            SizedBox(
              height: 120,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: trend.map((d) {
                  final v = double.tryParse('${d['gmv_ghs']}') ?? 0;
                  final h = maxV <= 0 ? 0.0 : (v / maxV) * 100;
                  return Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 2),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Container(
                            height: h.clamp(3, 100),
                            decoration: BoxDecoration(
                              color: v > 0 ? WabColors.accent : WabColors.line,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                          if (trend.length <= 10) ...[
                            const SizedBox(height: 6),
                            Text(
                              _dayLabel(d['date']),
                              style: const TextStyle(
                                  fontSize: 10, color: WabColors.muted),
                            ),
                          ],
                        ],
                      ),
                    ),
                  );
                }).toList(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _dayLabel(dynamic date) {
    final dt = DateTime.tryParse('$date');
    return dt == null ? '' : DateFormat('E').format(dt)[0];
  }

  Widget _kpiRow(Map<String, dynamic> a) {
    final ab = (a['cart_abandonment'] as Map?) ?? {};
    final nu = (a['nudge_recovery'] as Map?) ?? {};
    final kpis = [
      (
        'Repeat customers',
        a['repeat_customer_rate_pct'] != null
            ? '${a['repeat_customer_rate_pct']}%'
            : '—'
      ),
      ('Active customers', '${a['active_customers'] ?? 0}'),
      (
        'Cart abandonment',
        ab['abandonment_rate_pct'] != null
            ? '${ab['abandonment_rate_pct']}%'
            : '—'
      ),
      (
        'Nudge recovery',
        nu['recovery_rate_pct'] != null ? '${nu['recovery_rate_pct']}%' : '—'
      ),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 2.1,
      children: kpis
          .map((k) => Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(k.$2,
                          style: const TextStyle(
                              fontSize: 20, fontWeight: FontWeight.w800)),
                      Text(k.$1,
                          style: const TextStyle(
                              fontSize: 12, color: WabColors.muted)),
                    ],
                  ),
                ),
              ))
          .toList(),
    );
  }

  Widget _topProducts(Map<String, dynamic> a) {
    final top =
        ((a['top_products'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Top products',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const SizedBox(height: 8),
            if (top.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('No paid orders in this period yet.',
                    style: TextStyle(color: WabColors.muted)),
              )
            else
              ...top.take(5).map((p) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      children: [
                        Expanded(
                            child: Text('${p['name']}',
                                maxLines: 1, overflow: TextOverflow.ellipsis)),
                        Text('×${p['qty']}',
                            style: const TextStyle(color: WabColors.muted)),
                        const SizedBox(width: 12),
                        Text(ghs(p['revenue_ghs']),
                            style:
                                const TextStyle(fontWeight: FontWeight.w700)),
                      ],
                    ),
                  )),
          ],
        ),
      ),
    );
  }

  Widget _busiestHours(Map<String, dynamic> a) {
    final hours =
        ((a['busiest_hours'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Busiest hours',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const SizedBox(height: 8),
            if (hours.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('Not enough data yet.',
                    style: TextStyle(color: WabColors.muted)),
              )
            else
              ...hours.take(5).map((h) {
                final hour = int.tryParse('${h['hour']}') ?? 0;
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Expanded(
                          child: Text('${hour.toString().padLeft(2, '0')}:00')),
                      Text('${h['orders'] ?? 0} orders',
                          style: const TextStyle(color: WabColors.muted)),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }
}
