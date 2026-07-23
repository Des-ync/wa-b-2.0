import 'package:flutter/material.dart';
import 'package:smooth_page_indicator/smooth_page_indicator.dart';

import '../theme.dart';
import '../widgets/common.dart';

class _Slide {
  final IconData icon;
  final String title;
  final String body;
  const _Slide(this.icon, this.title, this.body);
}

const _slides = [
  _Slide(
    Icons.storefront_rounded,
    'Your shop, in your pocket',
    'See today\'s sales, orders and customers at a glance — everything your WhatsApp bot is doing, live.',
  ),
  _Slide(
    Icons.notifications_active_rounded,
    'Never miss a sale',
    'Get an instant notification the moment a customer pays, needs a human reply, or a product runs low on stock.',
  ),
  _Slide(
    Icons.chat_rounded,
    'Jump into any chat',
    'Pause the bot and answer customers yourself, right from the app — then hand the conversation back.',
  ),
  _Slide(
    Icons.insights_rounded,
    'Know what\'s working',
    'Revenue trends, top products, busiest hours and repeat customers — decisions backed by your real numbers.',
  ),
];

class WelcomeCarouselScreen extends StatefulWidget {
  final VoidCallback onDone;
  const WelcomeCarouselScreen({super.key, required this.onDone});

  @override
  State<WelcomeCarouselScreen> createState() => _WelcomeCarouselScreenState();
}

class _WelcomeCarouselScreenState extends State<WelcomeCarouselScreen> {
  final _controller = PageController();
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isLast = _page == _slides.length - 1;
    return Scaffold(
      backgroundColor: WabColors.bg,
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.only(top: 8, right: 8),
                child: TextButton(
                  onPressed: widget.onDone,
                  child: const Text('Skip',
                      style: TextStyle(color: WabColors.muted)),
                ),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: _slides.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (_, i) {
                  final s = _slides[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Container(
                          width: 148,
                          height: 148,
                          decoration: BoxDecoration(
                            color: WabColors.ink,
                            borderRadius: BorderRadius.circular(44),
                          ),
                          child: Stack(
                            alignment: Alignment.center,
                            children: [
                              Icon(s.icon, size: 68, color: WabColors.gold),
                              Positioned(
                                left: 24,
                                right: 24,
                                bottom: 22,
                                child: KenteStrip(
                                    height: 4,
                                    borderRadius: BorderRadius.circular(2)),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 44),
                        Text(
                          s.title,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 28,
                            fontWeight: FontWeight.w800,
                            color: WabColors.ink,
                            letterSpacing: -0.6,
                            height: 1.15,
                          ),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          s.body,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 16,
                            color: WabColors.muted,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
            SmoothPageIndicator(
              controller: _controller,
              count: _slides.length,
              effect: const ExpandingDotsEffect(
                activeDotColor: WabColors.gold,
                dotColor: WabColors.line,
                dotHeight: 8,
                dotWidth: 8,
                expansionFactor: 3,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
              child: FilledButton(
                onPressed: () {
                  if (isLast) {
                    widget.onDone();
                  } else {
                    _controller.nextPage(
                      duration: const Duration(milliseconds: 300),
                      curve: Curves.easeOut,
                    );
                  }
                },
                child: Text(isLast ? 'Get started' : 'Next'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
