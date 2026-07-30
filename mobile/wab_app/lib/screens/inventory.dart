import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/inventory_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Stock: what is running low, what it costs, and what has moved.
///
/// The `/api/inventory` module was backend-complete and unreachable except
/// for one home-screen tile. A merchant could see that something was running
/// low and had no way to record restocking it, so the warning never cleared
/// and counts drifted until each product was edited by hand.
///
/// Three tabs, in the order a shopkeeper actually needs them: what to buy,
/// what it earns, what happened.
class InventoryScreen extends StatefulWidget {
  const InventoryScreen({super.key});

  @override
  State<InventoryScreen> createState() => _InventoryScreenState();
}

class _InventoryScreenState extends State<InventoryScreen> {
  List<dynamic> _lowStock = [];
  List<dynamic> _margins = [];
  List<dynamic> _movements = [];
  List<dynamic> _suppliers = [];
  String? _error;
  bool _loading = true;

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
      _loading = _lowStock.isEmpty && _margins.isEmpty;
      _error = null;
    });
    try {
      final api = session.api;
      final results = await Future.wait([
        api.getReorderSuggestions(bid),
        api.getMargins(bid),
        api.getStockMovements(bid),
        // Suppliers only populate a picker; a failure must not blank the page.
        api.getSuppliers(bid).catchError((_) => <String, dynamic>{}),
      ]);
      if (!mounted) return;
      setState(() {
        _lowStock = (results[0]['suggestions'] as List?) ?? [];
        _margins = (results[1]['products'] as List?) ?? [];
        _movements = (results[2]['movements'] as List?) ?? [];
        _suppliers = (results[3]['suppliers'] as List?) ?? [];
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

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: error ? WabColors.danger : WabColors.accentInk,
    ));
  }

  /// Stock coming IN — a delivery. Adds to the count and records why.
  Future<void> _restock(Map<String, dynamic> product) async {
    final qtyCtrl = TextEditingController(
        text: '${product['suggested_reorder_qty'] ?? ''}');
    final costCtrl = TextEditingController();
    String? supplierId = product['supplier_id']?.toString();

    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: StatefulBuilder(
          builder: (ctx, setSheet) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Restock ${product['name']}',
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              Text('${product['stock_qty'] ?? 0} in stock now',
                  style: const TextStyle(color: WabColors.muted)),
              const SizedBox(height: 16),
              TextField(
                controller: qtyCtrl,
                autofocus: true,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'How many arrived'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: costCtrl,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                    labelText: 'Cost per unit (optional)', prefixText: 'GH¢ '),
              ),
              if (_suppliers.isNotEmpty) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String?>(
                  initialValue: supplierId,
                  decoration: const InputDecoration(labelText: 'Supplier (optional)'),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('No supplier')),
                    for (final s in _suppliers)
                      DropdownMenuItem(
                          value: '${s['id']}', child: Text('${s['name']}')),
                  ],
                  onChanged: (v) => setSheet(() => supplierId = v),
                ),
              ],
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Add to stock'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (saved != true || !mounted) return;

    final qty = int.tryParse(qtyCtrl.text.trim());
    if (qty == null || qty <= 0) {
      _toast('Enter how many arrived.', error: true);
      return;
    }
    final session = context.read<Session>();
    try {
      await session.api.restock(session.businessId!,
          productId: '${product['id']}',
          quantity: qty,
          unitCostGhs: double.tryParse(costCtrl.text.trim()),
          supplierId: supplierId);
      if (!mounted) return;
      _toast('${product['name']} restocked.');
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    }
  }

  /// A stock TAKE — "I counted 7". Distinct from a restock because it
  /// corrects the record rather than describing a delivery, and the ledger
  /// needs to tell those apart.
  Future<void> _adjust(Map<String, dynamic> product) async {
    final ctrl = TextEditingController(text: '${product['stock_qty'] ?? 0}');

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Count ${product['name']}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Set the exact number on your shelf right now.',
                style: TextStyle(color: WabColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              autofocus: true,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Counted'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save count')),
        ],
      ),
    );
    if (saved != true || !mounted) return;

    final n = int.tryParse(ctrl.text.trim());
    if (n == null || n < 0) {
      _toast('Enter a whole number, zero or more.', error: true);
      return;
    }
    final session = context.read<Session>();
    try {
      await session.api.adjustStock(session.businessId!,
          productId: '${product['id']}', newQuantity: n, note: 'Stock take');
      if (!mounted) return;
      _toast('Count saved.');
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Stock'),
          bottom: const TabBar(tabs: [
            Tab(text: 'Running low'),
            Tab(text: 'Margins'),
            Tab(text: 'History'),
          ]),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
            : _error != null
                ? ErrorRetry(message: _error!, onRetry: _load)
                : TabBarView(children: [
                    _lowStockTab(),
                    _marginsTab(),
                    _historyTab(),
                  ]),
      ),
    );
  }

  Widget _refreshable(Widget child) =>
      RefreshIndicator(onRefresh: _load, color: WabColors.accent, child: child);

  Widget _lowStockTab() {
    if (_lowStock.isEmpty) {
      return _refreshable(ListView(children: const [
        SizedBox(height: 80),
        EmptyState(
            icon: Icons.inventory_2_rounded,
            title: 'Nothing running low',
            subtitle: 'Products drop in here when they reach their reorder level.'),
      ]));
    }
    return _refreshable(ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _lowStock.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        final p = _lowStock[i] as Map<String, dynamic>;
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${p['name']}',
                              style: const TextStyle(fontWeight: FontWeight.w800)),
                          Text(
                              p['supplier_name'] != null
                                  ? 'Supplier: ${p['supplier_name']}'
                                  : 'No supplier on file',
                              style: const TextStyle(
                                  color: WabColors.muted, fontSize: 13)),
                        ],
                      ),
                    ),
                    Text('${p['stock_qty'] ?? 0} left',
                        style: const TextStyle(
                            fontWeight: FontWeight.w800, color: WabColors.warning)),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => _restock(p),
                        icon: const Icon(Icons.add_rounded, size: 18),
                        label: Text('Restock ${p['suggested_reorder_qty'] ?? ''}'.trim()),
                      ),
                    ),
                    const SizedBox(width: 10),
                    OutlinedButton(
                      onPressed: () => _adjust(p),
                      child: const Text('Count'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    ));
  }

  Widget _marginsTab() {
    final priced = _margins.where((p) => p['margin_ghs'] != null).toList();
    if (priced.isEmpty) {
      return _refreshable(ListView(children: const [
        SizedBox(height: 80),
        EmptyState(
            icon: Icons.percent_rounded,
            title: 'No cost prices yet',
            subtitle: 'Add a cost price to a product to see what it earns.'),
      ]));
    }
    return _refreshable(ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: priced.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final p = priced[i] as Map<String, dynamic>;
        final pct = double.tryParse('${p['margin_pct'] ?? ''}') ?? 0;
        return ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${p['name']}',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
              '${ghs(p['cost_price_ghs'])} cost → ${ghs(p['price_ghs'])}',
              style: const TextStyle(color: WabColors.muted, fontSize: 13)),
          trailing: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(ghs(p['margin_ghs']),
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              Text('${pct.toStringAsFixed(0)}%',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      // A thin margin is worth noticing before a discount is
                      // offered on top of it.
                      color: pct < 15 ? WabColors.danger : WabColors.muted)),
            ],
          ),
        );
      },
    ));
  }

  Widget _historyTab() {
    if (_movements.isEmpty) {
      return _refreshable(ListView(children: const [
        SizedBox(height: 80),
        EmptyState(icon: Icons.history_rounded, title: 'No stock movements yet'),
      ]));
    }
    return _refreshable(ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _movements.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final m = _movements[i] as Map<String, dynamic>;
        final delta = (m['quantity_delta'] as num?)?.toInt() ?? 0;
        final type = '${m['type'] ?? ''}';
        final (label, colour) = switch (type) {
          'sale' => ('Sold', WabColors.muted),
          'restock' => ('Restocked', WabColors.accentInk),
          'return' => ('Returned', WabColors.accentInk),
          _ => ('Adjusted', WabColors.warning),
        };
        return ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${m['product_name'] ?? m['name'] ?? 'Product'}',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
              '$label · ${timeAgo(m['created_at'])}'
              '${m['note'] != null ? ' · ${m['note']}' : ''}',
              style: const TextStyle(color: WabColors.muted, fontSize: 13)),
          trailing: Text(delta > 0 ? '+$delta' : '$delta',
              style: TextStyle(fontWeight: FontWeight.w800, color: colour)),
        );
      },
    ));
  }
}
