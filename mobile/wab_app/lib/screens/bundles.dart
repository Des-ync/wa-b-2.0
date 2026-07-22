import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/catalog_api.dart';
import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Fixed-price groupings of existing products ("Lunch combo: Jollof + drink"),
/// sold on the storefront and in WhatsApp as one line item.
class BundlesScreen extends StatefulWidget {
  const BundlesScreen({super.key});

  @override
  State<BundlesScreen> createState() => _BundlesScreenState();
}

class _BundlesScreenState extends State<BundlesScreen> {
  List<Map<String, dynamic>> _bundles = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _bundles.isEmpty;
      _error = null;
    });
    try {
      final session = context.read<Session>();
      final res = await session.api.getBundles(session.businessId!);
      if (!mounted) return;
      setState(() {
        _bundles = ((res['bundles'] as List?) ?? []).cast<Map<String, dynamic>>();
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

  Future<void> _edit([Map<String, dynamic>? bundle]) async {
    final changed = await Navigator.of(context)
        .push<bool>(MaterialPageRoute(builder: (_) => BundleEditScreen(bundle: bundle)));
    if (changed == true) _load();
  }

  Future<void> _delete(Map<String, dynamic> bundle) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete bundle?'),
        content: Text('Remove "${bundle['name']}"? The individual products are unaffected.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete', style: TextStyle(color: WabColors.danger))),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    try {
      await context.read<Session>().api.deleteBundle('${bundle['id']}');
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Bundles')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add bundle'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : _bundles.isEmpty
                  ? const Center(
                      child: EmptyState(
                          icon: Icons.widgets_rounded,
                          title: 'No bundles yet',
                          subtitle:
                              'Group a few products into one fixed-price combo customers can order as a single item.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: WabColors.accent,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                        physics: const AlwaysScrollableScrollPhysics(),
                        itemCount: _bundles.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (ctx, i) {
                          final b = _bundles[i];
                          final items = (b['items'] as List? ?? []);
                          final itemSummary = items
                              .map((it) => '${it['quantity']}× ${it['name']}')
                              .join(', ');
                          return Card(
                            child: ListTile(
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                              title: Text('${b['name']}',
                                  style: const TextStyle(fontWeight: FontWeight.w700)),
                              subtitle: Text(itemSummary.isEmpty ? 'No items' : itemSummary,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(color: WabColors.muted)),
                              trailing: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(ghs(b['price_ghs']),
                                      style:
                                          const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                                  const SizedBox(height: 4),
                                  StatusChip(b['active'] == true ? 'active' : 'unpaid',
                                      label: b['active'] == true ? 'active' : 'off'),
                                ],
                              ),
                              onTap: () => _edit(b),
                              onLongPress: () => _delete(b),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}

class BundleEditScreen extends StatefulWidget {
  final Map<String, dynamic>? bundle;
  const BundleEditScreen({super.key, this.bundle});

  @override
  State<BundleEditScreen> createState() => _BundleEditScreenState();
}

class _BundleEditScreenState extends State<BundleEditScreen> {
  late final _name = TextEditingController(text: widget.bundle?['name']?.toString());
  late final _price = TextEditingController(text: widget.bundle?['price_ghs']?.toString());
  late final _desc = TextEditingController(text: widget.bundle?['description']?.toString());
  late bool _active = widget.bundle?['active'] != false;
  final Map<String, int> _quantities = {}; // product_id -> quantity
  List<Map<String, dynamic>> _products = [];
  bool _loadingProducts = true;
  bool _busy = false;

  bool get isEdit => widget.bundle != null;

  @override
  void initState() {
    super.initState();
    for (final it in (widget.bundle?['items'] as List? ?? [])) {
      _quantities['${it['product_id']}'] = (it['quantity'] as num?)?.toInt() ?? 1;
    }
    _loadProducts();
  }

  Future<void> _loadProducts() async {
    try {
      final session = context.read<Session>();
      final res =
          await session.api.get('/api/products', query: {'business_id': session.businessId});
      if (!mounted) return;
      setState(() {
        _products = ((res['products'] as List?) ?? []).cast<Map<String, dynamic>>();
        _loadingProducts = false;
      });
    } catch (e) {
      if (mounted) setState(() => _loadingProducts = false);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final price = double.tryParse(_price.text.trim());
    if (name.isEmpty || price == null || price < 0) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Name and a valid price are required'), backgroundColor: WabColors.danger));
      return;
    }
    if (_quantities.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Pick at least one product'), backgroundColor: WabColors.danger));
      return;
    }
    setState(() => _busy = true);
    final session = context.read<Session>();
    final items = _quantities.entries
        .map((e) => {'product_id': e.key, 'quantity': e.value})
        .toList();
    try {
      if (isEdit) {
        await session.api.updateBundle('${widget.bundle!['id']}',
            name: name,
            priceGhs: price,
            description: _desc.text.trim(),
            items: items,
            active: _active);
      } else {
        await session.api.createBundle(session.businessId!,
            name: name,
            priceGhs: price,
            description: _desc.text.trim(),
            items: items,
            active: _active);
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(isEdit ? 'Edit bundle' : 'New bundle')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
        children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 12),
          TextField(
              controller: _desc,
              decoration: const InputDecoration(labelText: 'Description (optional)')),
          const SizedBox(height: 12),
          TextField(
              controller: _price,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Bundle price (GH₵)')),
          const SizedBox(height: 8),
          SwitchListTile(
            value: _active,
            onChanged: (v) => setState(() => _active = v),
            title: const Text('Active', style: TextStyle(fontWeight: FontWeight.w600)),
            activeThumbColor: WabColors.accent,
            contentPadding: EdgeInsets.zero,
          ),
          const SizedBox(height: 20),
          const Text('Products in this bundle',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          if (_loadingProducts)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(child: CircularProgressIndicator(color: WabColors.accent)),
            )
          else if (_products.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text('Add products first, then come back to build a bundle.',
                  style: TextStyle(color: WabColors.muted)),
            )
          else
            Card(
              child: Column(
                children: [
                  for (final p in _products) _productRow(p),
                ],
              ),
            ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: _busy
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                : Text(isEdit ? 'Save changes' : 'Create bundle'),
          ),
        ],
      ),
    );
  }

  Widget _productRow(Map<String, dynamic> p) {
    final id = '${p['id']}';
    final qty = _quantities[id];
    final selected = qty != null;
    return ListTile(
      dense: true,
      title: Text('${p['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text(ghs(p['price_ghs']), style: const TextStyle(color: WabColors.muted, fontSize: 12)),
      leading: Checkbox(
        value: selected,
        activeColor: WabColors.accent,
        onChanged: (v) => setState(() {
          if (v == true) {
            _quantities[id] = 1;
          } else {
            _quantities.remove(id);
          }
        }),
      ),
      trailing: selected
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: qty > 1 ? () => setState(() => _quantities[id] = qty - 1) : null,
                  icon: const Icon(Icons.remove_circle_outline_rounded, size: 20),
                ),
                Text('$qty', style: const TextStyle(fontWeight: FontWeight.w700)),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: () => setState(() => _quantities[id] = qty + 1),
                  icon: const Icon(Icons.add_circle_outline_rounded, size: 20),
                ),
              ],
            )
          : null,
      onTap: () => setState(() {
        if (selected) {
          _quantities.remove(id);
        } else {
          _quantities[id] = 1;
        }
      }),
    );
  }
}
