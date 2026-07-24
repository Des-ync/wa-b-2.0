import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Persists the last-fetched orders/products lists so the Orders and
/// Products screens can show *something* immediately when a fetch fails
/// (no connection), instead of a blank error state.
///
/// Deliberately simple: JSON-encoded lists in shared_preferences, capped so
/// the cache never grows unbounded. Not a sync engine — just a "last known
/// good" snapshot.
class OfflineCache {
  static const _ordersKey = 'wab_cache_orders_v1';
  static const _productsKey = 'wab_cache_products_v1';
  static const _conversationsKey = 'wab_cache_conversations_v1';
  static const _homeSnapshotKey = 'wab_cache_home_v1';
  static const _maxOrders = 50;
  static const _maxProducts = 200;
  static const _maxConversations = 100;

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
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
          _homeSnapshotKey,
          jsonEncode({
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
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_homeSnapshotKey);
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
      final prefs = await SharedPreferences.getInstance();
      final capped = items.length > cap ? items.sublist(0, cap) : items;
      await prefs.setString(key, jsonEncode(capped));
    } catch (_) {
      // Caching is best-effort — never let it break a successful fetch.
    }
  }

  static Future<List<Map<String, dynamic>>?> _load(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(key);
      if (raw == null) return null;
      final decoded = jsonDecode(raw) as List;
      return decoded.cast<Map<String, dynamic>>();
    } catch (_) {
      return null;
    }
  }
}
