import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/order_api.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/order_action_sheets.dart';
import 'orders.dart' show orderStatuses;

class OrderDetailScreen extends StatefulWidget {
  final String orderId;
  const OrderDetailScreen({super.key, required this.orderId});

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  Map<String, dynamic>? _order;
  List<dynamic> _history = [];
  List<dynamic> _refunds = [];
  List<dynamic> _paymentAttempts = [];
  String? _error;
  bool _updating = false;
  bool _sendingReminder = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res =
          await context.read<Session>().api.get('/api/orders/${widget.orderId}');
      if (!mounted) return;
      setState(() {
        _order = res['order'] as Map<String, dynamic>?;
        _history = (res['history'] as List?) ?? [];
        _refunds = (res['refunds'] as List?) ?? [];
        _paymentAttempts = (res['payment_attempts'] as List?) ?? [];
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  double get _refundedTotal => _refunds
      .where((r) => r['status'] == 'processed')
      .fold<double>(0, (sum, r) => sum + (double.tryParse('${r['amount_ghs']}') ?? 0));

  double get _refundable {
    final total = double.tryParse('${_order?['total_ghs'] ?? 0}') ?? 0;
    final remaining = total - _refundedTotal;
    return remaining < 0 ? 0 : remaining;
  }

  Future<void> _setStatus(String status) async {
    setState(() => _updating = true);
    final body = {'status': status};
    try {
      final res = await context
          .read<Session>()
          .api
          .patch('/api/orders/${widget.orderId}/status', body: body);
      if (!mounted) return;
      setState(() => _order = res['order'] as Map<String, dynamic>?);
      await OfflineCache.patchCachedOrder(widget.orderId, body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Order marked $status — customer notified')));
      _load();
    } on ApiException catch (e) {
      if (e.status == 0) {
        // No connection — queue it and reflect the change locally so the
        // merchant isn't left staring at a stale status.
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-status-${widget.orderId}-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/orders/${widget.orderId}/status',
          body: body,
          description: 'Mark order #${_order?['order_number']} $status',
        ));
        await OfflineCache.patchCachedOrder(widget.orderId, body);
        if (mounted) {
          setState(() => _order = {...?_order, 'status': status});
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Offline — queued, will sync when back online')));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _markDeliveryStatus(String status) async {
    setState(() => _updating = true);
    try {
      final res = await context
          .read<Session>()
          .api
          .updateDeliveryStatus(widget.orderId, status);
      if (mounted) setState(() => _order = res['order'] as Map<String, dynamic>?);
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _openMarkPaid() async {
    final updated = await showMarkPaidSheet(context, _order!);
    if (updated == null || !mounted) return;
    setState(() => _order = updated);
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Marked as paid')));
    _load();
  }

  Future<void> _openAssignRider() async {
    final updated = await showAssignRiderSheet(context, _order!);
    if (updated == null || !mounted) return;
    setState(() => _order = updated);
    _load();
  }

  Future<void> _openSetEstimates() async {
    final updated = await showSetEstimatesSheet(context, _order!);
    if (updated == null || !mounted) return;
    setState(() => _order = updated);
    _load();
  }

  Future<void> _openRefund() async {
    final refund = await showRefundSheet(context, _order!, maxRefundable: _refundable);
    if (refund == null || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Refund recorded')));
    _load();
  }

  Future<void> _openAddNote() async {
    await showAddNoteSheet(context, _order!);
    if (!mounted) return;
    _load();
  }

  Future<void> _sendReminder() async {
    setState(() => _sendingReminder = true);
    try {
      await context.read<Session>().api.sendPaymentReminder(widget.orderId);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Reminder sent ✓')));
      }
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _sendingReminder = false);
    }
  }

  /// Most recent normalized failure-reason code stored on the order's
  /// timeline (see order.service.js#markOrderFailed's note), if any.
  String? get _lastFailureReasonCode {
    for (final e in _history.reversed) {
      final map = e as Map<String, dynamic>;
      if (map['event'] == 'payment:failed') return map['note'] as String?;
    }
    return null;
  }

  String _friendlyFailureReason(String? code) => switch (code) {
        'insufficient_funds' => 'Insufficient funds in their MoMo wallet',
        'cancelled' => 'They cancelled the approval prompt',
        'timeout' => 'The approval prompt timed out',
        'wrong_number' => "The MoMo number couldn't be reached",
        'declined' => 'Declined by their provider',
        _ => 'Payment did not go through',
      };

  String get _receiptUrl =>
      '${ApiClient.baseUrl}/wa-b/receipt.html?order=${widget.orderId}';

  void _copyReceiptLink() {
    Clipboard.setData(ClipboardData(text: _receiptUrl));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Receipt link copied')));
  }

  @override
  Widget build(BuildContext context) {
    final o = _order;
    return Scaffold(
      appBar: AppBar(title: Text(o == null ? 'Order' : '#${o['order_number']}')),
      body: o == null
          ? _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : RefreshIndicator(
              onRefresh: _load,
              color: WabColors.accent,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _summaryCard(o),
                  const SizedBox(height: 16),
                  _sectionTitle('Items'),
                  const SizedBox(height: 8),
                  _itemsCard(o),
                  const SizedBox(height: 24),
                  _sectionTitle('Payment'),
                  const SizedBox(height: 8),
                  _paymentCard(o),
                  if (o['delivery_address'] != null) ...[
                    const SizedBox(height: 24),
                    _sectionTitle('Delivery'),
                    const SizedBox(height: 8),
                    _deliveryCard(o),
                  ],
                  const SizedBox(height: 24),
                  _sectionTitle('Timeline'),
                  const SizedBox(height: 8),
                  _timelineCard(),
                  const SizedBox(height: 24),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _sectionTitle('Notes'),
                      TextButton(
                        onPressed: _openAddNote,
                        child: const Text('Add note'),
                      ),
                    ],
                  ),
                  _notesCard(o),
                  const SizedBox(height: 24),
                  _sectionTitle('Update status'),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    // 'paid' is deliberately excluded — it used to sit here
                    // as a fulfillment-status chip that silently never
                    // touched payment_status. Recording a payment now only
                    // happens through the dedicated "Mark as paid" action
                    // above, which keeps stock/loyalty/GMV correct.
                    children: orderStatuses
                        .where((s) => s != 'pending' && s != 'paid' && s != '${o['status']}')
                        .map((s) => ActionChip(
                              label: Text(s),
                              onPressed: _updating ? null : () => _setStatus(s),
                              backgroundColor: s == 'cancelled'
                                  ? WabColors.danger.withValues(alpha: 0.08)
                                  : WabColors.accentSoft,
                              labelStyle: TextStyle(
                                  color: s == 'cancelled'
                                      ? WabColors.danger
                                      : WabColors.accentInk,
                                  fontWeight: FontWeight.w700),
                              side: BorderSide.none,
                            ))
                        .toList(),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'The customer gets a WhatsApp update automatically when you change the status.',
                    style: TextStyle(color: WabColors.muted2, fontSize: 13),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _sectionTitle(String text) =>
      Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800));

  Widget _summaryCard(Map<String, dynamic> o) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(ghs(o['total_ghs']),
                    style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    StatusChip('${o['status']}'),
                    const SizedBox(height: 4),
                    StatusChip('${o['payment_status']}',
                        label: paymentStatusLabel('${o['payment_status']}')),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(shortDate(o['created_at']), style: const TextStyle(color: WabColors.muted)),
            if (o['delivery_address'] != null) ...[
              const SizedBox(height: 12),
              Row(children: [
                const Icon(Icons.location_on_outlined, size: 18, color: WabColors.muted),
                const SizedBox(width: 6),
                Expanded(
                    child: Text('${o['delivery_address']}',
                        style: const TextStyle(color: WabColors.ink))),
              ]),
            ],
            if (o['notes'] != null && '${o['notes']}'.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text('Customer note: ${o['notes']}',
                  style: const TextStyle(color: WabColors.muted)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _itemsCard(Map<String, dynamic> o) {
    return Card(
      child: Column(
        children: [
          for (final item in (o['items'] as List? ?? []))
            ListTile(
              dense: true,
              title:
                  Text('${item['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
              leading: Text('×${item['quantity']}',
                  style: const TextStyle(
                      color: WabColors.accentInk, fontWeight: FontWeight.w800, fontSize: 15)),
              trailing: Text(ghs((item['price_ghs'] ?? 0) * (item['quantity'] ?? 1)),
                  style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
          const Divider(height: 1),
          _row('Subtotal', ghs(o['subtotal_ghs'])),
          if ((num.tryParse('${o['discount_ghs'] ?? 0}') ?? 0) > 0)
            _row('Discount (${o['promo_code'] ?? ''})', '-${ghs(o['discount_ghs'])}'),
          _row('Delivery', ghs(o['delivery_fee'])),
          _row('Total', ghs(o['total_ghs']), bold: true),
        ],
      ),
    );
  }

  Widget _paymentCard(Map<String, dynamic> o) {
    final status = '${o['payment_status']}';
    final canMarkPaid = status != 'paid' && status != 'refunded';
    final canRefund = status == 'paid' && _refundable > 0;
    final canRemind = status != 'paid' && status != 'refunded';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(paymentStatusLabel(status),
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                if (o['payment_method'] != null)
                  Text('via ${o['payment_method']}',
                      style: const TextStyle(color: WabColors.muted)),
              ],
            ),
            if (_refundedTotal > 0) ...[
              const SizedBox(height: 6),
              Text('${ghs(_refundedTotal)} refunded so far',
                  style: const TextStyle(color: WabColors.muted, fontSize: 13)),
            ],
            if (status == 'failed') ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: WabColors.danger.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(_friendlyFailureReason(_lastFailureReasonCode),
                    style: const TextStyle(color: WabColors.danger, fontWeight: FontWeight.w600)),
              ),
            ],
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (canMarkPaid)
                  FilledButton.icon(
                    onPressed: _openMarkPaid,
                    icon: const Icon(Icons.check_circle_outline, size: 18),
                    label: const Text('Mark as paid'),
                  ),
                if (canRemind)
                  OutlinedButton.icon(
                    onPressed: _sendingReminder ? null : _sendReminder,
                    icon: _sendingReminder
                        ? const SizedBox(
                            width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.notifications_active_outlined, size: 18),
                    label: const Text('Send reminder'),
                  ),
                if (canRefund)
                  OutlinedButton.icon(
                    onPressed: _openRefund,
                    icon: const Icon(Icons.undo_rounded, size: 18, color: WabColors.danger),
                    label: const Text('Refund', style: TextStyle(color: WabColors.danger)),
                    style: OutlinedButton.styleFrom(side: const BorderSide(color: WabColors.danger)),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            const Divider(height: 1),
            const SizedBox(height: 10),
            Row(
              children: [
                const Icon(Icons.link_rounded, size: 18, color: WabColors.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(_receiptUrl,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: WabColors.muted, fontSize: 13)),
                ),
                IconButton(
                  onPressed: _copyReceiptLink,
                  icon: const Icon(Icons.copy_rounded, size: 18),
                  tooltip: 'Copy receipt link',
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            if (_paymentAttempts.isNotEmpty) ...[
              const SizedBox(height: 6),
              const Divider(height: 1),
              const SizedBox(height: 10),
              const Text('Payment attempts',
                  style: TextStyle(
                      fontWeight: FontWeight.w700, color: WabColors.muted2, fontSize: 12)),
              const SizedBox(height: 6),
              for (final a in _paymentAttempts)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Text(
                      '${a['method'] ?? 'unknown'} · ${a['reference']} · ${timeAgo(a['created_at'])}',
                      style: const TextStyle(color: WabColors.muted, fontSize: 12)),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _deliveryCard(Map<String, dynamic> o) {
    final riderName = o['rider_name'] as String?;
    final deliveryStatus = '${o['delivery_status'] ?? 'unassigned'}';
    final readyAt = o['estimated_ready_at'];
    final deliveryAt = o['estimated_delivery_at'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    riderName == null || riderName.isEmpty
                        ? 'No rider assigned'
                        : '$riderName${o['rider_phone'] != null ? ' · ${o['rider_phone']}' : ''}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                StatusChip(deliveryStatus),
              ],
            ),
            if (readyAt != null || deliveryAt != null) ...[
              const SizedBox(height: 8),
              if (readyAt != null)
                Text('Ready by: ${shortDate(readyAt)}',
                    style: const TextStyle(color: WabColors.muted, fontSize: 13)),
              if (deliveryAt != null)
                Text('Out for delivery by: ${shortDate(deliveryAt)}',
                    style: const TextStyle(color: WabColors.muted, fontSize: 13)),
            ],
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: _openAssignRider,
                  child: Text(riderName == null || riderName.isEmpty
                      ? 'Assign rider'
                      : 'Reassign rider'),
                ),
                if (deliveryStatus == 'assigned')
                  FilledButton(
                    onPressed: _updating ? null : () => _markDeliveryStatus('picked_up'),
                    child: const Text('Rider picked up'),
                  ),
                if (deliveryStatus == 'picked_up')
                  FilledButton(
                    onPressed: _updating ? null : () => _markDeliveryStatus('delivered'),
                    child: const Text('Mark delivered'),
                  ),
                OutlinedButton(
                  onPressed: _openSetEstimates,
                  child: const Text('Set estimate'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _timelineCard() {
    if (_history.isEmpty) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text('No activity yet.', style: TextStyle(color: WabColors.muted)),
        ),
      );
    }
    // Server returns oldest-first; show most recent activity on top.
    final entries = _history.reversed.toList();
    return Card(
      child: Column(
        children: [
          for (final e in entries) _timelineTile(e as Map<String, dynamic>),
        ],
      ),
    );
  }

  Widget _timelineTile(Map<String, dynamic> e) {
    final meta = _eventMeta('${e['event']}');
    final changedBy = '${e['changed_by'] ?? 'system'}';
    final isFailure = e['event'] == 'payment:failed';
    final note = isFailure ? _friendlyFailureReason(e['note'] as String?) : '${e['note'] ?? ''}';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(meta.$1, size: 18, color: meta.$2),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(meta.$3, style: const TextStyle(fontWeight: FontWeight.w700)),
                if (note.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(note,
                        style: const TextStyle(color: WabColors.muted, fontSize: 13)),
                  ),
                const SizedBox(height: 2),
                Text(
                    changedBy == 'system'
                        ? timeAgo(e['created_at'])
                        : '${timeAgo(e['created_at'])} · $changedBy',
                    style: const TextStyle(color: WabColors.muted2, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  (IconData, Color, String) _eventMeta(String event) {
    if (event.startsWith('payment:paid')) {
      return (Icons.check_circle_rounded, WabColors.accentInk, 'Payment received');
    }
    if (event.startsWith('payment:failed')) {
      return (Icons.error_rounded, WabColors.danger, 'Payment failed');
    }
    if (event == 'payment:reminder_sent') {
      return (Icons.notifications_active_outlined, WabColors.muted, 'Reminder sent');
    }
    if (event.startsWith('refund:processed')) {
      return (Icons.undo_rounded, WabColors.danger, 'Refund processed');
    }
    if (event.startsWith('refund:')) {
      return (Icons.undo_rounded, WabColors.warning, 'Refund recorded');
    }
    if (event.startsWith('delivery:assigned')) {
      return (Icons.moped_outlined, WabColors.muted, 'Rider assigned');
    }
    if (event.startsWith('delivery:picked_up')) {
      return (Icons.moped_rounded, WabColors.warning, 'Rider picked up');
    }
    if (event.startsWith('delivery:delivered')) {
      return (Icons.task_alt_rounded, WabColors.accentInk, 'Delivered');
    }
    if (event.startsWith('estimate:')) {
      return (Icons.schedule_rounded, WabColors.muted, 'Estimate updated');
    }
    if (event.startsWith('status:')) {
      return (Icons.sync_alt_rounded, WabColors.muted, 'Status: ${event.split(':').last}');
    }
    if (event == 'note') {
      return (Icons.sticky_note_2_outlined, WabColors.muted, 'Note added');
    }
    return (Icons.circle_outlined, WabColors.muted, event);
  }

  Widget _notesCard(Map<String, dynamic> o) {
    final notes = '${o['internal_notes'] ?? ''}'.trim();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: notes.isEmpty
            ? const Text('No notes yet.', style: TextStyle(color: WabColors.muted))
            : Text(notes, style: const TextStyle(height: 1.5)),
      ),
    );
  }

  Widget _row(String label, String value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(
                  color: bold ? WabColors.ink : WabColors.muted,
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
          Text(value,
              style: TextStyle(
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                  fontSize: bold ? 16 : 14)),
        ],
      ),
    );
  }
}
