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

class PushService {
  static final _local = FlutterLocalNotificationsPlugin();
  static bool _firebaseReady = false;

  /// Safe to call before google-services.json / GoogleService-Info.plist
  /// exist — everything degrades to a no-op until Firebase is configured.
  static Future<void> init(Session session) async {
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
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
      onDidReceiveNotificationResponse: (resp) {
        final payload = resp.payload;
        if (payload != null) notificationTaps.add(_parsePayload(payload));
      },
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
      _local.show(
        n.hashCode,
        n.title,
        n.body,
        const NotificationDetails(
          android: AndroidNotificationDetails(
            'wab_default',
            'WA-B notifications',
            importance: Importance.high,
            priority: Priority.high,
          ),
          iOS: DarwinNotificationDetails(),
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
