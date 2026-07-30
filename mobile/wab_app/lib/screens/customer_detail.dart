import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/customer_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'chat.dart';
import 'order_detail.dart';

/// One customer, everything the merchant knows about them.
///
/// The backend has served this for a long time and nothing called it —
/// tapping a customer went straight to the chat thread, so "is this person
/// worth a discount" had no answer inside the app.
///
/// Profile and loyalty load in parallel and loyalty is allowed to fail on its
/// own: a shop with the programme switched off should still see who its best
/// customers are.
class CustomerDetailScreen extends StatefulWidget {
  final String customerId;
  final String customerName;

  const CustomerDetailScreen({
    super.key,
    required this.customerId,
    required this.customerName,
  });

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> {
  Map<String, dynamic>? _profile;
  Map<String, dynamic>? _loyalty;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _profile == null;
      _error = null;
    });
    final api = context.read<Session>().api;
    try {
      final results = await Future.wait([
        api.getCustomerProfile(widget.customerId),
        // Loyalty is additive: a shop with the programme off must still get
        // the profile rather than an error screen.
        api
            .getCustomerLoyalty(widget.customerId)
            .catchError((_) => <String, dynamic>{}),
      ]);
      if (!mounted) return;
      setState(() {
        _profile = results[0];
        _loyalty = results[1]['loyalty'] as Map<String, dynamic>?;
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

  Map<String, dynamic> get _customer =>
      (_profile?['customer'] as Map<String, dynamic>?) ?? const {};

  // ------------------------------------------------------------------ tags

  Future<void> _editTags() async {
    final current = ((_customer['tags'] as List?) ?? []).map((t) => '$t').toList();
    final ctrl = TextEditingController(text: current.join(', '));

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Tags'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
                'Separate with commas. Your own words — VIP, wholesale, East Legon.',
                style: TextStyle(color: WabColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              autofocus: true,
              decoration: const InputDecoration(hintText: 'vip, wholesale'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (saved != true || !mounted) return;

    final tags = ctrl.text
        .split(',')
        .map((t) => t.trim())
        .where((t) => t.isNotEmpty)
        .toList();
    await _save(() => context.read<Session>().api
        .setCustomerTags(widget.customerId, tags));
  }

  Future<void> _editAddressNote() async {
    final ctrl = TextEditingController(text: '${_customer['address_note'] ?? ''}');

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delivery directions'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
                'Sent to the rider every time. "Blue gate opposite the mosque, call on arrival."',
                style: TextStyle(color: WabColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            TextField(controller: ctrl, autofocus: true, maxLines: 3),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (saved != true || !mounted) return;

    final note = ctrl.text.trim();
    await _save(() => context.read<Session>().api
        .setCustomerAddressNote(widget.customerId, note.isEmpty ? null : note));
  }

  Future<void> _save(Future<void> Function() action) async {
    try {
      await action();
      if (!mounted) return;
      _toast('Saved.');
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    }
  }

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: error ? WabColors.danger : WabColors.accentInk,
    ));
  }

  // ----------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.customerName.isEmpty ? 'Customer' : widget.customerName),
        actions: [
          IconButton(
            tooltip: 'Open chat',
            icon: const Icon(Icons.chat_bubble_outline_rounded),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => ChatScreen(
                    customerId: widget.customerId,
                    customerName: widget.customerName))),
          ),
        ],
      ),
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
                      _worthCard(),
                      const SizedBox(height: 16),
                      _tagsCard(),
                      const SizedBox(height: 16),
                      if (_loyalty != null) ...[
                        _loyaltyCard(),
                        const SizedBox(height: 16),
                      ],
                      _habitsCard(),
                      const SizedBox(height: 24),
                      const Text('Recent orders',
                          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                      const SizedBox(height: 8),
                      ..._recentOrders(),
                    ],
                  ),
                ),
    );
  }

  /// What this customer is worth — the question the screen exists to answer.
  Widget _worthCard() {
    final meta = _profile ?? {};
    final freq = (meta['order_frequency_per_month'] as num?)?.toDouble() ?? 0;
    return Container(
      decoration: BoxDecoration(
          color: WabColors.ink, borderRadius: BorderRadius.circular(20)),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Lifetime spend',
              style: TextStyle(color: Color(0xB3FFFFFF), fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(ghs(meta['lifetime_spend_ghs'] ?? 0),
              style: const TextStyle(
                  color: WabColors.gold, fontSize: 32, fontWeight: FontWeight.w800)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(child: _darkStat('Orders', '${meta['total_orders'] ?? 0}')),
              Expanded(
                child: _darkStat('Per month',
                    freq > 0 ? freq.toStringAsFixed(1) : '—'),
              ),
              Expanded(
                child: _darkStat('Usually pays',
                    '${meta['preferred_payment_method'] ?? '—'}'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _darkStat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text(label,
              style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 12)),
        ],
      );

  Widget _card({required String title, VoidCallback? onEdit, required Widget child}) {
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
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(title,
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: WabColors.muted)),
              if (onEdit != null)
                InkWell(
                  onTap: onEdit,
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                    child: Text('Edit',
                        style: TextStyle(
                            color: WabColors.accent,
                            fontWeight: FontWeight.w700,
                            fontSize: 13)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  Widget _tagsCard() {
    final tags = ((_customer['tags'] as List?) ?? []).map((t) => '$t').toList();
    final note = '${_customer['address_note'] ?? ''}'.trim();

    return _card(
      title: 'TAGS & DIRECTIONS',
      onEdit: _editTags,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (tags.isEmpty)
            const Text('No tags yet — tap Edit to group this customer.',
                style: TextStyle(color: WabColors.muted))
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final tag in tags)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: WabColors.accentSoft,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(tag,
                        style: const TextStyle(
                            color: WabColors.accentInk,
                            fontWeight: FontWeight.w700,
                            fontSize: 12)),
                  ),
              ],
            ),
          const SizedBox(height: 14),
          const Divider(height: 1),
          const SizedBox(height: 12),
          InkWell(
            onTap: _editAddressNote,
            child: Row(
              children: [
                const Icon(Icons.pin_drop_outlined, size: 18, color: WabColors.muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                      note.isEmpty ? 'Add delivery directions for the rider' : note,
                      style: TextStyle(
                          color: note.isEmpty ? WabColors.muted : WabColors.ink,
                          height: 1.4)),
                ),
                const Icon(Icons.chevron_right_rounded, size: 20, color: WabColors.muted2),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _loyaltyCard() {
    final l = _loyalty ?? {};
    final target = (l['stamps_target'] as num?)?.toInt() ?? 0;
    final stamps = (l['stamps'] as num?)?.toInt() ?? 0;
    final tier = '${l['vip_tier'] ?? ''}'.trim();

    return _card(
      title: 'LOYALTY',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: _stat('Points', '${l['points'] ?? 0}',
                    sub: ghs(l['points_value_ghs'] ?? 0)),
              ),
              if (target > 0)
                Expanded(child: _stat('Stamps', '$stamps/$target')),
              if (tier.isNotEmpty && tier != 'null')
                Expanded(child: _stat('Tier', tier)),
            ],
          ),
          if ('${l['referral_code'] ?? ''}'.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('Referral code: ${l['referral_code']}',
                style: const TextStyle(color: WabColors.muted, fontSize: 13)),
          ],
        ],
      ),
    );
  }

  Widget _stat(String label, String value, {String? sub}) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          Text(label,
              style: const TextStyle(color: WabColors.muted, fontSize: 12)),
          if (sub != null)
            Text(sub, style: const TextStyle(color: WabColors.muted2, fontSize: 11)),
        ],
      );

  /// What they actually buy — the thing that makes an offer land.
  Widget _habitsCard() {
    final products = (_profile?['last_products_ordered'] as List?) ?? [];
    return _card(
      title: 'USUALLY BUYS',
      child: products.isEmpty
          ? const Text('Nothing ordered yet.',
              style: TextStyle(color: WabColors.muted))
          : Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                // Elements are { name, ordered_at }, not bare strings — the
                // endpoint de-duplicates by name across recent orders.
                for (final p in products.take(8))
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: WabColors.bg2,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: WabColors.line),
                    ),
                    child: Text(
                        p is Map ? '${p['name'] ?? ''}' : '$p',
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                  ),
              ],
            ),
    );
  }

  List<Widget> _recentOrders() {
    final orders = (_profile?['recent_orders'] as List?) ?? [];
    if (orders.isEmpty) {
      return [
        const Padding(
          padding: EdgeInsets.only(top: 16),
          child: EmptyState(
              icon: Icons.receipt_long_rounded, title: 'No orders yet'),
        )
      ];
    }
    return [
      for (final o in orders)
        Card(
          child: ListTile(
            title: Text('${o['order_number'] ?? ''}',
                style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(timeAgo(o['created_at']),
                style: const TextStyle(color: WabColors.muted)),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(ghs(o['total_ghs']),
                    style: const TextStyle(fontWeight: FontWeight.w800)),
                StatusChip('${o['payment_status'] ?? ''}',
                    label: paymentStatusLabel('${o['payment_status'] ?? ''}')),
              ],
            ),
            onTap: o['id'] == null
                ? null
                : () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => OrderDetailScreen(orderId: '${o['id']}'))),
          ),
        ),
    ];
  }
}
