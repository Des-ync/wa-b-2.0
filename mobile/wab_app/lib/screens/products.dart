import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ProductsScreen extends StatefulWidget {
  const ProductsScreen({super.key});

  @override
  State<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends State<ProductsScreen> {
  int _reloadKey = 0;

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api
        .get('/api/products', query: {'business_id': session.businessId});
    return ((res['products'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _editSheet([Map<String, dynamic>? product]) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => _ProductSheet(product: product),
    );
    if (changed == true) setState(() => _reloadKey++);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Products')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _editSheet(),
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add product'),
      ),
      body: AsyncList<Map<String, dynamic>>(
        key: ValueKey(_reloadKey),
        load: _load,
        emptyTitle: 'No products yet',
        emptySubtitle: 'Add products so customers can browse and order them on WhatsApp.',
        emptyIcon: Icons.inventory_2_rounded,
        itemBuilder: (ctx, p) {
          final inStock = p['in_stock'] == true;
          final qty = p['stock_qty'];
          return Card(
            child: ListTile(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              title: Text('${p['name']}',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(
                  [
                    '${p['category'] ?? 'general'}',
                    if (qty != null) '$qty in stock',
                  ].join(' · '),
                  style: const TextStyle(color: WabColors.muted)),
              trailing: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(ghs(p['price_ghs']),
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                  const SizedBox(height: 4),
                  StatusChip(inStock ? 'active' : 'out of stock'),
                ],
              ),
              onTap: () => _editSheet(p),
            ),
          );
        },
      ),
    );
  }
}

class _ProductSheet extends StatefulWidget {
  final Map<String, dynamic>? product;
  const _ProductSheet({this.product});

  @override
  State<_ProductSheet> createState() => _ProductSheetState();
}

class _ProductSheetState extends State<_ProductSheet> {
  late final _name = TextEditingController(text: widget.product?['name']?.toString());
  late final _desc =
      TextEditingController(text: widget.product?['description']?.toString());
  late final _price =
      TextEditingController(text: widget.product?['price_ghs']?.toString());
  late final _category =
      TextEditingController(text: widget.product?['category']?.toString());
  late final _stockQty =
      TextEditingController(text: widget.product?['stock_qty']?.toString() ?? '');
  late bool _inStock = widget.product?['in_stock'] != false;
  bool _busy = false;

  bool get isEdit => widget.product != null;

  Future<void> _save() async {
    final name = _name.text.trim();
    final price = double.tryParse(_price.text.trim());
    if (name.isEmpty || price == null || price < 0) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Name and a valid price are required'),
          backgroundColor: WabColors.danger));
      return;
    }
    setState(() => _busy = true);
    final session = context.read<Session>();
    final body = {
      'name': name,
      'description': _desc.text.trim().isEmpty ? null : _desc.text.trim(),
      'price_ghs': price,
      'category': _category.text.trim().isEmpty ? 'general' : _category.text.trim(),
      'in_stock': _inStock,
      'stock_qty':
          _stockQty.text.trim().isEmpty ? null : int.tryParse(_stockQty.text.trim()),
    };
    try {
      if (isEdit) {
        await session.api
            .patch('/api/products/${widget.product!['id']}', body: body);
      } else {
        await session.api.post('/api/products',
            body: {...body, 'business_id': session.businessId});
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete product?'),
        content: Text('Remove "${widget.product!['name']}" from your catalogue?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete', style: TextStyle(color: WabColors.danger))),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await context
          .read<Session>()
          .api
          .delete('/api/products/${widget.product!['id']}');
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding:
          EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(isEdit ? 'Edit product' : 'New product',
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                if (isEdit)
                  IconButton(
                      onPressed: _busy ? null : _delete,
                      icon: const Icon(Icons.delete_outline_rounded,
                          color: WabColors.danger)),
              ],
            ),
            const SizedBox(height: 20),
            TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 12),
            TextField(
                controller: _desc,
                decoration: const InputDecoration(labelText: 'Description (optional)')),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                      controller: _price,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: 'Price (GH₵)')),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                      controller: _stockQty,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'Stock qty', hintText: 'blank = untracked')),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
                controller: _category,
                decoration: const InputDecoration(labelText: 'Category')),
            const SizedBox(height: 8),
            SwitchListTile(
              value: _inStock,
              onChanged: (v) => setState(() => _inStock = v),
              title: const Text('In stock',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              activeThumbColor: WabColors.accent,
              contentPadding: EdgeInsets.zero,
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22, height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.5, color: Colors.white))
                  : Text(isEdit ? 'Save changes' : 'Add product'),
            ),
          ],
        ),
      ),
    );
  }
}
