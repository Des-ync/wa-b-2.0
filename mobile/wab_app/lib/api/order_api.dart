import 'client.dart';

/// Order-detail-specific endpoints, kept out of the generic get/post/patch
/// on [ApiClient] so each screen's API surface is discoverable in one place
/// instead of every call site hand-rolling its own path string and body
/// shape (the mobile "mark paid" bug came from exactly that pattern —
/// PATCH .../status was reused for something it never actually did).
extension OrderApi on ApiClient {
  /// Record a payment collected outside the MoMo/card webhook flow (cash in
  /// hand, a bank transfer). Backed by the SAME order-paid pipeline the
  /// gateway webhook uses, so stock/loyalty/GMV stay correct.
  Future<Map<String, dynamic>> markOrderPaid(
    String orderId, {
    String method = 'cash',
    double? amountGhs,
  }) {
    return post('/api/orders/$orderId/mark-paid', body: {
      'method': method,
      if (amountGhs != null) 'amount_ghs': amountGhs,
    });
  }

  Future<Map<String, dynamic>> assignRider(
    String orderId, {
    required String riderName,
    String? riderPhone,
  }) {
    return patch('/api/orders/$orderId/delivery', body: {
      'rider_name': riderName,
      if (riderPhone != null && riderPhone.isNotEmpty)
        'rider_phone': riderPhone,
    });
  }

  Future<Map<String, dynamic>> updateDeliveryStatus(
    String orderId,
    String deliveryStatus,
  ) {
    return patch('/api/orders/$orderId/delivery', body: {
      'delivery_status': deliveryStatus,
    });
  }

  Future<Map<String, dynamic>> setOrderEstimates(
    String orderId, {
    DateTime? readyAt,
    DateTime? deliveryAt,
  }) {
    final body = <String, dynamic>{};
    if (readyAt != null) body['estimated_ready_at'] = readyAt.toIso8601String();
    if (deliveryAt != null)
      body['estimated_delivery_at'] = deliveryAt.toIso8601String();
    return patch('/api/orders/$orderId/estimates', body: body);
  }

  Future<Map<String, dynamic>> refundOrder(
    String orderId, {
    required double amountGhs,
    String? reason,
  }) {
    return post('/api/orders/$orderId/refund', body: {
      'amount_ghs': amountGhs,
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    });
  }

  Future<Map<String, dynamic>> addOrderNote(String orderId, String note) {
    return patch('/api/orders/$orderId/notes', body: {'note': note});
  }

  /// Nudges the customer with the same retry/cancel prompt the automatic
  /// payment-failed message sends. Rate-limited server-side to one per
  /// order per 10 minutes.
  Future<Map<String, dynamic>> sendPaymentReminder(String orderId) {
    return post('/api/orders/$orderId/payment-reminder');
  }
}
