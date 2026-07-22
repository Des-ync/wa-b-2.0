import 'client.dart';

extension BusinessApi on ApiClient {
  Future<Map<String, dynamic>> getBusinessSettings(String businessId) {
    return get('/api/business/settings', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> updateBusinessSettings(String businessId, Map<String, dynamic> fields) {
    return patch('/api/business/settings', body: {'business_id': businessId, ...fields});
  }
}
