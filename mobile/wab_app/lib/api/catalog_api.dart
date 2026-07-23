import 'client.dart';

/// Structured categories and product bundles — the catalog-organization
/// layer above the flat product list in products.dart.
extension CatalogApi on ApiClient {
  Future<Map<String, dynamic>> getCategories(String businessId) {
    return get('/api/categories', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> createCategory(
    String businessId,
    String name, {
    int sortOrder = 0,
    bool hidden = false,
  }) {
    return post('/api/categories', body: {
      'business_id': businessId,
      'name': name,
      'sort_order': sortOrder,
      'hidden': hidden,
    });
  }

  Future<Map<String, dynamic>> updateCategory(
    String id, {
    String? name,
    int? sortOrder,
    bool? hidden,
  }) {
    return patch('/api/categories/$id', body: {
      if (name != null) 'name': name,
      if (sortOrder != null) 'sort_order': sortOrder,
      if (hidden != null) 'hidden': hidden,
    });
  }

  Future<Map<String, dynamic>> deleteCategory(String id) =>
      delete('/api/categories/$id');

  Future<Map<String, dynamic>> reorderCategories(
      String businessId, List<String> order) {
    return post('/api/categories/reorder',
        body: {'business_id': businessId, 'order': order});
  }

  Future<Map<String, dynamic>> getBundles(String businessId) {
    return get('/api/products/bundles', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> createBundle(
    String businessId, {
    required String name,
    required double priceGhs,
    String? description,
    required List<Map<String, dynamic>> items,
    bool active = true,
  }) {
    return post('/api/products/bundles', body: {
      'business_id': businessId,
      'name': name,
      'price_ghs': priceGhs,
      if (description != null && description.isNotEmpty)
        'description': description,
      'items': items,
      'active': active,
    });
  }

  Future<Map<String, dynamic>> updateBundle(
    String id, {
    String? name,
    double? priceGhs,
    String? description,
    List<Map<String, dynamic>>? items,
    bool? active,
  }) {
    return patch('/api/products/bundles/$id', body: {
      if (name != null) 'name': name,
      if (priceGhs != null) 'price_ghs': priceGhs,
      if (description != null) 'description': description,
      if (items != null) 'items': items,
      if (active != null) 'active': active,
    });
  }

  Future<Map<String, dynamic>> deleteBundle(String id) =>
      delete('/api/products/bundles/$id');
}
