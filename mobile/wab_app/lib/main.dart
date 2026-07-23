import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'screens/login.dart';
import 'screens/welcome_carousel.dart';
import 'screens/shell.dart';
import 'screens/splash.dart';
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

/// Decides the first screen: onboarding (first launch) → login → main shell.
class _Gate extends StatefulWidget {
  const _Gate();

  @override
  State<_Gate> createState() => _GateState();
}

class _GateState extends State<_Gate> {
  bool? _seenOnboarding;
  bool _pushStarted = false;
  bool _minSplashElapsed = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final prefs = await SharedPreferences.getInstance();
    final seen = prefs.getBool('seen_onboarding') ?? false;
    if (mounted) setState(() => _seenOnboarding = seen);
    if (mounted) await context.read<Session>().restore();
  }

  Future<void> _finishOnboarding() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('seen_onboarding', true);
    setState(() => _seenOnboarding = true);
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    // Keep the branded splash up until BOTH the minimum animation time and
    // the actual boot work (prefs + session restore, which can include a
    // network round trip) are done — one continuous loading screen instead
    // of a splash that hands off to a second, unbranded spinner screen.
    final bootDone = _seenOnboarding != null && !session.restoring;
    if (!_minSplashElapsed || !bootDone) {
      return SplashScreen(
          onDone: () => setState(() => _minSplashElapsed = true));
    }

    if (!_seenOnboarding!) {
      return WelcomeCarouselScreen(onDone: _finishOnboarding);
    }
    if (!session.loggedIn) {
      return const LoginScreen();
    }
    // Start push once per logged-in lifecycle; re-registers on next login too.
    if (!_pushStarted) {
      _pushStarted = true;
      PushService.init(session);
    }
    return const MainShell();
  }
}
