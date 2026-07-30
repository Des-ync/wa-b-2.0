import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../api/accounting_api.dart';
import '../api/client.dart';
import '../services/biometric_gate.dart';
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
  Map<String, dynamic>? _profitLoss;
  int _unmatchedCount = 0;
  DateTime _reportDate = DateTime.now();
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String get _reportDateParam => DateFormat('yyyy-MM-dd').format(_reportDate);

  String get _monthStartParam {
    final now = DateTime.now();
    return DateFormat('yyyy-MM-dd').format(DateTime(now.year, now.month, 1));
  }

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
        // Month to date. A failure here must not blank the whole screen —
        // the balance and settlement report are the load-bearing parts.
        session.api
            .getProfitLoss(bid, from: _monthStartParam)
            .catchError((_) => <String, dynamic>{}),
      ]);
      if (!mounted) return;
      setState(() {
        _balance = results[0];
        _payouts = (results[1]['payouts'] as List?) ?? [];
        _dailyReport = results[2]['report'] as Map<String, dynamic>?;
        _unmatchedCount = (results[3]['unmatched_count'] as num?)?.toInt() ?? 0;
        _profitLoss = results[4];
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
          ? const Center(
              child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: CustomScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    slivers: [
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                        sliver: SliverToBoxAdapter(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
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
                              _sectionTitle('Profit this month'),
                              const SizedBox(height: 8),
                              _profitCard(),
                              const SizedBox(height: 24),
                              _sectionTitle('Payout history'),
                              const SizedBox(height: 8),
                              if (_payouts.isEmpty)
                                const Padding(
                                  padding: EdgeInsets.symmetric(vertical: 16),
                                  child: EmptyState(
                                      icon:
                                          Icons.account_balance_wallet_rounded,
                                      title: 'No payouts recorded yet'),
                                ),
                            ],
                          ),
                        ),
                      ),
                      if (_payouts.isNotEmpty)
                        SliverPadding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          sliver: SliverList.builder(
                            itemCount: _payouts.length,
                            itemBuilder: (context, index) => _payoutTile(
                                _payouts[index] as Map<String, dynamic>),
                          ),
                        )
                      else
                        const SliverToBoxAdapter(child: SizedBox(height: 16)),
                    ],
                  ),
                ),
    );
  }

  Widget _sectionTitle(String t) => Text(t,
      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800));

  Widget _balanceCard() {
    final b = _balance ?? {};
    return Container(
      decoration: BoxDecoration(
          color: WabColors.ink, borderRadius: BorderRadius.circular(20)),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Owed to you',
              style: TextStyle(
                  color: Color(0xB3FFFFFF), fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(ghs(b['balance_ghs'] ?? 0),
              style: const TextStyle(
                  color: WabColors.gold,
                  fontSize: 32,
                  fontWeight: FontWeight.w800)),
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
          if ((b['balance_ghs'] as num? ?? 0) > 0) ...[
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : _withdraw,
                icon: const Icon(Icons.account_balance_wallet_rounded, size: 18),
                label: Text(_busy ? 'Sending…' : 'Withdraw to MoMo'),
                style: FilledButton.styleFrom(
                    backgroundColor: WabColors.gold,
                    foregroundColor: WabColors.ink),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// Move the merchant's balance to their own payout MoMo number.
  ///
  /// The only action in the app that sends money, so it is gated twice: the
  /// device's own biometric/passcode check, then an explicit confirmation
  /// showing the exact amount and destination. A mis-tap here is not
  /// recoverable from inside the app.
  Future<void> _withdraw() async {
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;

    final balance = (_balance?['balance_ghs'] as num?)?.toDouble() ?? 0;
    if (balance <= 0) return;

    final destination = session.business?['payout_momo_number']?.toString();
    if (destination == null || destination.isEmpty) {
      _toast('Add your payout MoMo number in Settings first.', error: true);
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Withdraw to MoMo?'),
        content: Text(
            '${ghs(balance)} will be sent to $destination.\n\n'
            'This usually arrives within a few minutes.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Withdraw')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    if (!await BiometricGate.authenticate('Confirm your withdrawal of ${ghs(balance)}')) {
      if (mounted) _toast('Withdrawal cancelled.', error: true);
      return;
    }
    if (!mounted) return;

    setState(() => _busy = true);
    try {
      await session.api.requestAutoPayout(bid, amountGhs: balance);
      if (!mounted) return;
      _toast('Withdrawal sent — it will show as paid out once confirmed.');
      await _load();
    } catch (e) {
      if (!mounted) return;
      // A 409 here means the platform's Paystack account needs a human to
      // approve the transfer — retrying will not help, so say so plainly.
      final msg = e is ApiException && e.status == 409
          ? 'This withdrawal needs manual approval. Contact support — your money is safe.'
          : '$e';
      _toast(msg, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? WabColors.danger : WabColors.accentInk,
    ));
  }

  /// Revenue minus recorded expenses for the current month.
  ///
  /// Paired with the "Add expense" action rather than shown alone: a profit
  /// figure that only ever counts revenue is worse than no figure, because it
  /// reads as profit when it is really turnover. Making the expense entry
  /// point sit next to the number is what keeps it honest.
  Widget _profitCard() {
    final pl = _profitLoss ?? {};
    // The endpoint sends these as fixed-precision STRINGS (toFixed(2)), not
    // numbers, so a plain `as num?` cast silently yields null and every
    // figure renders as zero.
    double money(String key) =>
        double.tryParse('${pl[key] ?? ''}') ?? 0;
    final revenue = money('revenue_ghs');
    final expenses = money('expenses_ghs');
    final net = revenue - expenses;

    return Container(
      decoration: BoxDecoration(
        color: WabColors.paper,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: WabColors.line),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _row('Revenue', ghs(revenue)),
          const SizedBox(height: 6),
          _row('Expenses', ghs(expenses)),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Divider(height: 1),
          ),
          _row(net >= 0 ? 'Profit' : 'Loss', ghs(net.abs()), bold: true),
          if (expenses == 0) ...[
            const SizedBox(height: 10),
            const Text(
                'No expenses recorded this month — this is turnover, not profit.',
                style: TextStyle(
                    color: WabColors.muted, fontSize: 12, height: 1.4)),
          ],
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _addExpense,
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('Add expense'),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _addExpense() async {
    final amountCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    String category = 'general';

    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(
            24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Add expense',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 16),
              TextField(
                controller: amountCtrl,
                autofocus: true,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                    labelText: 'Amount (GH¢)', prefixText: 'GH¢ '),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: category,
                decoration: const InputDecoration(labelText: 'Category'),
                items: const [
                  DropdownMenuItem(value: 'general', child: Text('General')),
                  DropdownMenuItem(value: 'stock', child: Text('Stock / supplies')),
                  DropdownMenuItem(value: 'transport', child: Text('Transport')),
                  DropdownMenuItem(value: 'rent', child: Text('Rent')),
                  DropdownMenuItem(value: 'utilities', child: Text('Utilities')),
                  DropdownMenuItem(value: 'staff', child: Text('Staff')),
                ],
                onChanged: (v) => setSheet(() => category = v ?? 'general'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: noteCtrl,
                decoration: const InputDecoration(labelText: 'Note (optional)'),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Save expense'),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    if (saved != true || !mounted) return;
    final amount = double.tryParse(amountCtrl.text.trim());
    if (amount == null || amount <= 0) {
      _toast('Enter an amount greater than zero.', error: true);
      return;
    }

    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;
    try {
      await session.api.addExpense(bid,
          amountGhs: amount,
          category: category,
          description: noteCtrl.text.trim());
      if (!mounted) return;
      _toast('Expense recorded.');
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    }
  }

  Widget _balanceStat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                  fontSize: 16)),
          Text(label,
              style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 12)),
        ],
      );

  Widget _unmatchedBanner() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: WabColors.warning.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(14)),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: WabColors.warning),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
                '$_unmatchedCount paid order(s) have no matching gateway record — worth a manual check.',
                style: const TextStyle(
                    color: WabColors.warning, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  Widget _dailyReportCard() {
    final r = _dailyReport ?? {};
    final isToday =
        DateFormat('yyyy-MM-dd').format(DateTime.now()) == _reportDateParam;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                    isToday
                        ? 'Today'
                        : DateFormat('d MMM yyyy').format(_reportDate),
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
              style: TextStyle(
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w600)),
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
        title: Text(ghs(p['amount_ghs']),
            style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
            '${auto ? 'Automatic' : 'Manual'} · ${p['momo_number'] ?? ''} · ${shortDate(p['created_at'])}',
            style: const TextStyle(color: WabColors.muted, fontSize: 12)),
        trailing: StatusChip(status),
      ),
    );
  }
}
