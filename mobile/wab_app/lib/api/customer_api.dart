import 'client.dart';

/// Customer CRM — the profile, loyalty and the merchant-editable fields.
///
/// All of this was backend-complete and had no mobile caller: tapping a
/// customer went straight to the chat thread, so a merchant could not see
/// what someone was worth, what they usually buy, or what they were last
/// promised.
extension CustomerApi on ApiClient {
  /// Lifetime spend, order frequency, preferred payment method, last products
  /// ordered, recent orders and recent conversation — in one round trip,
  /// which matters on a slow connection.
  Future<Map<String, dynamic>> getCustomerProfile(String customerId) {
    return get('/api/customers/$customerId/profile');
  }

  /// Points, stamp progress, VIP tier, referral code and issued rewards.
  Future<Map<String, dynamic>> getCustomerLoyalty(String customerId) {
    return get('/api/customers/$customerId/loyalty');
  }

  /// Free-form merchant tags (VIP, wholesale, delivery area…). Replaces the
  /// whole set — the server normalizes, dedupes and caps them.
  Future<Map<String, dynamic>> setCustomerTags(
    String customerId,
    List<String> tags,
  ) {
    return patch('/api/customers/$customerId/tags', body: {'tags': tags});
  }

  /// Standing delivery directions for this customer, sent to the rider on
  /// every assignment. Pass null to clear.
  Future<Map<String, dynamic>> setCustomerAddressNote(
    String customerId,
    String? note,
  ) {
    return patch('/api/customers/$customerId/address-note',
        body: {'address_note': note});
  }

  /// [dateOfBirth] as YYYY-MM-DD, or null to clear. Drives the birthday
  /// coupon job.
  Future<Map<String, dynamic>> setCustomerBirthday(
    String customerId,
    String? dateOfBirth,
  ) {
    return patch('/api/customers/$customerId/birthday',
        body: {'date_of_birth': dateOfBirth});
  }

  /// Redeem loyalty points for a reward code. Debits the balance and texts
  /// the customer — the merchant is spending the customer's points, so
  /// callers should confirm before calling.
  Future<Map<String, dynamic>> redeemCustomerPoints(
    String customerId, {
    required int points,
  }) {
    return post('/api/customers/$customerId/loyalty/redeem-points',
        body: {'points': points});
  }
}
