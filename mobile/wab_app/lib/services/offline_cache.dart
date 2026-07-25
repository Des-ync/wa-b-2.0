import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists the last-fetched orders/products lists so the Orders and
/// Products screens can show *something* immediately when a fetch fails
/// (no connection), instead of a blank error state.
///
/// Deliberately simple: JSON-encoded lists, capped so the cache never grows
/// unbounded. Not a sync engine — just a "last known good" snapshot.
///
/// These snapshots carry customer names, phone numbers and order details, so
/// they live in `flutter_secure_storage` (Keychain / Android Keystore-backed),
/// the same protection the API key already gets — not in plain
/// shared_preferences, which is cleartext on the device filesystem and can be
/// picked up by an unencrypted device backup. Writes are a little slower than
/// SharedPreferences; the caps below keep the payloads small, and every call
/// here is already best-effort and off the critical path.
class OfflineCache {
  static const _ordersKey = 'wab_cache_orders_v1';
  static const _productsKey = 'wab_cache_products_v1';
  static const _conversationsKey = 'wab_cache_conversations_v1';
  static const _homeSnapshotKey = 'wab_cache_home_v1';
  static const _maxOrders = 50;
  static const _maxProducts = 200;
  static const _maxConversations = 100;

  static const _storage = FlutterSecureStorage();

  static const _allKeys = [
    _ordersKey,
    _productsKey,
    _conversationsKey,
    _homeSnapshotKey,
  ];

  /// Deletes the pre-secure-storage copies that older builds wrote to
  /// shared_preferences in cleartext. Call once on app start — leaving them
  /// behind would mean the plaintext PII is still sitting on disk no matter
  /// what this class does from now on.
  static Future<void> purgeLegacyPlaintextCache() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      for (final key in _allKeys) {
        await prefs.remove(key);
      }
    } catch (_) {
      // Best-effort.
    }
  }

  /// Drops every cached snapshot — call on logout so a signed-out device
  /// keeps no customer data.
  static Future<void> clear() async {
    for (final key in _allKeys) {
      try {
        await _storage.delete(key: key);
      } catch (_) {
        // Best-effort.
      }
    }
  }

  static Future<void> saveOrders(List<Map<String, dynamic>> orders) =>
      _save(_ordersKey, orders, _maxOrders);

  static Future<List<Map<String, dynamic>>?> loadOrders() => _load(_ordersKey);

  static Future<void> saveProducts(List<Map<String, dynamic>> products) =>
      _save(_productsKey, products, _maxProducts);

  static Future<List<Map<String, dynamic>>?> loadProducts() =>
      _load(_productsKey);

  static Future<void> saveConversations(
          List<Map<String, dynamic>> conversations) =>
      _save(_conversationsKey, conversations, _maxConversations);

  static Future<List<Map<String, dynamic>>?> loadConversations() =>
      _load(_conversationsKey);

  /// Home's four calls (today's stats, recent orders, low-stock, unread
  /// count) are always fetched and shown together, so they're cached as one
  /// snapshot rather than four separate entries — simpler, and there's never
  /// a case where you'd want one without the others.
  static Future<void> saveHomeSnapshot({
    required Map<String, dynamic> stats,
    required List<dynamic> recentOrders,
    required List<dynamic> lowStock,
    required int unreadNotifications,
  }) async {
    try {
      await _storage.write(
          key: _homeSnapshotKey,
          value: jsonEncode({
            'stats': stats,
            'recent_orders': recentOrders,
            'low_stock': lowStock,
            'unread_notifications': unreadNotifications,
          }));
    } catch (_) {
      // Best-effort — never let it break a successful fetch.
    }
  }

  static Future<Map<String, dynamic>?> loadHomeSnapshot() async {
    try {
      final raw = await _storage.read(key: _homeSnapshotKey);
      if (raw == null) return null;
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  /// Applies an optimistic patch to a cached product (by id) so an offline
  /// edit — queued for later sync — is reflected immediately if the merchant
  /// looks at the (offline) list again before the queue flushes.
  static Future<void> patchCachedProduct(
      String id, Map<String, dynamic> patch) async {
    final items = await loadProducts();
    if (items == null) return;
    final idx = items.indexWhere((p) => '${p['id']}' == id);
    if (idx == -1) return;
    items[idx] = {...items[idx], ...patch};
    await saveProducts(items);
  }

  /// Same as [patchCachedProduct] but for the cached orders list.
  static Future<void> patchCachedOrder(
      String id, Map<String, dynamic> patch) async {
    final items = await loadOrders();
    if (items == null) return;
    final idx = items.indexWhere((o) => '${o['id']}' == id);
    if (idx == -1) return;
    items[idx] = {...items[idx], ...patch};
    await saveOrders(items);
  }

  static Future<void> _save(
      String key, List<Map<String, dynamic>> items, int cap) async {
    try {
      final capped = items.length > cap ? items.sublist(0, cap) : items;
      await _storage.write(key: key, value: jsonEncode(capped));
    } catch (_) {
      // Caching is best-effort — never let it break a successful fetch.
    }
  }

  static Future<List<Map<String, dynamic>>?> _load(String key) async {
    try {
      final raw = await _storage.read(key: key);
      if (raw == null) return null;
      final decoded = jsonDecode(raw) as List;
      return decoded.cast<Map<String, dynamic>>();
    } catch (_) {
      return null;
    }
  }
}
