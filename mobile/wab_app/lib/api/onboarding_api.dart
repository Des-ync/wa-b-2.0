import 'client.dart';

extension OnboardingApi on ApiClient {
  Future<Map<String, dynamic>> getOnboardingStatus(String businessId) {
    return get('/api/onboarding/status', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> getWebhookHealth(String businessId) {
    return get('/api/onboarding/webhook-health',
        query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> sendOnboardingTestMessage(String businessId) {
    return post('/api/onboarding/test-message',
        body: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> loadSampleCatalog(String businessId,
      {bool force = false}) {
    return post('/api/onboarding/sample-catalog',
        body: {'business_id': businessId, if (force) 'force': true});
  }

  Future<Map<String, dynamic>> getIncompleteSetupBusinesses() {
    return get('/api/admin/businesses/incomplete-setup');
  }
}
