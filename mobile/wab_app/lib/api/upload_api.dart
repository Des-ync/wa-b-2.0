import 'client.dart';

/// Product photo upload.
///
/// The picker shrinks the photo before it leaves the phone — see
/// `widgets/product_photo_picker.dart`. This just posts the bytes.
extension UploadApi on ApiClient {
  /// Uploads image bytes and returns the stored photo's URL.
  ///
  /// Sent as the raw request body rather than multipart: the server reads a
  /// Buffer and identifies the format from its magic bytes, so neither side
  /// carries a parser. [contentType] must be one the server accepts —
  /// image/jpeg, image/png or image/webp.
  Future<String> uploadProductImage(
    String businessId,
    List<int> bytes, {
    String contentType = 'image/jpeg',
  }) async {
    final res = await postBytes(
      '/api/uploads/product-image',
      bytes,
      contentType: contentType,
      query: {'business_id': businessId},
    );
    return '${res['url']}';
  }
}

/// Resolves a stored `image_url` to something [Image.network] can fetch.
///
/// Uploaded photos are stored as a RELATIVE path (`/wa-b/uploads/…`) so the
/// value survives a domain change and is portable between environments — the
/// web dashboard and storefront use it directly as a `src`. A Flutter app has
/// no page origin to resolve against, so it resolves against [ApiClient.baseUrl].
///
/// Anything already absolute is returned only if it is **https**. That rule
/// predates uploads and still matters: `image_url` is stored data that any
/// teammate with product-edit access — or a catalog CSV import — can set, and
/// rendering it makes this device issue an outbound GET to whatever host it
/// names. Requiring https rules out cleartext fetches and plain-http probes of
/// hosts on the merchant's own network.
///
/// Returns an empty string when the value is neither, which callers treat as
/// "no thumbnail".
String resolveImageUrl(String? value) {
  final raw = (value ?? '').trim();
  if (raw.isEmpty) return '';

  // Our own uploads: a site-absolute path, resolved against the API host.
  if (raw.startsWith('/')) {
    // Only paths we serve. A stored value starting with `//` is a
    // protocol-relative URL to some other host wearing a path's clothes.
    if (raw.startsWith('//')) return '';
    return '${ApiClient.baseUrl}$raw';
  }

  final uri = Uri.tryParse(raw);
  if (uri != null && uri.isAbsolute && uri.scheme == 'https' && uri.host.isNotEmpty) {
    return raw;
  }
  return '';
}
