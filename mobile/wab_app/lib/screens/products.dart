import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/catalog_api.dart';
import '../api/product_ops_api.dart';
import '../api/client.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/product_quick_edit.dart';
import '../widgets/voice_update_button.dart';
import 'barcode_scanner.dart';
import 'bundles.dart';
import 'categories.dart';
import 'product_options.dart';

class ProductsScreen extends StatefulWidget {
  const ProductsScreen({super.key});

  @override
  State<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends State<ProductsScreen> {
  int _reloadKey = 0;
  bool _offline = false;
  List<Map<String, dynamic>> _products = [];
  StreamSubscription<List<ConnectivityResult>>? _connSub;
  final _searchCtrl = TextEditingController();
  String _query = '';

  /// Ids ticked for a bulk action. Empty means normal browsing — the selection
  /// bar and the checkboxes only exist while something is selected, so the
  /// list stays uncluttered for the common case.
  final Set<String> _selected = {};
  bool _reordering = false;

  List<Map<String, dynamic>> _filter(List<Map<String, dynamic>> items) {
    if (_query.isEmpty) return items;
    final q = _query.toLowerCase();
    return items
        .where((p) =>
            '${p['name']}'.toLowerCase().contains(q) ||
            '${p['category'] ?? ''}'.toLowerCase().contains(q))
        .toList();
  }

  @override
  void initState() {
    super.initState();
    // Pick up anything queued from a previous offline session as soon as
    // we're back, and keep watching for reconnects while this screen lives.
    _tryFlush();
    _connSub = Connectivity().onConnectivityChanged.listen((results) {
      if (results.any((r) => r != ConnectivityResult.none)) _tryFlush();
    });
  }

  @override
  void dispose() {
    _connSub?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _tryFlush() async {
    if (!mounted) return;
    final session = context.read<Session>();
    await OfflineQueue.flush(session.api);
    if (mounted) setState(() => _reloadKey++);
  }

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    try {
      final res = await session.api
          .get('/api/products', query: {'business_id': session.businessId});
      final products =
          ((res['products'] as List?) ?? []).cast<Map<String, dynamic>>();
      unawaited(OfflineCache.saveProducts(products));
      _products = products;
      if (mounted) setState(() => _offline = false);
      return products;
    } catch (e) {
      final cached = await OfflineCache.loadProducts();
      if (cached != null) {
        _products = cached;
        if (mounted) setState(() => _offline = true);
        return cached;
      }
      rethrow;
    }
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

  Future<void> _quickEdit(Map<String, dynamic> product) async {
    final changed = await showProductQuickEdit(context, product);
    if (changed == true) setState(() => _reloadKey++);
  }

  Future<void> _toggleStock(Map<String, dynamic> product) async {
    final id = '${product['id']}';
    final newValue = !(product['in_stock'] == true);
    final body = {'in_stock': newValue};
    final session = context.read<Session>();
    try {
      await session.api.patch('/api/products/$id', body: body);
      await OfflineCache.patchCachedProduct(id, body);
      if (mounted) setState(() => _reloadKey++);
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'product-stock-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/products/$id',
          body: body,
          description:
              'Mark "${product['name']}" ${newValue ? 'in stock' : 'out of stock'}',
        ));
        await OfflineCache.patchCachedProduct(id, body);
        if (mounted) {
          setState(() => _reloadKey++);
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Offline — queued, will sync when back online')));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _openScanner() async {
    await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => BarcodeScannerScreen(products: _products)));
    if (mounted) setState(() => _reloadKey++);
  }

  Future<void> _openCategories() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const CategoriesScreen()));
    if (mounted) setState(() => _reloadKey++);
  }

  void _toggleSelected(String id) {
    setState(() {
      if (!_selected.remove(id)) _selected.add(id);
    });
  }

  /// Applies one change to everything ticked.
  ///
  /// The `notified` count is surfaced, not swallowed: marking a batch back in
  /// stock messages every customer who asked to be told, and a merchant should
  /// learn that here rather than from the bill.
  Future<void> _bulkSet(Map<String, dynamic> changes, String label) async {
    final session = context.read<Session>();
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    try {
      final res = await session.api.bulkUpdateProducts(session.businessId!,
          productIds: ids, changes: changes);
      final updated = res['updated'] ?? ids.length;
      final notified = (res['notified'] as num?)?.toInt() ?? 0;
      if (!mounted) return;
      setState(() {
        _selected.clear();
        _reloadKey++;
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Semantics(
          liveRegion: true,
          child: Text(notified > 0
              ? '$updated updated · $notified customer${notified == 1 ? '' : 's'} told it is back in stock'
              : '$updated updated'),
        ),
        backgroundColor: WabColors.accentInk,
      ));
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  /// Copies a product, with its sizes and extras.
  Future<void> _duplicate(Map<String, dynamic> product) async {
    final session = context.read<Session>();
    try {
      final res = await session.api.duplicateProduct('${product['id']}');
      final v = (res['variants_copied'] as num?)?.toInt() ?? 0;
      final a = (res['addons_copied'] as num?)?.toInt() ?? 0;
      final extras = [
        if (v > 0) '$v variant${v == 1 ? '' : 's'}',
        if (a > 0) '$a add-on${a == 1 ? '' : 's'}',
      ].join(' and ');
      if (!mounted) return;
      setState(() => _reloadKey++);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Semantics(
          liveRegion: true,
          // The copy is hidden on purpose — it shares the original's price and
          // photo. Saying so here stops "why is my copy not in the shop".
          child: Text(extras.isEmpty
              ? 'Copy created — hidden until you publish it'
              : 'Copy created with $extras — hidden until you publish it'),
        ),
        backgroundColor: WabColors.accentInk,
      ));
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _saveOrder(List<Map<String, dynamic>> ordered) async {
    final session = context.read<Session>();
    try {
      await session.api.reorderProducts(
          session.businessId!, ordered.map((p) => '${p['id']}').toList());
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
        // Re-read rather than leave the list in an order that was never
        // stored — otherwise the screen quietly disagrees with the server.
        setState(() => _reloadKey++);
      }
    }
  }

  /// Shown only while something is ticked, so the list stays uncluttered for
  /// the common case of just browsing.
  Widget _selectionBar() {
    final n = _selected.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: WabColors.accentSoft,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: WabColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('$n selected',
                    style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: WabColors.accentInk)),
              ),
              TextButton(
                onPressed: () => setState(_selected.clear),
                child: const Text('Clear'),
              ),
            ],
          ),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              OutlinedButton(
                onPressed: () => _bulkSet({'in_stock': true}, 'in stock'),
                child: const Text('In stock'),
              ),
              OutlinedButton(
                onPressed: () => _bulkSet({'in_stock': false}, 'out of stock'),
                child: const Text('Out of stock'),
              ),
              OutlinedButton(
                onPressed: () => _bulkSet({'hidden': true}, 'hidden'),
                child: const Text('Hide'),
              ),
              OutlinedButton(
                onPressed: () => _bulkSet({'hidden': false}, 'shown'),
                child: const Text('Show'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _openBundles() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const BundlesScreen()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Products'),
        actions: [
          VoiceUpdateButton(
            productsProvider: () => _products,
            onUpdated: () => setState(() => _reloadKey++),
          ),
          IconButton(
            tooltip: _reordering ? 'Done reordering' : 'Reorder products',
            onPressed: () => setState(() {
              _reordering = !_reordering;
              // Reordering and selecting are different modes; leaving ticks
              // behind would make the bulk bar hover over a list the merchant
              // is now dragging.
              if (_reordering) _selected.clear();
            }),
            icon: Icon(
                _reordering ? Icons.check_rounded : Icons.swap_vert_rounded),
          ),
          IconButton(
            tooltip: 'Scan barcode / QR',
            onPressed: _openScanner,
            icon: const Icon(Icons.qr_code_scanner_rounded),
          ),
          PopupMenuButton<String>(
            onSelected: (v) =>
                v == 'categories' ? _openCategories() : _openBundles(),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'categories', child: Text('Categories')),
              PopupMenuItem(value: 'bundles', child: Text('Bundles')),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _editSheet(),
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add product'),
      ),
      body: Column(
        children: [
          if (_offline) const OfflineBanner(),
          // Search is hidden while reordering: dragging within a filtered
          // list would save an order that does not match what the merchant
          // sees, because the hidden rows keep their old positions.
          if (!_reordering)
            SearchField(
              controller: _searchCtrl,
              hint: 'Search products',
              onChanged: (v) => setState(() => _query = v),
            ),
          if (_reordering)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Text(
                'Drag to set the order customers see. Featured products still '
                'come first — and in WhatsApp, what sells most is shown before '
                'your chosen order.',
                style: TextStyle(fontSize: 12.5, color: WabColors.muted),
              ),
            ),
          if (_selected.isNotEmpty) _selectionBar(),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey('$_reloadKey-$_reordering'),
              load: _load,
              transform: _reordering ? null : _filter,
              onReorder: _reordering ? _saveOrder : null,
              keyOf: _reordering ? (p) => '${p['id']}' : null,
              emptyFilteredTitle: 'No products match "$_query"',
              emptyTitle: 'No products yet',
              emptySubtitle:
                  'Add products so customers can browse and order them on WhatsApp.',
              emptyIcon: Icons.inventory_2_rounded,
              itemBuilder: (ctx, p) {
                final inStock = p['in_stock'] == true;
                final qty = p['stock_qty'];
                final featured = p['featured'] == true;
                return Card(
                  child: ListTile(
                    // The trailing stack — price above a tappable status chip
                    // with a 44px touch target — is taller than a two-line
                    // tile allows, and overflowed by 15px. That predates the
                    // menu button; no test had ever rendered this screen.
                    // Three-line gives it the room without shrinking the
                    // target or hiding the price.
                    isThreeLine: true,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                    // A checkbox only once a selection exists, so the list is
                    // uncluttered for the common case of just browsing.
                    leading: _selected.isEmpty
                        ? null
                        : Checkbox(
                            value: _selected.contains('${p['id']}'),
                            onChanged: (_) => _toggleSelected('${p['id']}'),
                            activeColor: WabColors.accent,
                          ),
                    title: Row(
                      children: [
                        if (featured) ...[
                          Semantics(
                            label: 'Featured',
                            child: const Icon(Icons.star_rounded,
                                size: 16, color: WabColors.gold),
                          ),
                          const SizedBox(width: 4),
                        ],
                        Flexible(
                          child: Text('${p['name']}',
                              overflow: TextOverflow.ellipsis,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w700)),
                        ),
                      ],
                    ),
                    subtitle: Text(
                        [
                          ghs(p['price_ghs']),
                          '${p['category'] ?? 'general'}',
                          if (qty != null) '$qty in stock',
                        ].join(' · '),
                        style: const TextStyle(color: WabColors.muted)),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Price moved to the subtitle: the old stack of
                        // price-above-chip was 15px taller than a ListTile
                        // allows and overflowed — a pre-existing bug, since
                        // nothing had ever rendered this screen in a test.
                        // Keeping the chip alone preserves its 44px touch
                        // target instead of shrinking it to fit.
                        Semantics(
                          button: true,
                          label: inStock
                              ? 'In stock. Tap to mark out of stock.'
                              : 'Out of stock. Tap to mark in stock.',
                          child: Material(
                            color: Colors.transparent,
                            child: InkWell(
                              borderRadius: BorderRadius.circular(999),
                              onTap: () => _toggleStock(p),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 4, vertical: 10),
                                child: ExcludeSemantics(
                                  child: StatusChip(
                                      inStock ? 'active' : 'out of stock'),
                                ),
                              ),
                            ),
                          ),
                        ),
                        // Quick edit lost its long-press to selection, so it
                        // lives here alongside Duplicate.
                        if (_selected.isEmpty && !_reordering)
                          PopupMenuButton<String>(
                            tooltip: 'More for ${p['name']}',
                            onSelected: (v) {
                              if (v == 'quick') _quickEdit(p);
                              if (v == 'duplicate') _duplicate(p);
                            },
                            itemBuilder: (_) => const [
                              PopupMenuItem(
                                  value: 'quick', child: Text('Quick edit')),
                              PopupMenuItem(
                                  value: 'duplicate', child: Text('Duplicate')),
                            ],
                          ),
                      ],
                    ),
                    // Long-press starts a selection. Quick edit moves onto the
                    // row's own menu, because a merchant reaching for "select
                    // several" and getting an edit sheet is the more annoying
                    // of the two mistakes.
                    onTap: _selected.isEmpty
                        ? () => _editSheet(p)
                        : () => _toggleSelected('${p['id']}'),
                    onLongPress: () => _toggleSelected('${p['id']}'),
                  ),
                );
              },
            ),
          ),
        ],
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
  late final _name =
      TextEditingController(text: widget.product?['name']?.toString());
  late final _desc =
      TextEditingController(text: widget.product?['description']?.toString());
  late final _price =
      TextEditingController(text: widget.product?['price_ghs']?.toString());
  late final _category =
      TextEditingController(text: widget.product?['category']?.toString());
  late final _stockQty = TextEditingController(
      text: widget.product?['stock_qty']?.toString() ?? '');
  late bool _inStock = widget.product?['in_stock'] != false;
  late bool _featured = widget.product?['featured'] == true;
  List<String> _categoryNames = [];
  bool _busy = false;
  String? _nameError;
  String? _priceError;

  bool get isEdit => widget.product != null;

  @override
  void initState() {
    super.initState();
    _loadCategories();
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _price.dispose();
    _category.dispose();
    _stockQty.dispose();
    super.dispose();
  }

  Future<void> _loadCategories() async {
    try {
      final session = context.read<Session>();
      final res = await session.api.getCategories(session.businessId!);
      final names = ((res['categories'] as List?) ?? [])
          .map((c) => '${c['name']}')
          .where((n) => n.isNotEmpty)
          .toSet()
          .toList()
        ..sort();
      if (mounted) setState(() => _categoryNames = names);
    } catch (_) {
      // Non-fatal — the field still works as free text without suggestions.
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final price = double.tryParse(_price.text.trim());
    final nameError = name.isEmpty ? 'Enter a product name' : null;
    final priceError =
        (price == null || price < 0) ? 'Enter a valid price' : null;
    if (nameError != null || priceError != null) {
      setState(() {
        _nameError = nameError;
        _priceError = priceError;
      });
      return;
    }
    setState(() => _busy = true);
    final session = context.read<Session>();
    final body = {
      'name': name,
      'description': _desc.text.trim().isEmpty ? null : _desc.text.trim(),
      'price_ghs': price,
      'category':
          _category.text.trim().isEmpty ? 'general' : _category.text.trim(),
      'in_stock': _inStock,
      'featured': _featured,
      'stock_qty': _stockQty.text.trim().isEmpty
          ? null
          : int.tryParse(_stockQty.text.trim()),
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
        content:
            Text('Remove "${widget.product!['name']}" from your catalogue?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete',
                  style: TextStyle(color: WabColors.danger))),
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
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(isEdit ? 'Edit product' : 'New product',
                    style: const TextStyle(
                        fontSize: 22, fontWeight: FontWeight.w800)),
                if (isEdit)
                  IconButton(
                      tooltip: 'Delete product',
                      onPressed: _busy ? null : _delete,
                      icon: const Icon(Icons.delete_outline_rounded,
                          color: WabColors.danger)),
              ],
            ),
            const SizedBox(height: 20),
            TextField(
                controller: _name,
                onChanged: (_) {
                  if (_nameError != null) setState(() => _nameError = null);
                },
                decoration:
                    InputDecoration(labelText: 'Name', errorText: _nameError)),
            const SizedBox(height: 12),
            TextField(
                controller: _desc,
                decoration:
                    const InputDecoration(labelText: 'Description (optional)')),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                      controller: _price,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) {
                        if (_priceError != null) {
                          setState(() => _priceError = null);
                        }
                      },
                      decoration: InputDecoration(
                          labelText: 'Price (GH₵)', errorText: _priceError)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                      controller: _stockQty,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'Stock qty',
                          hintText: 'blank = untracked')),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: DropdownMenu<String>(
                controller: _category,
                enableFilter: true,
                requestFocusOnTap: true,
                label: const Text('Category'),
                hintText: 'Pick one or type a new one',
                dropdownMenuEntries: [
                  for (final name in _categoryNames)
                    DropdownMenuEntry(value: name, label: name),
                ],
              ),
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              value: _inStock,
              onChanged: (v) => setState(() => _inStock = v),
              title: const Text('In stock',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              activeThumbColor: WabColors.accent,
              contentPadding: EdgeInsets.zero,
            ),
            SwitchListTile(
              value: _featured,
              onChanged: (v) => setState(() => _featured = v),
              title: const Text('Featured',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: const Text(
                  'Shown first to customers browsing on WhatsApp',
                  style: TextStyle(fontSize: 12)),
              activeThumbColor: WabColors.accent,
              contentPadding: EdgeInsets.zero,
            ),
            // Only once the product exists — variants and add-ons hang off a
            // product id, so there is nothing to attach them to until it has
            // been saved.
            if (isEdit) ...[
              const Divider(height: 24),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.tune_rounded,
                    color: WabColors.accentInk, size: 22),
                title: const Text('Variants & add-ons',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                subtitle: const Text('Sizes, colours and paid extras',
                    style: TextStyle(fontSize: 12)),
                trailing: const Icon(Icons.chevron_right_rounded,
                    color: WabColors.muted2),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => ProductOptionsScreen(
                    productId: '${widget.product!['id']}',
                    productName: '${widget.product!['name']}',
                    basePrice: widget.product!['price_ghs'],
                  ),
                )),
              ),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
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
