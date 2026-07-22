import 'client.dart';

/// Lifecycle automations: reorder reminder, win-back, post-purchase review,
/// delivery feedback.
extension AutomationsApi on ApiClient {
  Future<Map<String, dynamic>> getAutomations(String businessId) {
    return get('/api/automations', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> updateAutomation(
    String businessId,
    String key, {
    bool? enabled,
    Map<String, dynamic>? config,
  }) {
    return patch('/api/automations/$key', body: {
      'business_id': businessId,
      if (enabled != null) 'enabled': enabled,
      if (config != null) 'config': config,
    });
  }
}
