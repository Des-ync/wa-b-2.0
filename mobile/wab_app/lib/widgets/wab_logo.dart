import 'package:flutter/material.dart';

/// The WA-B wordmark: a zigzag "WA" ligature, a dash, then "B".
/// Mirrors the brand mark used on the web dashboard and marketing assets.
class WabLogo extends StatelessWidget {
  final double height;
  final Color color;

  const WabLogo({super.key, this.height = 40, this.color = Colors.black});

  @override
  Widget build(BuildContext context) {
    final strokeWidth = height * 0.16;
    return Semantics(
      label: 'WA-B',
      excludeSemantics: true,
      child: SizedBox(
        height: height,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: height * 1.15,
              height: height,
              child: CustomPaint(
                painter:
                    _WabMarkPainter(color: color, strokeWidth: strokeWidth),
              ),
            ),
            SizedBox(width: height * 0.14),
            Container(
              width: height * 0.32,
              height: strokeWidth,
              color: color,
            ),
            SizedBox(width: height * 0.14),
            Text(
              'B',
              style: TextStyle(
                fontSize: height * 1.05,
                fontWeight: FontWeight.w900,
                height: 1,
                color: color,
                letterSpacing: -1,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WabMarkPainter extends CustomPainter {
  final Color color;
  final double strokeWidth;

  _WabMarkPainter({required this.color, required this.strokeWidth});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;

    final top = strokeWidth / 2;
    final bottom = size.height - strokeWidth / 2;

    // Zigzag "WA" ligature: W's last upstroke doubles as A's left leg,
    // with one extra downstroke closing A's apex on the right.
    final xs =
        [0.0, 0.2, 0.4, 0.6, 0.8, 1.0].map((f) => f * size.width).toList();
    final ys = [top, bottom, top, bottom, top, bottom];

    final path = Path()..moveTo(xs[0], ys[0]);
    for (var i = 1; i < xs.length; i++) {
      path.lineTo(xs[i], ys[i]);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _WabMarkPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.strokeWidth != strokeWidth;
}
