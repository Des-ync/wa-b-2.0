import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/wab_logo.dart';

/// App-startup splash: logo scales/fades in on a paper card, tagline
/// follows, three dots pulse while the app boots underneath.
///
/// [onDone] fires once the brand animation has had enough time to read —
/// it does NOT mean the app has finished booting. The caller (`_Gate` in
/// main.dart) keeps this widget mounted until session restore finishes too,
/// so there's never a jarring hand-off to a second, unbranded loading
/// screen — the pulsing dots just keep going if the network is slow.
class SplashScreen extends StatefulWidget {
  final VoidCallback onDone;

  const SplashScreen({super.key, required this.onDone});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with TickerProviderStateMixin {
  late final AnimationController _logoController;
  late final Animation<double> _logoScale;
  late final Animation<double> _logoOpacity;
  late final AnimationController _taglineController;
  late final Animation<double> _taglineOpacity;

  @override
  void initState() {
    super.initState();

    _logoController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 650),
    );
    _logoScale = Tween<double>(begin: 0.86, end: 1).animate(
      CurvedAnimation(parent: _logoController, curve: Curves.easeOutCubic),
    );
    _logoOpacity =
        CurvedAnimation(parent: _logoController, curve: Curves.easeOut);

    _taglineController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 400),
    );
    _taglineOpacity =
        CurvedAnimation(parent: _taglineController, curve: Curves.easeOut);

    _logoController.forward();
    Future.delayed(const Duration(milliseconds: 350), () {
      if (mounted) _taglineController.forward();
    });
    // Just past the logo (650ms) + tagline (350ms delay + 400ms fade)
    // animation finishing — was a flat 1700ms, adding ~800ms of dead time
    // to every cold start for no visual benefit.
    Future.delayed(const Duration(milliseconds: 900), () {
      if (mounted) widget.onDone();
    });
  }

  @override
  void dispose() {
    _logoController.dispose();
    _taglineController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: WabColors.ink,
      body: Center(
        child: Semantics(
          label: 'Loading WA-B',
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedBuilder(
                animation: _logoController,
                builder: (context, child) => Opacity(
                  opacity: _logoOpacity.value,
                  child: Transform.scale(scale: _logoScale.value, child: child),
                ),
                child: const WabLogo(height: 44, color: Colors.white),
              ),
              const SizedBox(height: 14),
              FadeTransition(
                opacity: _taglineOpacity,
                child: Text(
                  'a ske solution',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.72),
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 0.2,
                  ),
                ),
              ),
              const SizedBox(height: 40),
              const _PulseDots(),
            ],
          ),
        ),
      ),
    );
  }
}

class _PulseDots extends StatefulWidget {
  const _PulseDots();

  @override
  State<_PulseDots> createState() => _PulseDotsState();
}

class _PulseDotsState extends State<_PulseDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final t = (_controller.value - i * 0.2) % 1.0;
            final pulse = t < 0.5 ? (t / 0.5) : (1 - (t - 0.5) / 0.5);
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Opacity(
                opacity: 0.25 + pulse * 0.65,
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: const BoxDecoration(
                    color: Colors.white,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
