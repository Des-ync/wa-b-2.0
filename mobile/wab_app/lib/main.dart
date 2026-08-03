import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/login.dart';
import 'screens/welcome_carousel.dart';
import 'screens/shell.dart';
import 'screens/splash.dart';
import 'services/offline_cache.dart';
import 'services/push.dart';
import 'state/session.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const WabApp());
}

class WabApp extends StatelessWidget {
  const WabApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => Session(),
      child: MaterialApp(
        title: 'WA-B',
        debugShowCheckedModeBanner: false,
        theme: wabTheme(),
        home: const _Gate(),
      ),
    );
  }
}

/// Decides the first screen: onboarding → login → main shell.
///
/// Onboarding is NOT a once-ever flag — it shows on every cold start for as
/// long as this device has no logged-in session, and stops for good the
/// moment one exists (login persists to secure storage, so that's a durable
/// signal — unlike a "seen it" bit that would let someone dismiss the
/// carousel once and then never learn what the app does before signing up).
class _Gate extends StatefulWidget {
  const _Gate();

  @override
  State<_Gate> createState() => _GateState();
}

class _GateState extends State<_Gate> {
  // Deliberately in-memory only, reset on every process start — see the
  // class doc above for why this isn't persisted like `_pushStarted`.
  bool _onboardingDismissed = false;
  bool _pushStarted = false;
  bool _minSplashElapsed = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    // Older builds cached orders/products (customer names and phone numbers
    // among them) as cleartext shared_preferences. Those entries are dead
    // weight now that OfflineCache uses secure storage — drop them on the
    // first run of this build.
    unawaited(OfflineCache.purgeLegacyPlaintextCache());
    if (mounted) await context.read<Session>().restore();
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();

    Widget child;
    // Keep the branded splash up until BOTH the minimum animation time and
    // the actual boot work (session restore, which can include a network
    // round trip) are done — one continuous loading screen instead of a
    // splash that hands off to a second, unbranded spinner screen.
    if (!_minSplashElapsed || session.restoring) {
      child = SplashScreen(
          key: const ValueKey('splash'),
          onDone: () => setState(() => _minSplashElapsed = true));
    } else if (!session.loggedIn && !_onboardingDismissed) {
      child = WelcomeCarouselScreen(
          key: const ValueKey('onboarding'),
          onDone: () => setState(() => _onboardingDismissed = true));
    } else if (!session.loggedIn) {
      child = const LoginScreen(key: ValueKey('login'));
    } else {
      // Start push once per logged-in lifecycle; re-registers on next login too.
      if (!_pushStarted) {
        _pushStarted = true;
        PushService.init(session);
      }
      child = const MainShell(key: ValueKey('shell'));
    }

    // Every hand-off above used to be an instant, jarring cut from one
    // full-screen widget to the next (splash's dark background straight to
    // a white one, most noticeably). A cross-fade makes cold start read as
    // one continuous reveal instead of the app "restarting" mid-boot.
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 380),
      switchInCurve: Curves.easeOut,
      switchOutCurve: Curves.easeIn,
      child: child,
    );
  }
}
