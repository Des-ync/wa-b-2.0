import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../api/accounting_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Merchant payout summary and daily settlement report — "what have I
/// collected, what's been paid out, and what happened today."
class AccountingScreen extends StatefulWidget {
  const AccountingScreen({super.key});

  @override
  State<AccountingScreen> createState() => _AccountingScreenState();
}

class _AccountingScreenState extends State<AccountingScreen> {
  Map<String, dynamic>? _balance;
  List<dynamic> _payouts = [];
  Map<String, dynamic>? _dailyReport;
  int _unmatchedCount = 0;
  DateTime _reportDate = DateTime.now();
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String get _reportDateParam => DateFormat('yyyy-MM-dd').format(_reportDate);

  Future<void> _load() async {
    setState(() {
      _loading = _balance == null;
      _error = null;
    });
    final session = context.read<Session>();
    final bid = session.businessId!;
    try {
      final results = await Future.wait([
        session.api.getPayoutBalance(bid),
        session.api.getPayouts(bid),
        session.api.getDailySales(bid, date: _reportDateParam),
        session.api.getReconciliation(bid),
      ]);
      if (!mounted) return;
      setState(() {
        _balance = results[0];
        _payouts = (results[1]['payouts'] as List?) ?? [];
        _dailyReport = results[2]['report'] as Map<String, dynamic>?;
        _unmatchedCount = (results[3]['unmatched_count'] as num?)?.toInt() ?? 0;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _reportDate,
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now(),
    );
    if (picked == null) return;
    setState(() => _reportDate = picked);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Payouts & settlement')),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      _balanceCard(),
                      const SizedBox(height: 16),
                      if (_unmatchedCount > 0) ...[
                        _unmatchedBanner(),
                        const SizedBox(height: 16),
                      ],
                      _sectionTitle('Daily settlement report'),
                      const SizedBox(height: 8),
                      _dailyReportCard(),
                      const SizedBox(height: 24),
                      _sectionTitle('Payout history'),
                      const SizedBox(height: 8),
                      if (_payouts.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 16),
                          child: EmptyState(
                              icon: Icons.account_balance_wallet_rounded,
                              title: 'No payouts recorded yet'),
                        )
                      else
                        for (final p in _payouts) _payoutTile(p as Map<String, dynamic>),
                    ],
                  ),
                ),
    );
  }

  Widget _sectionTitle(String t) =>
      Text(t, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800));

  Widget _balanceCard() {
    final b = _balance ?? {};
    return Container(
      decoration: BoxDecoration(color: WabColors.ink, borderRadius: BorderRadius.circular(20)),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Owed to you',
              style: TextStyle(color: Color(0xB3FFFFFF), fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(ghs(b['balance_ghs'] ?? 0),
              style: const TextStyle(
                  color: WabColors.gold, fontSize: 32, fontWeight: FontWeight.w800)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _balanceStat('Collected', ghs(b['collected_ghs'] ?? 0)),
              ),
              Expanded(
                child: _balanceStat('Paid out', ghs(b['paid_out_ghs'] ?? 0)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _balanceStat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
          Text(label, style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 12)),
        ],
      );

  Widget _unmatchedBanner() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: WabColors.warning.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(14)),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: WabColors.warning),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
                '$_unmatchedCount paid order(s) have no matching gateway record — worth a manual check.',
                style: const TextStyle(color: WabColors.warning, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  Widget _dailyReportCard() {
    final r = _dailyReport ?? {};
    final isToday = DateFormat('yyyy-MM-dd').format(DateTime.now()) == _reportDateParam;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(isToday ? 'Today' : DateFormat('d MMM yyyy').format(_reportDate),
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                TextButton.icon(
                  onPressed: _pickDate,
                  icon: const Icon(Icons.calendar_month_rounded, size: 16),
                  label: const Text('Change date'),
                ),
              ],
            ),
            const Divider(height: 20),
            _row('Orders settled', '${r['order_count'] ?? 0}'),
            _row('Subtotal', ghs(r['subtotal_ghs'] ?? 0)),
            _row('Delivery fees', ghs(r['delivery_fee_ghs'] ?? 0)),
            _row('Discounts', '-${ghs(r['discount_ghs'] ?? 0)}'),
            _row('Total', ghs(r['total_ghs'] ?? 0), bold: true),
            const Divider(height: 20),
            _row('MoMo', ghs(r['momo_ghs'] ?? 0)),
            _row('Card', ghs(r['card_ghs'] ?? 0)),
            _row('Cash', ghs(r['cash_ghs'] ?? 0)),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(
                  color: bold ? WabColors.ink : WabColors.muted,
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
          Text(value,
              style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w600)),
        ],
      ),
    );
  }

  Widget _payoutTile(Map<String, dynamic> p) {
    final status = '${p['status'] ?? 'settled'}';
    final auto = p['initiated_by'] == 'mtn_momo_auto';
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: Text(ghs(p['amount_ghs']), style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
            '${auto ? 'Automatic' : 'Manual'} · ${p['momo_number'] ?? ''} · ${shortDate(p['created_at'])}',
            style: const TextStyle(color: WabColors.muted, fontSize: 12)),
        trailing: StatusChip(status),
      ),
    );
  }
}
