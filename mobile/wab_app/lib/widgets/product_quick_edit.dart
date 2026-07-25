import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';

/// Opens the compact quick-editor sheet for a single product: out-of-stock
/// toggle, price, and image URL — the three fields a merchant needs to touch
/// most often, without the full "edit product" form. Returns `true` if
/// something was saved (or queued for later while offline).
Future<bool?> showProductQuickEdit(
    BuildContext context, Map<String, dynamic> product) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: WabColors.bg,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (_) => ProductQuickEditSheet(product: product),
  );
}

class ProductQuickEditSheet extends StatefulWidget {
  final Map<String, dynamic> product;
  const ProductQuickEditSheet({super.key, required this.product});

  @override
  State<ProductQuickEditSheet> createState() => _ProductQuickEditSheetState();
}

class _ProductQuickEditSheetState extends State<ProductQuickEditSheet> {
  late final _price =
      TextEditingController(text: widget.product['price_ghs']?.toString());
  late final _imageUrl =
      TextEditingController(text: widget.product['image_url']?.toString());
  late bool _inStock = widget.product['in_stock'] != false;
  bool _busy = false;

  @override
  void dispose() {
    _price.dispose();
    _imageUrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final price = double.tryParse(_price.text.trim());
    if (price == null || price < 0) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(
              liveRegion: true, child: const Text('Enter a valid price')),
          backgroundColor: WabColors.danger));
      return;
    }
    final id = '${widget.product['id']}';
    final imageUrl = _imageUrl.text.trim();
    final body = {
      'in_stock': _inStock,
      'price_ghs': price,
      'image_url': imageUrl.isEmpty ? null : imageUrl,
    };

    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      await session.api.patch('/api/products/$id', body: body);
      await OfflineCache.patchCachedProduct(id, body);
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (e.status == 0) {
        // No connection — queue it instead of losing the edit.
        await OfflineQueue.enqueue(QueuedAction(
          id: 'product-quickedit-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/products/$id',
          body: body,
          description: 'Update "${widget.product['name']}"',
        ));
        await OfflineCache.patchCachedProduct(id, body);
        if (mounted) {
          Navigator.pop(context, true);
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(
                  liveRegion: true,
                  child: const Text(
                      'Offline — saved locally, will sync when back online'))));
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Semantics(liveRegion: true, child: Text(e.message)),
              backgroundColor: WabColors.danger));
        }
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Only render a thumbnail for an absolute `https` URL.
  ///
  /// `image_url` is stored data that any teammate with product-edit access
  /// (or a catalog import) can set, and rendering it makes this device issue
  /// an outbound GET to whatever host it names. Requiring https rules out
  /// cleartext fetches and plain-`http` probes of hosts on the merchant's own
  /// network; the field is meant to hold a public image link.
  static bool _isRenderableImageUrl(String value) {
    final uri = Uri.tryParse(value);
    return uri != null && uri.isAbsolute && uri.scheme == 'https' && uri.host.isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    final rawImageUrl = _imageUrl.text.trim();
    final imageUrl = _isRenderableImageUrl(rawImageUrl) ? rawImageUrl : '';
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Quick edit',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('${widget.product['name']}',
                style: const TextStyle(
                    color: WabColors.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            SwitchListTile(
              value: _inStock,
              onChanged: (v) => setState(() => _inStock = v),
              title: const Text('In stock',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              activeThumbColor: WabColors.accent,
              contentPadding: EdgeInsets.zero,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _price,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Price (GH₵)'),
            ),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                    controller: _imageUrl,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                        labelText: 'Photo URL',
                        hintText: 'https://…',
                        helperText:
                            'Paste a link — there is no in-app photo upload yet'),
                  ),
                ),
                if (imageUrl.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.network(
                      imageUrl,
                      width: 48,
                      height: 48,
                      fit: BoxFit.cover,
                      // Decode at display size, not the source image's full
                      // resolution — this is a 48dp thumbnail, no reason to
                      // hold a multi-megapixel bitmap in memory for it.
                      cacheWidth: (48 * MediaQuery.of(context).devicePixelRatio)
                          .round(),
                      cacheHeight:
                          (48 * MediaQuery.of(context).devicePixelRatio)
                              .round(),
                      errorBuilder: (_, __, ___) => Container(
                        width: 48,
                        height: 48,
                        color: WabColors.bg2,
                        child: const Icon(Icons.broken_image_outlined,
                            size: 20, color: WabColors.muted2),
                      ),
                    ),
                  ),
                ] else if (rawImageUrl.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                        color: WabColors.bg2,
                        borderRadius: BorderRadius.circular(10)),
                    child: const Tooltip(
                      message: 'Photo links must start with https://',
                      child: Icon(Icons.lock_outline,
                          size: 20, color: WabColors.muted2),
                    ),
                  ),
                ],
              ],
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
