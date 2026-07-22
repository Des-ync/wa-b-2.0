import 'client.dart';

/// Merchant payout summary and daily settlement report.
extension AccountingApi on ApiClient {
  Future<Map<String, dynamic>> getPayoutBalance(String businessId) {
    return get('/api/accounting/payout-balance', query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> getPayouts(String businessId) {
    return get('/api/accounting/payouts', query: {'business_id': businessId});
  }

  /// [date] as YYYY-MM-DD (Africa/Accra); omit for today.
  Future<Map<String, dynamic>> getDailySales(String businessId, {String? date}) {
    return get('/api/accounting/daily-sales', query: {
      'business_id': businessId,
      if (date != null) 'date': date,
    });
  }

  Future<Map<String, dynamic>> getReconciliation(String businessId) {
    return get('/api/accounting/reconciliation', query: {'business_id': businessId});
  }
}
