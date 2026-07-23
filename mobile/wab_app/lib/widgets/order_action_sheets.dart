import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/order_api.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';

/// Bottom-sheet forms for the order-detail screen's payment/delivery
/// actions — same split as widgets/product_quick_edit.dart. Each
/// `show...Sheet` returns the updated order map on success (patched locally
/// when queued offline) or null if the merchant backed out.

Future<Map<String, dynamic>?> showMarkPaidSheet(
    BuildContext context, Map<String, dynamic> order) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _MarkPaidSheet(order: order),
  );
}

class _MarkPaidSheet extends StatefulWidget {
  final Map<String, dynamic> order;
  const _MarkPaidSheet({required this.order});

  @override
  State<_MarkPaidSheet> createState() => _MarkPaidSheetState();
}

class _MarkPaidSheetState extends State<_MarkPaidSheet> {
  late final _amount =
      TextEditingController(text: '${widget.order['total_ghs'] ?? ''}');
  String _method = 'cash';
  bool _busy = false;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true, child: const Text('Enter a valid amount')),
          backgroundColor: WabColors.danger));
      return;
    }
    final id = '${widget.order['id']}';
    final patch = {'payment_status': 'paid', 'payment_method': _method};
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      final res = await session.api
          .markOrderPaid(id, method: _method, amountGhs: amount);
      final updated = res['order'] as Map<String, dynamic>?;
      await OfflineCache.patchCachedOrder(id, patch);
      if (mounted)
        Navigator.pop(context, updated ?? {...widget.order, ...patch});
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-markpaid-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'POST',
          path: '/api/orders/$id/mark-paid',
          body: {'method': _method, 'amount_ghs': amount},
          description: 'Mark order #${widget.order['order_number']} paid',
        ));
        await OfflineCache.patchCachedOrder(id, patch);
        if (mounted) {
          Navigator.pop(context, {...widget.order, ...patch});
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(
                  liveRegion: true,
                  child: const Text(
                      'Offline — queued, will sync when back online'))));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Mark as paid',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('Order #${widget.order['order_number']}',
                style: const TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              children: [
                for (final m in const [
                  ('cash', 'Cash'),
                  ('momo', 'MoMo'),
                  ('card', 'Card')
                ])
                  ChoiceChip(
                    label: Text(m.$2),
                    selected: _method == m.$1,
                    onSelected: (_) => setState(() => _method = m.$1),
                    selectedColor: WabColors.accentSoft,
                    labelStyle: TextStyle(
                        color: _method == m.$1
                            ? WabColors.accentInk
                            : WabColors.muted,
                        fontWeight: FontWeight.w600),
                    side: const BorderSide(color: WabColors.line),
                    showCheckmark: false,
                  ),
              ],
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _amount,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration:
                  const InputDecoration(labelText: 'Amount received (GH₵)'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Confirm payment received'),
            ),
          ],
        ),
      ),
    );
  }
}

Future<Map<String, dynamic>?> showAssignRiderSheet(
    BuildContext context, Map<String, dynamic> order) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _AssignRiderSheet(order: order),
  );
}

class _AssignRiderSheet extends StatefulWidget {
  final Map<String, dynamic> order;
  const _AssignRiderSheet({required this.order});

  @override
  State<_AssignRiderSheet> createState() => _AssignRiderSheetState();
}

class _AssignRiderSheetState extends State<_AssignRiderSheet> {
  late final _name =
      TextEditingController(text: '${widget.order['rider_name'] ?? ''}');
  late final _phone =
      TextEditingController(text: '${widget.order['rider_phone'] ?? ''}');
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true, child: const Text("Enter the rider's name")),
          backgroundColor: WabColors.danger));
      return;
    }
    final phone = _phone.text.trim();
    final id = '${widget.order['id']}';
    final patch = {
      'rider_name': name,
      'rider_phone': phone.isEmpty ? null : phone,
      'delivery_status': 'assigned',
    };
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      final res =
          await session.api.assignRider(id, riderName: name, riderPhone: phone);
      final updated = res['order'] as Map<String, dynamic>?;
      await OfflineCache.patchCachedOrder(id, patch);
      if (mounted)
        Navigator.pop(context, updated ?? {...widget.order, ...patch});
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-rider-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/orders/$id/delivery',
          body: {
            'rider_name': name,
            if (phone.isNotEmpty) 'rider_phone': phone
          },
          description: 'Assign rider to order #${widget.order['order_number']}',
        ));
        await OfflineCache.patchCachedOrder(id, patch);
        if (mounted) {
          Navigator.pop(context, {...widget.order, ...patch});
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(
                  liveRegion: true,
                  child: const Text(
                      'Offline — queued, will sync when back online'))));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Assign rider',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('Order #${widget.order['order_number']}',
                style: const TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Rider name'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration:
                  const InputDecoration(labelText: 'Rider phone (optional)'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }
}

Future<Map<String, dynamic>?> showSetEstimatesSheet(
    BuildContext context, Map<String, dynamic> order) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _SetEstimatesSheet(order: order),
  );
}

class _SetEstimatesSheet extends StatefulWidget {
  final Map<String, dynamic> order;
  const _SetEstimatesSheet({required this.order});

  @override
  State<_SetEstimatesSheet> createState() => _SetEstimatesSheetState();
}

class _SetEstimatesSheetState extends State<_SetEstimatesSheet> {
  DateTime? _readyAt;
  DateTime? _deliveryAt;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _readyAt = DateTime.tryParse('${widget.order['estimated_ready_at'] ?? ''}');
    _deliveryAt =
        DateTime.tryParse('${widget.order['estimated_delivery_at'] ?? ''}');
  }

  Future<void> _save() async {
    if (_readyAt == null && _deliveryAt == null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true,
              child: const Text('Pick at least one estimate')),
          backgroundColor: WabColors.danger));
      return;
    }
    final id = '${widget.order['id']}';
    final patch = {
      if (_readyAt != null) 'estimated_ready_at': _readyAt!.toIso8601String(),
      if (_deliveryAt != null)
        'estimated_delivery_at': _deliveryAt!.toIso8601String(),
    };
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      final res = await session.api
          .setOrderEstimates(id, readyAt: _readyAt, deliveryAt: _deliveryAt);
      final updated = res['order'] as Map<String, dynamic>?;
      await OfflineCache.patchCachedOrder(id, patch);
      if (mounted)
        Navigator.pop(context, updated ?? {...widget.order, ...patch});
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-eta-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/orders/$id/estimates',
          body: patch,
          description: 'Set ETA for order #${widget.order['order_number']}',
        ));
        await OfflineCache.patchCachedOrder(id, patch);
        if (mounted) {
          Navigator.pop(context, {...widget.order, ...patch});
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(
                  liveRegion: true,
                  child: const Text(
                      'Offline — queued, will sync when back online'))));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _offsetRow(
      String label, DateTime? value, void Function(DateTime?) onChange) {
    final picked =
        value == null ? null : TimeOfDay.fromDateTime(value).format(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
            if (picked != null)
              TextButton(
                onPressed: () => onChange(null),
                child: Text('Clear ($picked)',
                    style: const TextStyle(color: WabColors.muted)),
              ),
          ],
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          children: [
            for (final mins in const [15, 30, 45, 60])
              ActionChip(
                label: Text('+$mins min'),
                onPressed: () =>
                    onChange(DateTime.now().add(Duration(minutes: mins))),
                backgroundColor: WabColors.accentSoft,
                labelStyle: const TextStyle(
                    color: WabColors.accentInk, fontWeight: FontWeight.w700),
                side: BorderSide.none,
              ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Set estimate',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            const Text(
                "The customer isn't notified automatically when you set this yet",
                style: TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            _offsetRow(
                'Ready by', _readyAt, (v) => setState(() => _readyAt = v)),
            const SizedBox(height: 20),
            _offsetRow('Out for delivery by', _deliveryAt,
                (v) => setState(() => _deliveryAt = v)),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Save estimate'),
            ),
          ],
        ),
      ),
    );
  }
}

Future<Map<String, dynamic>?> showRefundSheet(
  BuildContext context,
  Map<String, dynamic> order, {
  required double maxRefundable,
}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _RefundSheet(order: order, maxRefundable: maxRefundable),
  );
}

class _RefundSheet extends StatefulWidget {
  final Map<String, dynamic> order;
  final double maxRefundable;
  const _RefundSheet({required this.order, required this.maxRefundable});

  @override
  State<_RefundSheet> createState() => _RefundSheetState();
}

class _RefundSheetState extends State<_RefundSheet> {
  late final _amount =
      TextEditingController(text: widget.maxRefundable.toStringAsFixed(2));
  final _reason = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true, child: const Text('Enter a valid amount')),
          backgroundColor: WabColors.danger));
      return;
    }
    if (amount > widget.maxRefundable + 0.01) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true,
              child: Text(
                  'Cannot exceed the refundable balance of ${ghs(widget.maxRefundable)}')),
          backgroundColor: WabColors.danger));
      return;
    }
    final id = '${widget.order['id']}';
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      final res = await session.api
          .refundOrder(id, amountGhs: amount, reason: _reason.text.trim());
      if (mounted)
        Navigator.pop(context, res['refund'] as Map<String, dynamic>?);
    } on ApiException catch (e) {
      // Refunds hit a live gateway call and a server-side "already refunded"
      // ceiling check — unlike the other sheets here, this one is NOT queued
      // offline; a stale queued refund could double-refund once replayed
      // against a balance that's since changed.
      if (mounted) {
        final msg = e.status == 0
            ? "Refunds need a connection — try again once you're back online."
            : e.message;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(msg)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Refund',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(
                'Order #${widget.order['order_number']} — up to ${ghs(widget.maxRefundable)} refundable',
                style: const TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            TextField(
              controller: _amount,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration:
                  const InputDecoration(labelText: 'Amount to refund (GH₵)'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _reason,
              decoration: const InputDecoration(labelText: 'Reason (optional)'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _save,
              style: FilledButton.styleFrom(backgroundColor: WabColors.danger),
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Issue refund'),
            ),
          ],
        ),
      ),
    );
  }
}

Future<Map<String, dynamic>?> showAddNoteSheet(
    BuildContext context, Map<String, dynamic> order) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => _AddNoteSheet(order: order),
  );
}

class _AddNoteSheet extends StatefulWidget {
  final Map<String, dynamic> order;
  const _AddNoteSheet({required this.order});

  @override
  State<_AddNoteSheet> createState() => _AddNoteSheetState();
}

class _AddNoteSheetState extends State<_AddNoteSheet> {
  final _note = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final note = _note.text.trim();
    if (note.isEmpty) return;
    final id = '${widget.order['id']}';
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      final res = await session.api.addOrderNote(id, note);
      final updated = res['order'] as Map<String, dynamic>?;
      if (mounted) Navigator.pop(context, updated);
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'order-note-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/orders/$id/notes',
          body: {'note': note},
          description: 'Add note to order #${widget.order['order_number']}',
        ));
        if (mounted) {
          Navigator.pop(context, null);
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(
                  liveRegion: true,
                  child: const Text(
                      'Offline — queued, will sync when back online'))));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add note',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            const Text('Merchant-only — never shown to the customer',
                style: TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            TextField(
              controller: _note,
              maxLines: 4,
              autofocus: true,
              decoration: const InputDecoration(labelText: 'Note'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : const Text('Save note'),
            ),
          ],
        ),
      ),
    );
  }
}
