import 'client.dart';

/// Product variants and add-ons.
///
/// The PATCH endpoints for both had no caller on ANY surface — not just
/// mobile. The web dashboard can add and remove them through a chain of
/// browser prompts, so the only way to correct a price or fix a typo has been
/// to delete the option and recreate it, which loses its sort order and reads
/// as destructive for what is really an edit.
extension OptionsApi on ApiClient {
  Future<Map<String, dynamic>> getVariants(String productId) =>
      get('/api/products/$productId/variants');

  Future<Map<String, dynamic>> getAddons(String productId) =>
      get('/api/products/$productId/addons');

  /// A variant is a CHOICE with a price difference — "Large, +GH¢5" — so the
  /// delta may be negative, and `stockQty` null means this variant's stock is
  /// not tracked separately from the product's.
  Future<Map<String, dynamic>> createVariant(
    String productId, {
    required String name,
    double priceDelta = 0,
    int? stockQty,
    int? sortOrder,
  }) {
    return post('/api/products/$productId/variants', body: {
      'name': name,
      'price_delta_ghs': priceDelta,
      'stock_qty': stockQty,
      if (sortOrder != null) 'sort_order': sortOrder,
    });
  }

  /// Partial update. Only pass what changed — the server rejects an empty
  /// body with "No fields to update", and `stock_qty: null` is a meaningful
  /// value (stop tracking), not an omission, so it is sent when
  /// [clearStockQty] is set rather than inferred from null.
  Future<Map<String, dynamic>> updateVariant(
    String variantId, {
    String? name,
    double? priceDelta,
    int? stockQty,
    bool clearStockQty = false,
    int? sortOrder,
  }) {
    return patch('/api/products/variants/$variantId', body: {
      if (name != null) 'name': name,
      if (priceDelta != null) 'price_delta_ghs': priceDelta,
      if (clearStockQty) 'stock_qty': null else if (stockQty != null) 'stock_qty': stockQty,
      if (sortOrder != null) 'sort_order': sortOrder,
    });
  }

  Future<Map<String, dynamic>> deleteVariant(String variantId) =>
      delete('/api/products/variants/$variantId');

  /// An add-on IS a price, not a difference, so it cannot be negative — the
  /// server enforces that and the UI matches.
  Future<Map<String, dynamic>> createAddon(
    String productId, {
    required String name,
    required double price,
    int? sortOrder,
  }) {
    return post('/api/products/$productId/addons', body: {
      'name': name,
      'price_ghs': price,
      if (sortOrder != null) 'sort_order': sortOrder,
    });
  }

  Future<Map<String, dynamic>> updateAddon(
    String addonId, {
    String? name,
    double? price,
    int? sortOrder,
  }) {
    return patch('/api/products/addons/$addonId', body: {
      if (name != null) 'name': name,
      if (price != null) 'price_ghs': price,
      if (sortOrder != null) 'sort_order': sortOrder,
    });
  }

  Future<Map<String, dynamic>> deleteAddon(String addonId) =>
      delete('/api/products/addons/$addonId');
}
