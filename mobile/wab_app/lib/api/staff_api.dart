import 'client.dart';

/// Staff access keys.
///
/// The whole `/api/keys` surface had no client: keys could only be issued by
/// calling the API directly, and there was no way to see what existed or
/// revoke it. A shop owner could not answer "who still has access", which is
/// the question that matters after someone leaves.
extension StaffApi on ApiClient {
  /// Every key for the business — including revoked ones, which stay visible
  /// as a record of what access existed and when it ended.
  Future<Map<String, dynamic>> getStaffKeys(String businessId) {
    return get('/api/keys', query: {'business_id': businessId});
  }

  /// Issue a key. The response carries `key.plaintext` — the ONLY time the
  /// secret is ever returned. It is stored hashed, so a caller that loses it
  /// must rotate rather than look it up.
  Future<Map<String, dynamic>> createStaffKey(
    String businessId, {
    required String name,
    required String role,
    String? expiresAt,
  }) {
    return post('/api/keys', body: {
      'business_id': businessId,
      'name': name,
      'role': role,
      if (expiresAt != null && expiresAt.isNotEmpty) 'expires_at': expiresAt,
    });
  }

  /// Revoke immediately. The key stops working on its next request; there is
  /// no undo, and re-granting means issuing a new one.
  Future<Map<String, dynamic>> revokeStaffKey(String keyId) {
    return post('/api/keys/$keyId/revoke');
  }

  /// Replace a key with a fresh secret, keeping its name and role. The old
  /// one stops working immediately — this is what to do when a key may have
  /// leaked but the person still needs access.
  Future<Map<String, dynamic>> rotateStaffKey(String keyId) {
    return post('/api/keys/$keyId/rotate');
  }
}

/// What each role can actually do, mirroring src/utils/permissions.js.
///
/// Shown at the point of granting because "manager" and "support" mean
/// nothing on their own — a shop owner handing out access needs to see that
/// one of them can read the books and the other cannot.
const staffRoles = <String, ({String label, String summary})>{
  'owner': (
    label: 'Owner',
    summary: 'Everything, including settings, payouts and staff access.',
  ),
  'manager': (
    label: 'Manager',
    summary: 'Orders, customers, products, promos, broadcasts and the books. '
        'Cannot change settings or add staff.',
  ),
  'support': (
    label: 'Support',
    summary: 'Orders, customers and chat. Can view products. '
        'Cannot see money or send broadcasts.',
  ),
  'accountant': (
    label: 'Accountant',
    summary: 'Read-only across orders, customers and the books. Changes nothing.',
  ),
  'readonly': (
    label: 'Read only',
    summary: 'Can look at everything it is shown, and change nothing.',
  ),
};
