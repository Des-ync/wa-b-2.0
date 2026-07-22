import 'client.dart';

/// Business-scoped read of the existing audit_log table (settings changes,
/// promo/key/inventory actions, payouts, ...) — owner-only server-side.
extension AuditLogApi on ApiClient {
  Future<Map<String, dynamic>> getAuditLog(String businessId,
      {int limit = 100}) {
    return get('/api/audit-log',
        query: {'business_id': businessId, 'limit': limit});
  }
}
