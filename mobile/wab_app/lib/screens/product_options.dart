import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/options_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Variants and add-ons for one product.
///
/// Neither could be edited from anywhere before this — the PATCH endpoints
/// existed with no caller on any surface, so correcting a price meant
/// deleting the option and recreating it, losing its position in the list.
///
/// Two distinctions the UI has to keep straight, because the data model does:
///
/// - A **variant** is a choice with a price *difference* (Large, +GH¢5) and
///   may be negative. An **add-on** *is* a price (Extra chicken, GH¢8) and
///   cannot be. They are separate endpoints with separate rules, so they are
///   separate sections rather than one list with a type field.
/// - A variant's `stock_qty` of `null` means "not tracked separately", which
///   is not the same as `0`, meaning "sold out". Conflating them would either
///   hide a variant that is available or keep selling one that is gone, so
///   tracking is an explicit switch rather than an empty field.
String variantPriceLabel(dynamic delta, dynamic basePrice) {
  final d = delta is num ? delta.toDouble() : double.tryParse('$delta') ?? 0;
  final base =
      basePrice is num ? basePrice.toDouble() : double.tryParse('$basePrice');
  final sign = d > 0 ? '+' : (d < 0 ? '−' : '');
  final deltaPart = d == 0 ? 'same price' : '$sign${ghs(d.abs())}';
  if (base == null) return deltaPart;
  return '$deltaPart · ${ghs(base + d)}';
}

/// What a variant's stock field means, said in words rather than a bare number.
String variantStockLabel(dynamic stockQty) {
  if (stockQty == null) return 'Stock not tracked';
  final q = stockQty is num ? stockQty.toInt() : int.tryParse('$stockQty') ?? 0;
  return q == 0 ? 'Sold out' : '$q left';
}

class ProductOptionsScreen extends StatefulWidget {
  const ProductOptionsScreen({
    super.key,
    required this.productId,
    required this.productName,
    this.basePrice,
  });

  final String productId;
  final String productName;
  final dynamic basePrice;

  @override
  State<ProductOptionsScreen> createState() => _ProductOptionsScreenState();
}

class _ProductOptionsScreenState extends State<ProductOptionsScreen> {
  List<Map<String, dynamic>>? _variants;
  List<Map<String, dynamic>>? _addons;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _error = null);
    try {
      final api = context.read<Session>().api;
      // One round trip each, in parallel — the two lists are independent and
      // a merchant on 3G should not wait for them in sequence.
      final results = await Future.wait([
        api.getVariants(widget.productId),
        api.getAddons(widget.productId),
      ]);
      if (!mounted) return;
      setState(() {
        _variants =
            ((results[0]['variants'] as List?) ?? []).cast<Map<String, dynamic>>();
        _addons =
            ((results[1]['addons'] as List?) ?? []).cast<Map<String, dynamic>>();
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  void _toast(String message, {bool bad = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: bad ? WabColors.danger : WabColors.accentInk,
    ));
  }

  Future<void> _editVariant([Map<String, dynamic>? existing]) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _VariantSheet(
        productId: widget.productId,
        basePrice: widget.basePrice,
        existing: existing,
      ),
    );
    if (saved == true) {
      _toast(existing == null ? 'Variant added' : 'Variant updated');
      await _load();
    }
  }

  Future<void> _editAddon([Map<String, dynamic>? existing]) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) =>
          _AddonSheet(productId: widget.productId, existing: existing),
    );
    if (saved == true) {
      _toast(existing == null ? 'Add-on added' : 'Add-on updated');
      await _load();
    }
  }

  Future<void> _delete(
      {required String label,
      required String name,
      required Future<void> Function() run}) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Remove $label?'),
        // Past orders keep their own copy of what was bought, so removing an
        // option never rewrites history — worth saying, because "delete" on a
        // catalogue item reads as riskier than it is.
        content: Text('"$name" will stop being offered to customers. '
            'Orders that already included it are not affected.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove',
                  style: TextStyle(color: WabColors.danger))),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await run();
      _toast('$label removed');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, bad: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Session>().api;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Variants & add-ons'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(20),
          child: Padding(
            padding: const EdgeInsets.only(left: 16, bottom: 10),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(widget.productName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 13, color: WabColors.muted)),
            ),
          ),
        ),
      ),
      body: _error != null
          ? ErrorRetry(message: _error!, onRetry: _load)
          : _variants == null
              ? const Center(
                  child: CircularProgressIndicator(color: WabColors.accent))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      _section(
                        title: 'Variants',
                        blurb:
                            'Choices that change the price — Small, Large, '
                            'a different colour.',
                        addLabel: 'Add variant',
                        onAdd: () => _editVariant(),
                        emptyText: 'No variants. Customers just order the '
                            'product as it is.',
                        rows: [
                          for (final v in _variants!)
                            _row(
                              name: '${v['name']}',
                              detail:
                                  '${variantPriceLabel(v['price_delta_ghs'], widget.basePrice)}'
                                  ' · ${variantStockLabel(v['stock_qty'])}',
                              onEdit: () => _editVariant(v),
                              onDelete: () => _delete(
                                  label: 'Variant',
                                  name: '${v['name']}',
                                  run: () => api.deleteVariant('${v['id']}')),
                            ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      _section(
                        title: 'Add-ons',
                        blurb:
                            'Extras a customer can add on top — each has its '
                            'own price.',
                        addLabel: 'Add add-on',
                        onAdd: () => _editAddon(),
                        emptyText: 'No add-ons yet.',
                        rows: [
                          for (final a in _addons!)
                            _row(
                              name: '${a['name']}',
                              detail: '+${ghs(a['price_ghs'])}',
                              onEdit: () => _editAddon(a),
                              onDelete: () => _delete(
                                  label: 'Add-on',
                                  name: '${a['name']}',
                                  run: () => api.deleteAddon('${a['id']}')),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
    );
  }

  Widget _section({
    required String title,
    required String blurb,
    required String addLabel,
    required VoidCallback onAdd,
    required String emptyText,
    required List<Widget> rows,
  }) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style:
                    const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const SizedBox(height: 3),
            Text(blurb,
                style:
                    const TextStyle(fontSize: 12.5, color: WabColors.muted)),
            const SizedBox(height: 12),
            if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text(emptyText,
                    style: const TextStyle(
                        fontSize: 13, color: WabColors.muted2)),
              )
            else
              ...rows,
            const SizedBox(height: 6),
            OutlinedButton.icon(
              onPressed: onAdd,
              icon: const Icon(Icons.add_rounded, size: 18),
              label: Text(addLabel),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row({
    required String name,
    required String detail,
    required VoidCallback onEdit,
    required VoidCallback onDelete,
  }) {
    return InkWell(
      onTap: onEdit,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text(detail,
                      style: const TextStyle(
                          fontSize: 12, color: WabColors.muted)),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Edit $name',
              onPressed: onEdit,
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.edit_outlined,
                  size: 19, color: WabColors.muted),
            ),
            IconButton(
              tooltip: 'Remove $name',
              onPressed: onDelete,
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.delete_outline_rounded,
                  size: 19, color: WabColors.danger),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── variant sheet ─────────────────────────────────────────────────────────

class _VariantSheet extends StatefulWidget {
  const _VariantSheet(
      {required this.productId, required this.basePrice, this.existing});

  final String productId;
  final dynamic basePrice;
  final Map<String, dynamic>? existing;

  @override
  State<_VariantSheet> createState() => _VariantSheetState();
}

class _VariantSheetState extends State<_VariantSheet> {
  late final TextEditingController _name;
  late final TextEditingController _delta;
  late final TextEditingController _qty;
  late bool _trackStock;
  bool _busy = false;
  String? _nameError;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _name = TextEditingController(text: '${e?['name'] ?? ''}');
    _delta = TextEditingController(
        text: e == null ? '' : '${_numOrZero(e['price_delta_ghs'])}');
    // null stock means untracked, which is the default for a new variant —
    // most shops do not count stock per size.
    _trackStock = e != null && e['stock_qty'] != null;
    _qty = TextEditingController(
        text: e?['stock_qty'] == null ? '' : '${e!['stock_qty']}');
  }

  static num _numOrZero(dynamic v) =>
      v is num ? v : num.tryParse('$v') ?? 0;

  @override
  void dispose() {
    _name.dispose();
    _delta.dispose();
    _qty.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _nameError = 'Give the variant a name');
      return;
    }
    final delta = double.tryParse(_delta.text.trim()) ?? 0;
    final qty = _trackStock ? (int.tryParse(_qty.text.trim()) ?? 0) : null;

    setState(() {
      _busy = true;
      _nameError = null;
    });
    try {
      final api = context.read<Session>().api;
      if (_isEdit) {
        await api.updateVariant(
          '${widget.existing!['id']}',
          name: name,
          priceDelta: delta,
          stockQty: qty,
          // Turning tracking OFF has to send an explicit null; omitting the
          // field would leave the old count in place and the variant would
          // still look tracked.
          clearStockQty: !_trackStock,
        );
      } else {
        await api.createVariant(widget.productId,
            name: name, priceDelta: delta, stockQty: qty);
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _nameError = e.fields['name'];
        });
        if (e.fields['name'] == null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(e.message), backgroundColor: WabColors.danger));
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final delta = double.tryParse(_delta.text.trim()) ?? 0;
    return _sheetShell(
      context,
      title: _isEdit ? 'Edit variant' : 'New variant',
      busy: _busy,
      onSave: _save,
      children: [
        TextField(
          controller: _name,
          autofocus: !_isEdit,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            labelText: 'Name',
            hintText: 'Large, Red, 500ml…',
            errorText: _nameError,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _delta,
          keyboardType: const TextInputType.numberWithOptions(
              decimal: true, signed: true),
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: 'Price difference (GH₵)',
            hintText: '5 for GH₵5 more, -2 for GH₵2 less, 0 for the same',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 6),
        // The merchant prices in final money, not deltas — so show what the
        // customer will actually pay as they type.
        Text('Customer pays ${variantPriceLabel(delta, widget.basePrice)}',
            style: const TextStyle(fontSize: 12.5, color: WabColors.muted)),
        const SizedBox(height: 10),
        SwitchListTile(
          value: _trackStock,
          onChanged: (v) => setState(() => _trackStock = v),
          title: const Text('Count stock for this variant',
              style: TextStyle(fontWeight: FontWeight.w600)),
          subtitle: const Text(
              'Off means this variant is always available while the product is',
              style: TextStyle(fontSize: 12)),
          activeThumbColor: WabColors.accent,
          contentPadding: EdgeInsets.zero,
        ),
        if (_trackStock)
          TextField(
            controller: _qty,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'How many left',
              border: OutlineInputBorder(),
            ),
          ),
      ],
    );
  }
}

// ─── add-on sheet ──────────────────────────────────────────────────────────

class _AddonSheet extends StatefulWidget {
  const _AddonSheet({required this.productId, this.existing});

  final String productId;
  final Map<String, dynamic>? existing;

  @override
  State<_AddonSheet> createState() => _AddonSheetState();
}

class _AddonSheetState extends State<_AddonSheet> {
  late final TextEditingController _name;
  late final TextEditingController _price;
  bool _busy = false;
  String? _nameError;
  String? _priceError;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _name = TextEditingController(text: '${e?['name'] ?? ''}');
    _price = TextEditingController(
        text: e == null ? '' : '${e['price_ghs'] ?? ''}');
  }

  @override
  void dispose() {
    _name.dispose();
    _price.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final price = double.tryParse(_price.text.trim());
    setState(() {
      _nameError = name.isEmpty ? 'Give the add-on a name' : null;
      // An add-on is a price, not a difference — the server rejects negative
      // and the form says so before the round trip.
      _priceError = price == null
          ? 'Enter a price'
          : (price < 0 ? 'An add-on price cannot be negative' : null);
    });
    if (_nameError != null || _priceError != null) return;

    setState(() => _busy = true);
    try {
      final api = context.read<Session>().api;
      if (_isEdit) {
        await api.updateAddon('${widget.existing!['id']}',
            name: name, price: price);
      } else {
        await api.createAddon(widget.productId, name: name, price: price!);
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _nameError = e.fields['name'];
          _priceError = e.fields['price_ghs'];
        });
        if (e.fields.isEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(e.message), backgroundColor: WabColors.danger));
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return _sheetShell(
      context,
      title: _isEdit ? 'Edit add-on' : 'New add-on',
      busy: _busy,
      onSave: _save,
      children: [
        TextField(
          controller: _name,
          autofocus: !_isEdit,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            labelText: 'Name',
            hintText: 'Extra chicken, Gift wrap…',
            errorText: _nameError,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _price,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: 'Price (GH₵)',
            errorText: _priceError,
            border: const OutlineInputBorder(),
          ),
        ),
      ],
    );
  }
}

/// The shared sheet frame: scrollable and keyboard-aware, because these open
/// on short screens with the keyboard up.
Widget _sheetShell(
  BuildContext context, {
  required String title,
  required bool busy,
  required VoidCallback onSave,
  required List<Widget> children,
}) {
  return SafeArea(
    child: SingleChildScrollView(
      padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: MediaQuery.of(context).viewInsets.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style:
                  const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const SizedBox(height: 16),
          ...children,
          const SizedBox(height: 18),
          FilledButton(
            onPressed: busy ? null : onSave,
            child: busy
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                        strokeWidth: 2.5, color: Colors.white))
                : const Text('Save'),
          ),
        ],
      ),
    ),
  );
}
