import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'order_detail.dart';

/// Orders as columns you move cards between.
///
/// The constraint that shapes this: changing an order's status messages the
/// customer on WhatsApp — confirmed, preparing, ready, delivered, cancelled all
/// notify — and a WhatsApp message cannot be unsent. A board turns that into a
/// casual gesture, and a mis-tap tells someone their food is ready when it is
/// not.
///
/// So the card moves immediately and the REQUEST waits behind an Undo. Undo
/// cancels it outright: nothing was sent, so there is nothing to reverse and no
/// apologetic second message.
///
/// `cancelled` is deliberately not a column. It is terminal, its message is the
/// worst one to send by accident, and cancelling already has a considered path
/// in the order detail screen.
const orderBoardColumns = <({String key, String label})>[
  (key: 'pending', label: 'New'),
  (key: 'confirmed', label: 'Confirmed'),
  (key: 'preparing', label: 'Preparing'),
  (key: 'ready', label: 'Ready'),
  (key: 'delivered', label: 'Delivered'),
];

const orderUndoWindow = Duration(seconds: 6);

class OrderBoardScreen extends StatefulWidget {
  const OrderBoardScreen({super.key});

  @override
  State<OrderBoardScreen> createState() => _OrderBoardScreenState();
}

class _OrderBoardScreenState extends State<OrderBoardScreen> {
  List<Map<String, dynamic>>? _orders;
  String? _error;

  /// orderId -> the status it had before the pending move, plus its timer.
  /// One pending move per order: moving the same card twice replaces the
  /// request, so the customer hears once about where it ended up.
  final Map<String, ({Timer timer, String from})> _pending = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    // Anything still waiting is sent rather than dropped — the merchant
    // already watched the card move, and silently discarding that would leave
    // the board disagreeing with the server on the next visit.
    for (final entry in _pending.entries) {
      entry.value.timer.cancel();
      _commit(entry.key, silent: true);
    }
    super.dispose();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _error = null);
    try {
      final session = context.read<Session>();
      final res = await session.api.get('/api/orders',
          query: {'business_id': session.businessId, 'limit': 200});
      if (!mounted) return;
      setState(() =>
          _orders = ((res['orders'] as List?) ?? []).cast<Map<String, dynamic>>());
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  void _move(Map<String, dynamic> order, String toStatus) {
    final id = '${order['id']}';
    if (order['status'] == toStatus) return;

    // Re-moving keeps the ORIGINAL status, so undo returns to where things
    // started rather than to the intermediate column.
    final existing = _pending.remove(id);
    existing?.timer.cancel();
    final from = existing?.from ?? '${order['status']}';

    setState(() => order['status'] = toStatus);

    final label = orderBoardColumns
        .firstWhere((c) => c.key == toStatus, orElse: () => (key: toStatus, label: toStatus))
        .label;
    _pending[id] = (
      timer: Timer(orderUndoWindow, () => _commit(id)),
      from: from,
    );

    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        duration: orderUndoWindow,
        content: Semantics(
          liveRegion: true,
          child: Text('#${order['order_number']} → $label'),
        ),
        action: SnackBarAction(
          label: 'Undo',
          textColor: Colors.white,
          onPressed: () => _undo(id),
        ),
        backgroundColor: WabColors.accentInk,
      ));
  }

  void _undo(String id) {
    final pending = _pending.remove(id);
    if (pending == null) return;
    pending.timer.cancel();
    final order = _orders?.firstWhere((o) => '${o['id']}' == id,
        orElse: () => <String, dynamic>{});
    if (order != null && order.isNotEmpty) {
      setState(() => order['status'] = pending.from);
    }
  }

  Future<void> _commit(String id, {bool silent = false}) async {
    final pending = _pending.remove(id);
    if (pending == null) return;
    pending.timer.cancel();
    final order = _orders?.firstWhere((o) => '${o['id']}' == id,
        orElse: () => <String, dynamic>{});
    if (order == null || order.isEmpty) return;

    try {
      await context
          .read<Session>()
          .api
          .patch('/api/orders/$id/status', body: {'status': order['status']});
    } on ApiException catch (e) {
      if (silent || !mounted) return;
      // The request failed, so the board is showing something that never
      // happened. Put it back rather than leave the two disagreeing.
      setState(() => order['status'] = pending.from);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e.message), backgroundColor: WabColors.danger));
    }
  }

  @override
  Widget build(BuildContext context) {
    final orders = _orders;
    return Scaffold(
      appBar: AppBar(title: const Text('Order board')),
      body: _error != null
          ? ErrorRetry(message: _error!, onRetry: _load)
          : orders == null
              ? const Center(
                  child: CircularProgressIndicator(color: WabColors.accent))
              : Column(
                  children: [
                    const Padding(
                      padding: EdgeInsets.fromLTRB(16, 8, 16, 4),
                      child: Text(
                        'Moving a card updates the order. The customer is '
                        'messaged on WhatsApp — you get a few seconds to undo '
                        'before that is sent. To cancel an order, open it.',
                        style:
                            TextStyle(fontSize: 12.5, color: WabColors.muted),
                      ),
                    ),
                    Expanded(child: _board(orders)),
                  ],
                ),
    );
  }

  Widget _board(List<Map<String, dynamic>> orders) {
    final known = orderBoardColumns.map((c) => c.key).toSet();
    // Anything outside the flow — a cancelled order, or the legacy `paid`
    // status — is still shown. Hiding an order because its status is
    // unfamiliar is silent loss; it simply is not a destination.
    final other = orders.where((o) => !known.contains('${o['status']}')).toList();

    return ListView(
      // Horizontal so columns stay full height and swipeable, rather than
      // collapsing into a list that is no longer a board.
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.all(12),
      children: [
        for (final col in orderBoardColumns)
          _column(col.label, orders.where((o) => '${o['status']}' == col.key).toList(),
              target: col.key),
        if (other.isNotEmpty) _column('Other', other, target: null),
      ],
    );
  }

  Widget _column(String label, List<Map<String, dynamic>> cards,
      {required String? target}) {
    return Container(
      width: 220,
      margin: const EdgeInsets.only(right: 12),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: WabColors.bg2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: WabColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(label,
                    style: const TextStyle(
                        fontWeight: FontWeight.w800, fontSize: 13)),
              ),
              Text('${cards.length}',
                  style: const TextStyle(
                      color: WabColors.muted, fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: cards.isEmpty
                ? const Text('Nothing here',
                    style: TextStyle(fontSize: 12, color: WabColors.muted2))
                : ListView(
                    children: [for (final o in cards) _card(o, target)],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _card(Map<String, dynamic> o, String? column) {
    final items = (o['items'] as List?)?.length ?? 0;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
        title: Text('#${o['order_number']}',
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        subtitle: Text(
            '${ghs(o['total_ghs'])} · $items item${items == 1 ? '' : 's'}'
            '${o['payment_status'] == 'paid' ? ' · paid' : ''}',
            style: const TextStyle(fontSize: 12)),
        // Dragging between horizontally-scrolling columns is unreliable on a
        // narrow screen, so the move is a menu. It is also the only version
        // reachable with a screen reader.
        trailing: column == null
            ? null
            : PopupMenuButton<String>(
                tooltip: 'Move order ${o['order_number']}',
                icon: const Icon(Icons.more_vert_rounded, size: 18),
                onSelected: (status) => _move(o, status),
                itemBuilder: (_) => [
                  for (final c in orderBoardColumns)
                    if (c.key != o['status'])
                      PopupMenuItem(value: c.key, child: Text('Move to ${c.label}')),
                ],
              ),
        onTap: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => OrderDetailScreen(orderId: '${o['id']}'))),
      ),
    );
  }
}
