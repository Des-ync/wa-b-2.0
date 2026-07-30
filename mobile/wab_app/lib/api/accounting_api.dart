import 'client.dart';

/// Merchant payout summary and daily settlement report.
extension AccountingApi on ApiClient {
  Future<Map<String, dynamic>> getPayoutBalance(String businessId) {
    return get('/api/accounting/payout-balance',
        query: {'business_id': businessId});
  }

  Future<Map<String, dynamic>> getPayouts(String businessId) {
    return get('/api/accounting/payouts', query: {'business_id': businessId});
  }

  /// [date] as YYYY-MM-DD (Africa/Accra); omit for today.
  Future<Map<String, dynamic>> getDailySales(String businessId,
      {String? date}) {
    return get('/api/accounting/daily-sales', query: {
      'business_id': businessId,
      if (date != null) 'date': date,
    });
  }

  Future<Map<String, dynamic>> getReconciliation(String businessId) {
    return get('/api/accounting/reconciliation',
        query: {'business_id': businessId});
  }

  /// Move money: creates a Paystack transfer to the merchant's own payout
  /// MoMo number and returns a 'pending' payout that the transfer webhook
  /// settles. This is the one call in the app that actually pays somebody,
  /// which is why every caller must put it behind BiometricGate.
  ///
  /// Answers 409 when the platform's Paystack account has OTP-approval on
  /// transfers — the money then needs a human at Paystack, not a retry here.
  Future<Map<String, dynamic>> requestAutoPayout(
    String businessId, {
    required double amountGhs,
  }) {
    return post('/api/accounting/payouts/auto', body: {
      'business_id': businessId,
      'amount_ghs': amountGhs,
    });
  }

  /// Record a payout the merchant already sent by hand. An audit record, not
  /// a transfer — distinct from [requestAutoPayout], which moves the money.
  Future<Map<String, dynamic>> recordManualPayout(
    String businessId, {
    required double amountGhs,
    String? momoNumber,
    String? momoNetwork,
    String? note,
  }) {
    return post('/api/accounting/payouts', body: {
      'business_id': businessId,
      'amount_ghs': amountGhs,
      if (momoNumber != null && momoNumber.isNotEmpty) 'momo_number': momoNumber,
      if (momoNetwork != null && momoNetwork.isNotEmpty) 'momo_network': momoNetwork,
      if (note != null && note.isNotEmpty) 'note': note,
    });
  }

  Future<Map<String, dynamic>> getExpenses(String businessId, {String? from, String? to}) {
    return get('/api/accounting/expenses', query: {
      'business_id': businessId,
      if (from != null) 'from': from,
      if (to != null) 'to': to,
    });
  }

  /// [expenseDate] as YYYY-MM-DD; omit for today.
  Future<Map<String, dynamic>> addExpense(
    String businessId, {
    required double amountGhs,
    String? category,
    String? description,
    String? expenseDate,
  }) {
    return post('/api/accounting/expenses', body: {
      'business_id': businessId,
      'amount_ghs': amountGhs,
      if (category != null && category.isNotEmpty) 'category': category,
      if (description != null && description.isNotEmpty) 'description': description,
      if (expenseDate != null) 'expense_date': expenseDate,
    });
  }

  Future<Map<String, dynamic>> getProfitLoss(String businessId, {String? from, String? to}) {
    return get('/api/accounting/profit-loss', query: {
      'business_id': businessId,
      if (from != null) 'from': from,
      if (to != null) 'to': to,
    });
  }
}
