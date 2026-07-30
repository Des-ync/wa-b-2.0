import 'client.dart';

/// Stock movements, suppliers and margins.
///
/// The whole `/api/inventory` module was backend-complete and unreachable
/// except for reorder-suggestions, which the home screen uses for one tile.
/// A merchant could see that something was running low and had no way to
/// record that they had restocked it — so the low-stock warning never
/// cleared, and stock counts drifted from reality until someone edited each
/// product by hand.
extension InventoryApi on ApiClient {
  /// Products at or below their own reorder threshold, with supplier and a
  /// suggested quantity.
  Future<Map<String, dynamic>> getReorderSuggestions(String businessId) {
    return get('/api/inventory/reorder-suggestions',
        query: {'business_id': businessId});
  }

  /// Record stock coming IN. Adds to the current count and writes a
  /// stock_movements row, so the restock is auditable rather than an
  /// unexplained jump in quantity.
  Future<Map<String, dynamic>> restock(
    String businessId, {
    required String productId,
    required int quantity,
    double? unitCostGhs,
    String? supplierId,
    String? note,
  }) {
    return post('/api/inventory/restock', body: {
      'business_id': businessId,
      'product_id': productId,
      'quantity': quantity,
      if (unitCostGhs != null) 'unit_cost_ghs': unitCostGhs,
      if (supplierId != null && supplierId.isNotEmpty) 'supplier_id': supplierId,
      if (note != null && note.isNotEmpty) 'note': note,
    });
  }

  /// Set stock to an exact count — a stock take, not a delivery. The server
  /// records the DELTA, so "I counted 7" is auditable as what it corrected.
  Future<Map<String, dynamic>> adjustStock(
    String businessId, {
    required String productId,
    required int newQuantity,
    String? note,
  }) {
    return post('/api/inventory/adjust', body: {
      'business_id': businessId,
      'product_id': productId,
      'new_quantity': newQuantity,
      if (note != null && note.isNotEmpty) 'note': note,
    });
  }

  /// Restock/sale/adjustment history, newest first.
  Future<Map<String, dynamic>> getStockMovements(
    String businessId, {
    String? productId,
    int limit = 50,
  }) {
    return get('/api/inventory/movements', query: {
      'business_id': businessId,
      if (productId != null) 'product_id': productId,
      'limit': limit,
    });
  }

  /// Per-product cost vs price. Static unit economics only.
  Future<Map<String, dynamic>> getMargins(String businessId) {
    return get('/api/inventory/margins', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> getSuppliers(String businessId) {
    return get('/api/inventory/suppliers', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> addSupplier(
    String businessId, {
    required String name,
    String? contactName,
    String? contactPhone,
    String? notes,
  }) {
    return post('/api/inventory/suppliers', body: {
      'business_id': businessId,
      'name': name,
      if (contactName != null && contactName.isNotEmpty) 'contact_name': contactName,
      if (contactPhone != null && contactPhone.isNotEmpty) 'contact_phone': contactPhone,
      if (notes != null && notes.isNotEmpty) 'notes': notes,
    });
  }
}
