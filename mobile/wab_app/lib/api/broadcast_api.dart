import 'client.dart';

/// Broadcast composition and its two safety rails.
///
/// A broadcast fans out to every matching customer's WhatsApp the moment it
/// is created and cannot be recalled, so both calls here exist to answer one
/// question before that happens: who actually receives this, and does it read
/// the way I think it does.
extension BroadcastApi on ApiClient {
  /// How many customers this audience would reach, before sending.
  ///
  /// POST despite being read-only — the audience is a nested object.
  Future<Map<String, dynamic>> previewBroadcast(
    String businessId, {
    Map<String, dynamic>? audience,
  }) {
    return post('/api/broadcasts/preview', body: {
      'business_id': businessId,
      if (audience != null && audience.isNotEmpty) 'audience': audience,
    });
  }

  /// Send the composed message to the shop's own WhatsApp number.
  /// Not recorded as a broadcast — a test is not a campaign.
  Future<Map<String, dynamic>> sendBroadcastTest(
    String businessId, {
    required String body,
  }) {
    return post('/api/broadcasts/test', body: {
      'business_id': businessId,
      'body': body,
    });
  }
}
