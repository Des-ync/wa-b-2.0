import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'screens/login.dart';
import 'screens/onboarding.dart';
import 'screens/shell.dart';
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

    if (_seenOnboarding == null || session.restoring) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: WabColors.accent)),
      );
    }
    if (!_seenOnboarding!) {
      return OnboardingScreen(onDone: _finishOnboarding);
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
