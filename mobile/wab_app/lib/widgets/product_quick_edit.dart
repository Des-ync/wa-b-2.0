import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/upload_api.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import 'product_photo_picker.dart';

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

  /// Overridden in tests. `image_picker` needs a platform channel, which a
  /// widget test does not have.
  final ProductPhotoPicker? photoPicker;

  const ProductQuickEditSheet(
      {super.key, required this.product, this.photoPicker});

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
  bool _uploading = false;

  /// Injectable so the sheet can be tested without a platform channel.
  ProductPhotoPicker get _picker => widget.photoPicker ?? ProductPhotoPicker();

  @override
  void dispose() {
    _price.dispose();
    _imageUrl.dispose();
    super.dispose();
  }

  /// Take or choose a photo, shrink it, upload it, and point the product at it.
  ///
  /// The URL is only put in the field after the upload succeeds — a failed
  /// upload must not leave the merchant looking at a path to a file that was
  /// never stored.
  Future<void> _pickPhoto() async {
    final source = await showPhotoSourceSheet(context);
    if (source == null || !mounted) return;

    final session = context.read<Session>();
    final businessId = session.businessId;
    if (businessId == null) return;

    setState(() => _uploading = true);
    try {
      final picked = await _picker.pick(source);
      // A cancelled pick is a normal outcome, not a failure to report.
      if (picked == null) return;

      final url = await session.api.uploadProductImage(
        businessId,
        picked.bytes,
        contentType: picked.contentType,
      );
      if (!mounted) return;
      setState(() => _imageUrl.text = url);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Semantics(
            liveRegion: true,
            child: Text('Photo added (${(picked.bytes.length / 1024).round()} KB)')),
        backgroundColor: WabColors.accentInk,
      ));
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } catch (e) {
      // A denied camera permission surfaces here as a PlatformException, and
      // reads as gibberish if shown raw.
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(
                liveRegion: true,
                child: const Text(
                    'Could not open the camera or gallery. Check the app\'s permissions.')),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
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


  @override
  Widget build(BuildContext context) {
    final rawImageUrl = _imageUrl.text.trim();
    // resolveImageUrl turns our own relative `/wa-b/uploads/…` into an
    // absolute URL against the API host, and still refuses any non-https
    // absolute link — see api/upload_api.dart for why that rule exists.
    final imageUrl = resolveImageUrl(rawImageUrl);
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
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Photo',
                          style: TextStyle(
                              fontSize: 12, color: WabColors.muted)),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          OutlinedButton.icon(
                            onPressed: _uploading ? null : _pickPhoto,
                            icon: _uploading
                                ? const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2))
                                : const Icon(Icons.photo_camera_rounded,
                                    size: 17),
                            label: Text(_uploading
                                ? 'Uploading…'
                                : (rawImageUrl.isEmpty
                                    ? 'Add photo'
                                    : 'Replace photo')),
                          ),
                          if (rawImageUrl.isNotEmpty)
                            TextButton(
                              onPressed: _uploading
                                  ? null
                                  : () => setState(() => _imageUrl.clear()),
                              child: const Text('Remove',
                                  style: TextStyle(color: WabColors.danger)),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                if (imageUrl.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: CachedNetworkImage(
                      imageUrl: imageUrl,
                      width: 48,
                      height: 48,
                      fit: BoxFit.cover,
                      // Decode at display size, not the source image's full
                      // resolution — this is a 48dp thumbnail, no reason to
                      // hold a multi-megapixel bitmap in memory for it.
                      // Cached to disk too (flutter_cache_manager), so
                      // re-opening this product doesn't re-download a photo
                      // that hasn't changed since last time.
                      memCacheWidth:
                          (48 * MediaQuery.of(context).devicePixelRatio)
                              .round(),
                      memCacheHeight:
                          (48 * MediaQuery.of(context).devicePixelRatio)
                              .round(),
                      placeholder: (_, __) => Container(
                        width: 48,
                        height: 48,
                        color: WabColors.bg2,
                        child: const Center(
                          child: SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      ),
                      errorWidget: (_, __, ___) => Container(
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
