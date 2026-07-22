import 'client.dart';

extension ConversationApi on ApiClient {
  /// Deterministic (non-AI) digest: cart state, last order, message volume,
  /// and whether anything the customer said looks like it needs a human.
  Future<Map<String, dynamic>> getConversationSummary(String customerId) {
    return get('/api/conversations/$customerId/summary');
  }
}
