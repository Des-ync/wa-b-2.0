import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});

  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  int _days = 7;
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Analytics'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 7, label: Text('7d')),
                ButtonSegment(value: 30, label: Text('30d')),
              ],
              selected: {_days},
              onSelectionChanged: (s) {
                _days = s.first;
                _load();
              },
              style: SegmentedButton.styleFrom(
                  selectedBackgroundColor: WabColors.accentSoft,
                  selectedForegroundColor: WabColors.accentInk,
                  visualDensity: VisualDensity.compact),
            ),
          ),
        ],
      ),
      body: _error != null
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
