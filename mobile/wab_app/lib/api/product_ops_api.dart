import 'client.dart';

/// Catalogue operations that act on MORE than one product, or that create one
/// from another.
///
/// All three exist on the web dashboard already; this is the mobile half. Kept
/// in one place rather than spread across screens so the paths and body shapes
/// are discoverable together — the mobile "mark paid" bug came from exactly
/// the opposite habit.
extension ProductOpsApi on ApiClient {
  /// Applies one set of changes to many products, in a single request.
  ///
  /// One request rather than one per product: on a metered connection the
  /// difference between 1 and 40 round trips is the merchant's own money, and
  /// the server does it in a single atomic UPDATE where a client-side loop can
  /// half-finish.
  ///
  /// The server refuses anything outside its own bulk-editable list, so a
  /// mistake here fails loudly instead of quietly writing the wrong column.
  ///
  /// Returns `{updated, requested, notified, changed}`. **`notified` matters**:
  /// marking products back in stock messages every customer who asked to be
  /// told, and the caller should say so rather than let a merchant discover it
  /// on a bill.
  Future<Map<String, dynamic>> bulkUpdateProducts(
    String businessId, {
    required List<String> productIds,
    required Map<String, dynamic> changes,
  }) {
    return patch('/api/products/bulk', body: {
      'business_id': businessId,
      'product_ids': productIds,
      'changes': changes,
    });
  }

  /// Copies a product, with its variants and add-ons.
  ///
  /// The copy is created **hidden** and with a distinguishing name — it shares
  /// the original's price and photo, so publishing it instantly would put two
  /// near-identical items in front of customers while the merchant is still
  /// editing. Callers should repeat that, since "why is my copy not in the
  /// shop" is otherwise a mystery.
  ///
  /// Returns `{product, variants_copied, addons_copied, hidden}`.
  Future<Map<String, dynamic>> duplicateProduct(String productId) {
    return post('/api/products/$productId/duplicate');
  }

  /// Sets each product's position from its index in [productIds].
  ///
  /// Worth doing because both customer-facing surfaces honour `sort_order`:
  /// the storefront orders by `featured, sort_order, name`. In the WhatsApp
  /// catalogue it ranks below featured and below how often something sells, so
  /// a merchant's chosen order is a tie-breaker there rather than the last
  /// word — the UI says so.
  Future<Map<String, dynamic>> reorderProducts(
    String businessId,
    List<String> productIds,
  ) {
    return post('/api/products/reorder', body: {
      'business_id': businessId,
      'order': productIds,
    });
  }
}
