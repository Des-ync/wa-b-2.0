import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../state/session.dart';

/// Notification taps (push or local) surface here; the shell listens and
/// navigates to the right screen ({type: order|message|product|...}).
final StreamController<Map<String, String>> notificationTaps =
    StreamController.broadcast();

// Action identifiers, shared between the action-button registration below
// and the response handler that fires when one of them is tapped.
const _actionOrderAccept = 'order_accept';
const _actionOrderMarkReady = 'order_mark_ready';
const _actionHandoffReply = 'handoff_reply';

// iOS notification categories, one per push `type` that has actions.
const _categoryOrder = 'order_actions';
const _categoryHandoff = 'handoff_actions';

class PushService {
  static final _local = FlutterLocalNotificationsPlugin();
  static bool _firebaseReady = false;

  /// Set by [init]. Notification action buttons fire from outside any
  /// widget's BuildContext (the user may not even have the app open), so
  /// this static reference is the only practical way for them to reach the
  /// API — there's exactly one logged-in session per app instance, and the
  /// rest of this class is already static-only for the same reason.
  static Session? _session;

  /// Safe to call before google-services.json / GoogleService-Info.plist
  /// exist — everything degrades to a no-op until Firebase is configured.
  static Future<void> init(Session session) async {
    _session = session;
    try {
      await Firebase.initializeApp();
      _firebaseReady = true;
    } catch (e) {
      debugPrint('Push disabled (Firebase not configured yet): $e');
      return;
    }

    const androidChannel = AndroidNotificationChannel(
      'wab_default',
      'WA-B notifications',
      description: 'Orders, messages and account alerts',
      importance: Importance.high,
    );
    await _local.initialize(
      InitializationSettings(
        android: const AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(
          notificationCategories: [
            DarwinNotificationCategory(
              _categoryOrder,
              actions: [
                DarwinNotificationAction.plain(_actionOrderAccept, 'Accept',
                    options: const {DarwinNotificationActionOption.foreground}),
                DarwinNotificationAction.plain(
                    _actionOrderMarkReady, 'Mark ready',
                    options: const {DarwinNotificationActionOption.foreground}),
              ],
            ),
            DarwinNotificationCategory(
              _categoryHandoff,
              actions: [
                // A text-input action renders as iOS's native inline-reply
                // field — no options set, so it does NOT bring the app to
                // the foreground to collect it.
                DarwinNotificationAction.text(
                  _actionHandoffReply,
                  'Reply',
                  buttonTitle: 'Send',
                  placeholder: 'Type a reply…',
                ),
              ],
            ),
          ],
        ),
      ),
      onDidReceiveNotificationResponse: _onResponse,
    );
    await _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(androidChannel);

    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);

    final token = await messaging.getToken();
    if (token != null) await session.registerDevice(token);
    messaging.onTokenRefresh.listen((t) => session.registerDevice(t));

    // Foreground pushes don't show a banner by default — mirror them locally.
    FirebaseMessaging.onMessage.listen((msg) {
      final n = msg.notification;
      if (n == null) return;
      final type = msg.data['type']?.toString();
      _local.show(
        n.hashCode,
        n.title,
        n.body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            'wab_default',
            'WA-B notifications',
            importance: Importance.high,
            priority: Priority.high,
            actions: _androidActionsFor(type),
          ),
          iOS: DarwinNotificationDetails(categoryIdentifier: _iosCategoryFor(type)),
        ),
        payload: _encodePayload(msg.data),
      );
    });

    // Tap on a background/terminated push.
    FirebaseMessaging.onMessageOpenedApp.listen((msg) {
      notificationTaps.add(msg.data.map((k, v) => MapEntry(k, '$v')));
    });
    final initial = await messaging.getInitialMessage();
    if (initial != null) {
      notificationTaps.add(initial.data.map((k, v) => MapEntry(k, '$v')));
    }
  }

  static bool get isReady => _firebaseReady;

  /// Action buttons for a locally-mirrored notification of the given push
  /// `type`. Only `order` and `handoff` carry actions today; anything else
  /// (including unknown/absent types) falls back to plain tap-to-navigate.
  static List<AndroidNotificationAction>? _androidActionsFor(String? type) {
    switch (type) {
      case 'order':
        return const [
          // showsUserInterface defaults to false — these fire straight
          // against the API without bringing the app to the foreground.
          AndroidNotificationAction(_actionOrderAccept, 'Accept'),
          AndroidNotificationAction(_actionOrderMarkReady, 'Mark ready'),
        ];
      case 'handoff':
        return const [
          // Android's inline-reply UI: only shown when the OS/launcher
          // supports it. Where it isn't supported the plugin degrades this
          // to a normal tap, which _onResponse below treats as a plain tap
          // (no captured input) and falls back to opening the chat screen.
          AndroidNotificationAction(
            _actionHandoffReply,
            'Reply',
            inputs: [AndroidNotificationActionInput(label: 'Type a reply…')],
          ),
        ];
      default:
        return null;
    }
  }

  static String? _iosCategoryFor(String? type) => switch (type) {
        'order' => _categoryOrder,
        'handoff' => _categoryHandoff,
        _ => null,
      };

  static void _onResponse(NotificationResponse resp) {
    final data = resp.payload != null ? _parsePayload(resp.payload!) : <String, String>{};
    switch (resp.actionId) {
      case _actionOrderAccept:
        _patchOrderStatus(data['order_id'], 'confirmed');
        return;
      case _actionOrderMarkReady:
        _patchOrderStatus(data['order_id'], 'ready');
        return;
      case _actionHandoffReply:
        final text = resp.input?.trim();
        if (text != null && text.isNotEmpty) {
          _sendHandoffReply(data['customer_id'], text);
          return;
        }
        // No inline-reply input was captured (device/OS version doesn't
        // support it) — fall through to the plain-tap behaviour below,
        // which opens the chat screen for this customer.
        break;
    }
    notificationTaps.add(data);
  }

  static Future<void> _patchOrderStatus(String? orderId, String status) async {
    final session = _session;
    if (session == null || orderId == null) return;
    try {
      await session.api.patch('/api/orders/$orderId/status', body: {'status': status});
    } catch (e) {
      debugPrint('Order action ($status) failed for order $orderId: $e');
    }
  }

  static Future<void> _sendHandoffReply(String? customerId, String text) async {
    final session = _session;
    if (session == null || customerId == null) return;
    try {
      await session.api.post('/api/conversations/$customerId/reply', body: {'text': text});
    } catch (e) {
      debugPrint('Handoff reply failed for customer $customerId: $e');
    }
  }

  static String _encodePayload(Map<String, dynamic> data) =>
      data.entries.map((e) => '${e.key}=${e.value}').join('&');

  static Map<String, String> _parsePayload(String payload) {
    final out = <String, String>{};
    for (final part in payload.split('&')) {
      final i = part.indexOf('=');
      if (i > 0) out[part.substring(0, i)] = part.substring(i + 1);
    }
    return out;
  }
}
