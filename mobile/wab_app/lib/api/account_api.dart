import 'client.dart';

/// Getting your data out, and closing the account.
///
/// Both endpoints existed with no client on any surface. That mattered more
/// than the usual "unreachable endpoint" case: an app that lets someone
/// create an account has to give them a way out of it, and the way out has to
/// be findable from inside the app rather than only in a support email.
extension AccountApi on ApiClient {
  /// The whole account as one JSON file: profile and settings, products,
  /// customers (with consent records), orders with their items, and the
  /// message log.
  ///
  /// Returns the raw body so the file the merchant receives is byte-for-byte
  /// what the server produced. Owner-only server-side — the same gate as
  /// changing settings, since this is the entire customer and message record.
  Future<String> exportBusinessData(String businessId) {
    return getRaw('/api/business/export', query: {'business_id': businessId});
  }

  /// Closes the account: the storefront stops being reachable and the bot
  /// stops answering.
  ///
  /// This is a status change, NOT a deletion — orders, customers and messages
  /// are all retained, and the export above still works afterwards. Callers
  /// must say so plainly before calling; `confirm: true` is required by the
  /// server so a stray or repeated request cannot close a shop on its own.
  Future<Map<String, dynamic>> closeBusiness(String businessId,
      {String? reason}) {
    return post('/api/business/close', body: {
      'business_id': businessId,
      'confirm': true,
      if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
    });
  }
}

/// How permanent deletion is actually requested, mirroring the published
/// policy at /delete-account.html.
///
/// Deletion is deliberately not an API call: it is verified against the
/// WhatsApp number on file before anything is erased, so that nobody can
/// destroy a merchant's business records by getting hold of their phone for
/// a minute. The app's job is to make the process findable and to hand over
/// the exact details, not to pretend it happens instantly.
const deletionRequestEmail = 'dev@skes.tech';
const deletionRequestSubject = 'Delete my WA-B account';
const deletionProcessingDays = 30;
