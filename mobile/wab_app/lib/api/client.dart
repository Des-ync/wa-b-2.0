import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// Thrown for any non-2xx API response; [message] is the server's error text.
///
/// [code] is the stable machine-readable code from the v2 envelope
/// (`validation_error`, `not_found`, ...) — branch on this, never on
/// [message], which is prose and may be reworded.
///
/// [fields] maps a field name to why it was rejected, so a form can mark the
/// right input instead of showing one snackbar for the whole request. Empty
/// for anything that isn't a validation error, and for any route not yet
/// migrated to the v2 envelope.
class ApiException implements Exception {
  final int status;
  final String message;
  final String? code;
  final Map<String, String> fields;

  ApiException(this.status, this.message,
      {this.code, this.fields = const {}});

  /// The reason this specific field was rejected, if the server said.
  String? fieldError(String name) => fields[name];

  bool get isValidation => code == 'validation_error';

  @override
  String toString() => message;
}

/// Thin JSON client for the WA-B API. One instance per app, the API key is
/// injected by the session after login.
class ApiClient {
  static const baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://skes.tech',
  );

  String? apiKey;

  /// The transport. Defaults to a real client so nothing at call sites
  /// changes; tests inject `http.testing.MockClient` instead. Without this
  /// seam the entire API layer — every path string and body shape in
  /// `lib/api/*_api.dart` — can only be verified by grepping, which is
  /// exactly the gap the 2026-07 audit flagged (cross-area risk #6).
  final http.Client _client;

  ApiClient({http.Client? httpClient}) : _client = httpClient ?? http.Client();

  /// A second client sharing this one's transport but with its own key —
  /// used to validate a candidate key without overwriting the live session's
  /// credential if it turns out to be bad.
  ApiClient sibling() => ApiClient(httpClient: _client);

  /// Opt in to the v2 response envelope ({ success, data, meta } /
  /// { success, error: { code, message, fields } }).
  ///
  /// Off by default and per-instance rather than global: route groups are
  /// being migrated one at a time, and a route that has not been migrated
  /// ignores the header entirely — but the app should only start ASKING for
  /// v2 once [_unwrap] below is proven against the routes it actually calls.
  /// Flip this on once the API layer's own tests cover the migrated groups.
  bool useV2Envelope = false;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (apiKey != null) 'Authorization': 'Bearer $apiKey',
        if (useV2Envelope) 'X-API-Version': '2',
      };

  Uri _uri(String path, [Map<String, dynamic>? query]) {
    final q = query?.map((k, v) => MapEntry(k, '$v'));
    return Uri.parse('$baseUrl$path').replace(queryParameters: q);
  }

  Future<Map<String, dynamic>> get(String path,
          {Map<String, dynamic>? query}) =>
      _send(() => _client.get(_uri(path, query), headers: _headers));

  Future<Map<String, dynamic>> post(String path,
          {Map<String, dynamic>? body}) =>
      _send(() => _client.post(_uri(path),
          headers: _headers, body: jsonEncode(body ?? {})));

  Future<Map<String, dynamic>> patch(String path,
          {Map<String, dynamic>? body}) =>
      _send(() => _client.patch(_uri(path),
          headers: _headers, body: jsonEncode(body ?? {})));

  Future<Map<String, dynamic>> delete(String path,
          {Map<String, dynamic>? query}) =>
      _send(() => _client.delete(_uri(path, query), headers: _headers));

  Future<Map<String, dynamic>> _send(
      Future<http.Response> Function() run) async {
    http.Response res;
    try {
      res = await run().timeout(const Duration(seconds: 25));
    } on SocketException {
      throw ApiException(
          0, 'No connection. Check your internet and try again.');
    } catch (_) {
      throw ApiException(0, 'Network error. Please try again.');
    }
    Map<String, dynamic> json;
    try {
      json = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      json = {};
    }
    if (res.statusCode < 200 ||
        res.statusCode >= 300 ||
        json['success'] == false) {
      throw _errorFrom(res.statusCode, json);
    }
    // Unwrap the v2 envelope so callers keep seeing one flat map either way.
    // A migrated route answering v2 returns { success, data: {...} }; every
    // existing call site reads res['orders'] and must keep working.
    final data = json['data'];
    if (data is Map<String, dynamic>) {
      return {
        ...data,
        if (json['meta'] is Map<String, dynamic>)
          ...(json['meta'] as Map<String, dynamic>),
        'success': true,
      };
    }
    return json;
  }

  /// Builds the exception from either envelope.
  ///
  /// legacy: { success: false, error: "Product name is required" }
  /// v2:     { success: false, error: { code, message, fields } }
  ///
  /// The legacy branch is not going away — most route groups are still on it,
  /// and a deployed build must handle a server mid-migration.
  static ApiException _errorFrom(int status, Map<String, dynamic> json) {
    final err = json['error'];

    if (err is Map) {
      final rawFields = err['fields'];
      return ApiException(
        status,
        (err['message'] ?? 'Something went wrong ($status)').toString(),
        code: err['code']?.toString(),
        fields: rawFields is Map
            ? rawFields.map((k, v) => MapEntry('$k', '$v'))
            : const {},
      );
    }

    final msg =
        (json['message'] ?? err ?? 'Something went wrong ($status)').toString();
    // Legacy `error` doubles as a code on the routes that use it as one —
    // auth.routes.js returns a bare `error: 'link_required'` and login.dart
    // branches on exactly that. Keep passing it through as the code, as
    // before, or Clerk-linked sign-in silently stops working.
    return ApiException(status, msg, code: err?.toString());
  }
}
