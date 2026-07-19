import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// Thrown for any non-2xx API response; [message] is the server's error text.
class ApiException implements Exception {
  final int status;
  final String message;
  final String? code;
  ApiException(this.status, this.message, {this.code});
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

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (apiKey != null) 'Authorization': 'Bearer $apiKey',
      };

  Uri _uri(String path, [Map<String, dynamic>? query]) {
    final q = query?.map((k, v) => MapEntry(k, '$v'));
    return Uri.parse('$baseUrl$path').replace(queryParameters: q);
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query}) =>
      _send(() => http.get(_uri(path, query), headers: _headers));

  Future<Map<String, dynamic>> post(String path, {Map<String, dynamic>? body}) =>
      _send(() => http.post(_uri(path), headers: _headers, body: jsonEncode(body ?? {})));

  Future<Map<String, dynamic>> patch(String path, {Map<String, dynamic>? body}) =>
      _send(() => http.patch(_uri(path), headers: _headers, body: jsonEncode(body ?? {})));

  Future<Map<String, dynamic>> delete(String path, {Map<String, dynamic>? query}) =>
      _send(() => http.delete(_uri(path, query), headers: _headers));

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() run) async {
    http.Response res;
    try {
      res = await run().timeout(const Duration(seconds: 25));
    } on SocketException {
      throw ApiException(0, 'No connection. Check your internet and try again.');
    } catch (_) {
      throw ApiException(0, 'Network error. Please try again.');
    }
    Map<String, dynamic> json;
    try {
      json = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      json = {};
    }
    if (res.statusCode < 200 || res.statusCode >= 300 || json['success'] == false) {
      final msg = (json['message'] ?? json['error'] ?? 'Something went wrong (${res.statusCode})')
          .toString();
      throw ApiException(res.statusCode, msg, code: json['error']?.toString());
    }
    return json;
  }
}
