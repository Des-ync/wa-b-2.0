import 'client.dart';

/// The dashboard bell icon's feed — new orders, failed payments, low stock,
/// and "talk to a human" requests.
extension NotificationsApi on ApiClient {
  Future<Map<String, dynamic>> getNotifications(
    String businessId, {
    bool unreadOnly = false,
    int limit = 30,
  }) {
    return get('/api/notifications', query: {
      'business_id': businessId,
      if (unreadOnly) 'unread_only': 'true',
      'limit': limit,
    });
  }

  Future<Map<String, dynamic>> markNotificationRead(String id) {
    return post('/api/notifications/$id/read');
  }

  Future<Map<String, dynamic>> markAllNotificationsRead(String businessId) {
    return post('/api/notifications/mark-all-read',
        body: {'business_id': businessId});
  }
}
