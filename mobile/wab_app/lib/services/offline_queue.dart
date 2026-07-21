import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';

/// A single mutation that couldn't reach the server (accept order, mark
/// ready, toggle stock, ...), waiting to be replayed once connectivity
/// returns.
class QueuedAction {
  final String id;
  final String method; // 'PATCH' | 'POST'
  final String path;
  final Map<String, dynamic>? body;
  final String description; // shown to the merchant while it's queued
  final int retryCount;

  QueuedAction({
    required this.id,
    required this.method,
    required this.path,
    required this.body,
    required this.description,
    this.retryCount = 0,
  });

  QueuedAction bumpRetry() => QueuedAction(
        id: id,
        method: method,
        path: path,
        body: body,
        description: description,
        retryCount: retryCount + 1,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'method': method,
        'path': path,
        'body': body,
        'description': description,
        'retryCount': retryCount,
      };

  factory QueuedAction.fromJson(Map<String, dynamic> json) => QueuedAction(
        id: json['id'] as String,
        method: json['method'] as String,
        path: json['path'] as String,
        body: (json['body'] as Map?)?.cast<String, dynamic>(),
        description: json['description'] as String? ?? '',
        retryCount: (json['retryCount'] as num?)?.toInt() ?? 0,
      );
}

/// Local queue of actions taken while offline. Flushed in order once
/// connectivity is restored; entries that still fail stay queued with an
/// incremented retry count rather than being dropped.
class OfflineQueue {
  static const _key = 'wab_action_queue_v1';

  // Guards against two screens (Orders + Products live simultaneously in the
  // IndexedStack) both reacting to the same reconnect event and flushing at
  // the same time.
  static bool _flushing = false;

  static Future<List<QueuedAction>> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return [];
      final decoded = jsonDecode(raw) as List;
      return decoded
          .map((e) => QueuedAction.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return [];
    }
  }

  static Future<void> _saveAll(List<QueuedAction> items) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(items.map((e) => e.toJson()).toList()));
  }

  static Future<void> enqueue(QueuedAction action) async {
    final items = await load();
    items.add(action);
    await _saveAll(items);
  }

  /// Replays every queued action against the real API, in order. Successes
  /// are removed; failures stay queued with `retryCount` incremented so the
  /// UI can surface "still pending" state.
  static Future<void> flush(ApiClient api) async {
    if (_flushing) return;
    _flushing = true;
    try {
      final items = await load();
      if (items.isEmpty) return;
      final remaining = <QueuedAction>[];
      for (final action in items) {
        try {
          switch (action.method) {
            case 'PATCH':
              await api.patch(action.path, body: action.body);
            case 'POST':
              await api.post(action.path, body: action.body);
          }
        } catch (_) {
          remaining.add(action.bumpRetry());
        }
      }
      await _saveAll(remaining);
    } finally {
      _flushing = false;
    }
  }
}
