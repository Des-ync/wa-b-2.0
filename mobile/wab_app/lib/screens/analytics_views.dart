import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/common.dart';

/// The four deeper analytics views, each a pure function of the response.
///
/// Kept as top-level builders rather than methods on the screen so they can
/// be tested against real payload shapes without a network or a controller —
/// which is where the bugs in this area have actually been: not in layout,
/// but in assuming a field's type or reading a key that does not exist.

// ─── shared pieces ─────────────────────────────────────────────────────────

/// Reads a number that may arrive as a num, a numeric string, or null.
///
/// These endpoints return real numbers, but the older accounting ones return
/// fixed-precision STRINGS for the same quantities, and mixing the two up has
/// already caused visible bugs here. Parsing defensively costs nothing.
double _num(dynamic v) =>
    v is num ? v.toDouble() : double.tryParse('$v') ?? 0;

/// Minutes as something a person reads at a glance: 95 → "1h 35m".
String durationLabel(dynamic minutes) {
  if (minutes == null) return '—';
  final m = _num(minutes).round();
  if (m < 60) return '${m}m';
  return '${m ~/ 60}h ${(m % 60).toString().padLeft(2, '0')}m';
}

/// Channel keys are stored lower-case; `null` means the order predates
/// channel tagging rather than "no channel", so it says so.
String channelLabel(dynamic channel) {
  final c = '$channel'.toLowerCase();
  return switch (c) {
    'whatsapp' => 'WhatsApp',
    'storefront' => 'Storefront',
    'instagram' => 'Instagram',
    'messenger' => 'Messenger',
    'null' || '' => 'Not recorded',
    _ => c[0].toUpperCase() + c.substring(1),
  };
}

/// An empty state that is still scrollable.
///
/// [EmptyState] is a Column, and a [RefreshIndicator] with no scrollable
/// descendant silently does nothing — so a merchant with no data yet could
/// pull to refresh forever and never trigger a reload. This keeps the gesture
/// working in exactly the case where it is most likely to be used.
Widget _empty({required IconData icon, required String title, String subtitle = ''}) {
  return ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
    children: [EmptyState(icon: icon, title: title, subtitle: subtitle)],
  );
}

Widget _card({required String title, String? subtitle, required Widget child}) {
  return Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          if (subtitle != null) ...[
            const SizedBox(height: 3),
            Text(subtitle,
                style: const TextStyle(fontSize: 12.5, color: WabColors.muted)),
          ],
          const SizedBox(height: 14),
          child,
        ],
      ),
    ),
  );
}

Widget _stat(String label, String value, {Color? tone}) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      Text(value,
          style: TextStyle(
              fontSize: 21,
              fontWeight: FontWeight.w800,
              color: tone ?? WabColors.ink)),
      const SizedBox(height: 2),
      Text(label,
          style: const TextStyle(fontSize: 12, color: WabColors.muted)),
    ],
  );
}

Widget _statGrid(List<Widget> stats) {
  return GridView.count(
    crossAxisCount: 2,
    shrinkWrap: true,
    physics: const NeverScrollableScrollPhysics(),
    mainAxisSpacing: 10,
    crossAxisSpacing: 10,
    childAspectRatio: 2.1,
    children: stats
        .map((s) => Card(
              child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: s),
            ))
        .toList(),
  );
}

/// A caveat the merchant needs in order to read the number correctly.
Widget _caveat(String text) {
  return Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: WabColors.bg2,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: WabColors.line),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.info_outline_rounded,
            size: 15, color: WabColors.muted),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text,
              style: const TextStyle(fontSize: 12.5, color: WabColors.ink2)),
        ),
      ],
    ),
  );
}

/// A proportional bar. [fraction] is already 0..1.
Widget _bar(double fraction, {Color? color}) {
  return ClipRRect(
    borderRadius: BorderRadius.circular(4),
    child: LinearProgressIndicator(
      value: fraction.clamp(0, 1),
      minHeight: 6,
      backgroundColor: WabColors.line,
      valueColor: AlwaysStoppedAnimation(color ?? WabColors.accent),
    ),
  );
}

// ─── profit ────────────────────────────────────────────────────────────────

/// Margin from what actually sold.
///
/// The honesty problem this view exists to avoid: products with no cost price
/// contribute revenue but no margin, so a naive total would understate profit
/// and look like a loss. `margin_known_pct` is therefore not a footnote — it
/// is shown next to the total, and the products missing a cost price are
/// listed so the merchant can go and fix them.
Widget profitView(Map<String, dynamic> res) {
  final p = (res['profit'] as Map?)?.cast<String, dynamic>() ?? {};
  final products =
      ((p['by_product'] as List?) ?? []).cast<Map<String, dynamic>>();
  final byDay = ((p['by_day'] as List?) ?? []).cast<Map<String, dynamic>>();

  if (products.isEmpty) {
    return _empty(
      icon: Icons.savings_outlined,
      title: 'No paid orders yet',
      subtitle: 'Once orders are paid, this shows what you actually earned '
          'after cost.',
    );
  }

  final revenue = products.fold<double>(0, (s, r) => s + _num(r['revenue_ghs']));
  final known = products.where((r) => r['cost_known'] == true);
  final margin = known.fold<double>(0, (s, r) => s + _num(r['margin_ghs']));
  // Margin % is taken against the revenue it was actually computed from, not
  // against total revenue. Dividing a known-cost profit by a total that
  // includes products with no cost price would drag the percentage down for
  // a reason that has nothing to do with the business — the shop would look
  // less profitable purely because some cost prices are missing.
  final knownRevenue =
      known.fold<double>(0, (s, r) => s + _num(r['revenue_ghs']));
  final knownPct = p['margin_known_pct'];
  final missing = products.where((r) => r['cost_known'] != true).toList();

  return ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.all(16),
    children: [
      _statGrid([
        _stat('Revenue', ghs(revenue)),
        _stat('Profit', ghs(margin), tone: WabColors.accentInk),
        _stat('Margin',
            knownRevenue > 0 ? '${(margin / knownRevenue * 100).round()}%' : '—'),
        _stat('Products sold', '${products.length}'),
      ]),
      if (knownPct != null && _num(knownPct) < 100) ...[
        const SizedBox(height: 12),
        _caveat(
            'Profit covers $knownPct% of your revenue. The rest is from '
            '${missing.length} product${missing.length == 1 ? '' : 's'} with '
            'no cost price set — add one under Stock and this gets accurate.'),
      ],
      const SizedBox(height: 16),
      if (byDay.isNotEmpty) ...[
        _card(
          title: 'Profit by day',
          child: _dayBars(byDay),
        ),
        const SizedBox(height: 16),
      ],
      _card(
        title: 'By product',
        subtitle: 'Best earners first',
        child: Column(
          children: [
            for (final r in products) ...[
              _productRow(r, revenue),
              if (r != products.last) const Divider(height: 18),
            ],
          ],
        ),
      ),
    ],
  );
}

Widget _dayBars(List<Map<String, dynamic>> byDay) {
  final maxV = byDay.fold<double>(
      1, (m, d) => _num(d['revenue_ghs']) > m ? _num(d['revenue_ghs']) : m);
  return SizedBox(
    height: 96,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: byDay.map((d) {
        final rev = _num(d['revenue_ghs']);
        // margin_ghs is null when nothing that day had a known cost — draw
        // the revenue bar but leave the margin portion empty rather than
        // showing zero profit, which would read as "you made nothing".
        final marg = d['margin_ghs'] == null ? null : _num(d['margin_ghs']);
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 1.5),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Container(
                  height: ((rev / maxV) * 80).clamp(3, 80),
                  decoration: BoxDecoration(
                    color: WabColors.accentSoft,
                    borderRadius: BorderRadius.circular(3),
                  ),
                  alignment: Alignment.bottomCenter,
                  child: marg == null || marg <= 0
                      ? null
                      : Container(
                          height: ((marg / maxV) * 80).clamp(2, 80),
                          decoration: BoxDecoration(
                            color: WabColors.accent,
                            borderRadius: BorderRadius.circular(3),
                          ),
                        ),
                ),
              ],
            ),
          ),
        );
      }).toList(),
    ),
  );
}

Widget _productRow(Map<String, dynamic> r, double totalRevenue) {
  final costKnown = r['cost_known'] == true;
  final revenue = _num(r['revenue_ghs']);
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Expanded(
            child: Text('${r['name'] ?? 'Unnamed item'}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          const SizedBox(width: 8),
          Text(costKnown ? ghs(r['margin_ghs']) : ghs(revenue),
              style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: costKnown ? WabColors.accentInk : WabColors.muted)),
        ],
      ),
      const SizedBox(height: 3),
      Row(
        children: [
          Expanded(
            child: Text(
              costKnown
                  ? '${_num(r['units_sold']).toStringAsFixed(0)} sold · '
                      '${ghs(revenue)} in · ${r['margin_pct']}% margin'
                  : '${_num(r['units_sold']).toStringAsFixed(0)} sold · '
                      'no cost price set',
              style: TextStyle(
                  fontSize: 12,
                  color: costKnown ? WabColors.muted : WabColors.warning),
            ),
          ),
        ],
      ),
      const SizedBox(height: 6),
      _bar(totalRevenue > 0 ? revenue / totalRevenue : 0,
          color: costKnown ? WabColors.accent : WabColors.muted2),
    ],
  );
}

// ─── cohorts ───────────────────────────────────────────────────────────────

/// New vs returning, and whether people come back.
///
/// The repeat rate has an eligibility rule that has to be surfaced: only
/// customers whose first order is old enough to have had a fair chance to
/// reorder are counted. With too few of those the percentage is noise, so
/// the view says "not enough history yet" instead of printing 0%.
Widget cohortsView(Map<String, dynamic> res) {
  final c = (res['cohorts'] as Map?)?.cast<String, dynamic>() ?? {};
  final fresh = (c['new_customers'] as Map?)?.cast<String, dynamic>() ?? {};
  final returning =
      (c['returning_customers'] as Map?)?.cast<String, dynamic>() ?? {};

  final newCount = _num(fresh['customers']).round();
  final retCount = _num(returning['customers']).round();

  if (newCount == 0 && retCount == 0) {
    return _empty(
      icon: Icons.groups_outlined,
      title: 'No paid customers in this period',
      subtitle: 'This compares first-time buyers with people coming back.',
    );
  }

  final total = newCount + retCount;
  final newRevenue = _num(fresh['revenue_ghs']);
  final retRevenue = _num(returning['revenue_ghs']);

  return ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.all(16),
    children: [
      _card(
        title: 'New vs returning',
        subtitle: 'By each customer\'s first ever paid order',
        child: Column(
          children: [
            _cohortRow('New customers', newCount, total, newRevenue,
                _num(fresh['orders']).round(), WabColors.accent),
            const SizedBox(height: 14),
            _cohortRow('Coming back', retCount, total, retRevenue,
                _num(returning['orders']).round(), WabColors.gold),
          ],
        ),
      ),
      const SizedBox(height: 16),
      _repeatCard('Come back within 7 days', c['repeat_rate_7d']),
      const SizedBox(height: 12),
      _repeatCard('Come back within 30 days', c['repeat_rate_30d']),
      const SizedBox(height: 12),
      _caveat(
          'Repeat rate only counts customers whose first order was long '
          'enough ago to have had a fair chance to come back.'),
    ],
  );
}

Widget _cohortRow(String label, int customers, int total, double revenue,
    int orders, Color tone) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Expanded(
              child: Text(label,
                  style: const TextStyle(fontWeight: FontWeight.w700))),
          Text('$customers',
              style: TextStyle(fontWeight: FontWeight.w800, color: tone)),
        ],
      ),
      const SizedBox(height: 4),
      Text('$orders order${orders == 1 ? '' : 's'} · ${ghs(revenue)}',
          style: const TextStyle(fontSize: 12, color: WabColors.muted)),
      const SizedBox(height: 6),
      _bar(total > 0 ? customers / total : 0, color: tone),
    ],
  );
}

Widget _repeatCard(String title, dynamic raw) {
  final r = (raw as Map?)?.cast<String, dynamic>() ?? {};
  final eligible = _num(r['eligible_customers']).round();
  final pct = r['repeat_rate_pct'];
  return Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 3),
                Text(
                  eligible == 0
                      ? 'Not enough history yet'
                      : '${_num(r['repeated_customers']).round()} of $eligible '
                          'customers',
                  style:
                      const TextStyle(fontSize: 12, color: WabColors.muted),
                ),
              ],
            ),
          ),
          Text(pct == null ? '—' : '$pct%',
              style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w800,
                  color: WabColors.accentInk)),
        ],
      ),
    ),
  );
}

// ─── delivery ──────────────────────────────────────────────────────────────

/// Time from rider assignment to delivery, and lateness against the ETA.
///
/// "Late" is only meaningful for orders that had an ETA, so the late rate is
/// computed over those alone. The view says so, because a 0% late rate that
/// really means "no ETAs were ever set" is worse than no number at all.
Widget deliveryView(Map<String, dynamic> res) {
  final d = (res['delivery_sla'] as Map?)?.cast<String, dynamic>() ?? {};
  final completed = _num(d['completed_deliveries']).round();

  if (completed == 0) {
    return _empty(
      icon: Icons.local_shipping_outlined,
      title: 'No completed deliveries yet',
      subtitle: 'Assign a rider and mark an order delivered to see how long '
          'deliveries take.',
    );
  }

  final byRider = ((d['by_rider'] as List?) ?? []).cast<Map<String, dynamic>>();
  final recent = ((d['recent'] as List?) ?? []).cast<Map<String, dynamic>>();
  final latePct = d['late_rate_pct'];

  return ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.all(16),
    children: [
      _statGrid([
        _stat('Delivered', '$completed'),
        _stat('Average time', durationLabel(d['avg_minutes_to_deliver'])),
        _stat('Late orders', '${_num(d['late_count']).round()}',
            tone: _num(d['late_count']) > 0 ? WabColors.warning : null),
        _stat('Late rate', latePct == null ? '—' : '$latePct%',
            tone: _num(latePct) > 20 ? WabColors.danger : null),
      ]),
      if (latePct == null) ...[
        const SizedBox(height: 12),
        _caveat(
            'No delivery times were promised on these orders, so nothing can '
            'count as late. Set an estimated delivery time on an order to '
            'track this.'),
      ],
      const SizedBox(height: 16),
      if (byRider.isNotEmpty) ...[
        _card(
          title: 'By rider',
          subtitle: 'Busiest first',
          child: Column(
            children: [
              for (final r in byRider) ...[
                _riderRow(r),
                if (r != byRider.last) const Divider(height: 18),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
      ],
      if (recent.isNotEmpty)
        _card(
          title: 'Recent deliveries',
          child: Column(
            children: [
              for (final r in recent) ...[
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('#${r['order_number'] ?? '—'}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w700, fontSize: 13)),
                          Text('${r['rider_name'] ?? 'No rider recorded'}',
                              style: const TextStyle(
                                  fontSize: 12, color: WabColors.muted)),
                        ],
                      ),
                    ),
                    if (r['late'] == true)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 2),
                        margin: const EdgeInsets.only(right: 8),
                        decoration: BoxDecoration(
                          color: WabColors.danger.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text('Late',
                            style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: WabColors.danger)),
                      ),
                    Text(durationLabel(r['minutes_to_deliver']),
                        style: const TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 13)),
                  ],
                ),
                if (r != recent.last) const Divider(height: 16),
              ],
            ],
          ),
        ),
    ],
  );
}

Widget _riderRow(Map<String, dynamic> r) {
  final latePct = r['late_rate_pct'];
  return Row(
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${r['rider_name']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(
                '${_num(r['deliveries']).round()} deliveries · '
                '${durationLabel(r['avg_minutes'])} average',
                style:
                    const TextStyle(fontSize: 12, color: WabColors.muted)),
          ],
        ),
      ),
      Text(latePct == null ? '—' : '$latePct% late',
          style: TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: 13,
              color: latePct != null && _num(latePct) > 20
                  ? WabColors.danger
                  : WabColors.muted)),
    ],
  );
}

// ─── channels ──────────────────────────────────────────────────────────────

/// Where orders start.
///
/// `channels` is a top-level array in this response, not nested under an
/// object like the other three — a shape difference worth not getting wrong.
Widget channelsView(Map<String, dynamic> res) {
  final channels = ((res['channels'] as List?) ?? [])
      .cast<Map<String, dynamic>>();

  if (channels.isEmpty) {
    return _empty(
      icon: Icons.hub_outlined,
      title: 'No orders in this period',
      subtitle: 'This shows whether WhatsApp, your storefront or social is '
          'bringing the orders.',
    );
  }

  final totalRevenue =
      channels.fold<double>(0, (s, c) => s + _num(c['revenue_ghs']));
  final totalOrders =
      channels.fold<int>(0, (s, c) => s + _num(c['orders']).round());

  return ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.all(16),
    children: [
      _statGrid([
        _stat('Orders', '$totalOrders'),
        _stat('Revenue', ghs(totalRevenue)),
      ]),
      const SizedBox(height: 16),
      _card(
        title: 'By channel',
        subtitle: 'Where the order started, by revenue',
        child: Column(
          children: [
            for (final c in channels) ...[
              _channelRow(c, totalRevenue),
              if (c != channels.last) const Divider(height: 18),
            ],
          ],
        ),
      ),
      const SizedBox(height: 12),
      _caveat(
          'A storefront checkout counts as Storefront even when it is the '
          'same customer you also chat with on WhatsApp.'),
    ],
  );
}

Widget _channelRow(Map<String, dynamic> c, double totalRevenue) {
  final revenue = _num(c['revenue_ghs']);
  final orders = _num(c['orders']).round();
  final paid = _num(c['paid_orders']).round();
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Expanded(
            child: Text(channelLabel(c['channel']),
                style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          Text(ghs(revenue),
              style: const TextStyle(
                  fontWeight: FontWeight.w800, color: WabColors.accentInk)),
        ],
      ),
      const SizedBox(height: 3),
      Text(
          '$orders order${orders == 1 ? '' : 's'} · $paid paid · '
          '${_num(c['unique_customers']).round()} customers',
          style: const TextStyle(fontSize: 12, color: WabColors.muted)),
      const SizedBox(height: 6),
      _bar(totalRevenue > 0 ? revenue / totalRevenue : 0),
    ],
  );
}
