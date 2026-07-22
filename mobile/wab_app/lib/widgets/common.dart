import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../theme.dart';

/// Standard "pull to refresh + load + error + empty" scaffold used by every
/// list screen so states look consistent app-wide.
class AsyncList<T> extends StatelessWidget {
  final Future<List<T>> Function() load;
  final Widget Function(BuildContext, T) itemBuilder;
  final String emptyTitle;
  final String emptySubtitle;
  final IconData emptyIcon;
  // Applied to the loaded list on every rebuild — WITHOUT re-fetching —
  // so a search box above an AsyncList can filter as-you-type. Safe because
  // the underlying Future is cached in State and only re-created on refresh
  // or a `key` change; changing `transform` alone just re-renders from the
  // already-resolved data.
  final List<T> Function(List<T>)? transform;
  final String? emptyFilteredTitle;

  const AsyncList({
    super.key,
    required this.load,
    required this.itemBuilder,
    required this.emptyTitle,
    this.emptySubtitle = '',
    this.emptyIcon = Icons.inbox_rounded,
    this.transform,
    this.emptyFilteredTitle,
  });

  @override
  Widget build(BuildContext context) {
    return _AsyncListBody(
        load: load,
        itemBuilder: itemBuilder,
        emptyTitle: emptyTitle,
        emptySubtitle: emptySubtitle,
        emptyIcon: emptyIcon,
        transform: transform,
        emptyFilteredTitle: emptyFilteredTitle);
  }
}

class _AsyncListBody<T> extends StatefulWidget {
  final Future<List<T>> Function() load;
  final Widget Function(BuildContext, T) itemBuilder;
  final String emptyTitle;
  final String emptySubtitle;
  final IconData emptyIcon;
  final List<T> Function(List<T>)? transform;
  final String? emptyFilteredTitle;

  const _AsyncListBody({
    required this.load,
    required this.itemBuilder,
    required this.emptyTitle,
    required this.emptySubtitle,
    required this.emptyIcon,
    this.transform,
    this.emptyFilteredTitle,
  });

  @override
  State<_AsyncListBody<T>> createState() => _AsyncListBodyState<T>();
}

class _AsyncListBodyState<T> extends State<_AsyncListBody<T>> {
  late Future<List<T>> _future = widget.load();

  Future<void> _refresh() async {
    setState(() => _future = widget.load());
    await _future.catchError((_) => <T>[]);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<T>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: 6,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, __) => const SkeletonCard(),
          );
        }
        if (snap.hasError) {
          return ErrorRetry(message: '${snap.error}', onRetry: _refresh);
        }
        final loaded = snap.data ?? [];
        final items =
            widget.transform != null ? widget.transform!(loaded) : loaded;
        if (items.isEmpty) {
          final filtered =
              loaded.isNotEmpty && widget.emptyFilteredTitle != null;
          return RefreshIndicator(
            onRefresh: _refresh,
            color: WabColors.accent,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                SizedBox(height: MediaQuery.of(context).size.height * 0.22),
                EmptyState(
                    icon:
                        filtered ? Icons.search_off_rounded : widget.emptyIcon,
                    title: filtered
                        ? widget.emptyFilteredTitle!
                        : widget.emptyTitle,
                    subtitle: filtered ? '' : widget.emptySubtitle),
              ],
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: _refresh,
          color: WabColors.accent,
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (ctx, i) => widget.itemBuilder(ctx, items[i]),
          ),
        );
      },
    );
  }
}

/// The brand's one signature motif: a thin woven kente band
/// (gold / market green / forest ink / brick). Mirrors the web's --kente token.
class KenteStrip extends StatelessWidget {
  final double height;
  final BorderRadius? borderRadius;
  const KenteStrip({super.key, this.height = 4, this.borderRadius});

  @override
  Widget build(BuildContext context) {
    final strip = SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(painter: _KentePainter()),
    );
    if (borderRadius == null) return strip;
    return ClipRRect(borderRadius: borderRadius!, child: strip);
  }
}

class _KentePainter extends CustomPainter {
  static const _threads = <(Color, double)>[
    (WabColors.gold, 28),
    (WabColors.accent, 16),
    (WabColors.ink, 8),
    (WabColors.brick, 8),
    (WabColors.ink, 8),
    (WabColors.accent, 16),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint();
    double x = 0;
    int i = 0;
    while (x < size.width) {
      final (color, w) = _threads[i % _threads.length];
      paint.color = color;
      canvas.drawRect(Rect.fromLTWH(x, 0, w, size.height), paint);
      x += w;
      i++;
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// One pulsing placeholder bar/block. Built entirely on core Flutter
/// (AnimationController + Opacity) — no shimmer package needed. Respects
/// the OS "reduce motion" setting by skipping the pulse entirely.
class Skeleton extends StatefulWidget {
  final double? width;
  final double height;
  final BorderRadius borderRadius;
  const Skeleton({
    super.key,
    this.width,
    this.height = 14,
    this.borderRadius = const BorderRadius.all(Radius.circular(6)),
  });

  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );
  late final Animation<double> _opacity = Tween<double>(begin: 0.4, end: 1.0)
      .animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.maybeOf(context)?.disableAnimations ?? false) {
      _controller.value = 0.6;
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _box() => Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
            color: WabColors.bg2, borderRadius: widget.borderRadius),
      );

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.maybeOf(context)?.disableAnimations ?? false) return _box();
    return FadeTransition(opacity: _opacity, child: _box());
  }
}

/// A Card-shaped skeleton matching the title/subtitle/trailing-chip layout
/// most list rows in this app use — dropped into AsyncList's loading state
/// so a fetch reads as "content on the way" instead of a bare spinner.
class SkeletonCard extends StatelessWidget {
  const SkeletonCard({super.key});

  @override
  Widget build(BuildContext context) {
    return const Card(
      child: Padding(
        padding: EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Skeleton(width: 150, height: 14),
                  SizedBox(height: 10),
                  Skeleton(width: 90, height: 11),
                ],
              ),
            ),
            SizedBox(width: 16),
            Skeleton(
                width: 46,
                height: 20,
                borderRadius: BorderRadius.all(Radius.circular(10))),
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const EmptyState(
      {super.key, required this.icon, required this.title, this.subtitle = ''});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 88,
          height: 88,
          decoration: BoxDecoration(
              color: WabColors.bg2, borderRadius: BorderRadius.circular(28)),
          child: Icon(icon, size: 40, color: WabColors.muted2),
        ),
        const SizedBox(height: 18),
        Text(title,
            style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
                color: WabColors.ink)),
        if (subtitle.isNotEmpty) ...[
          const SizedBox(height: 6),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Text(subtitle,
                textAlign: TextAlign.center,
                style: const TextStyle(color: WabColors.muted, height: 1.4)),
          ),
        ],
      ],
    );
  }
}

class ErrorRetry extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;
  const ErrorRetry({super.key, required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded,
                size: 40, color: WabColors.muted2),
            const SizedBox(height: 14),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: WabColors.muted, height: 1.4)),
            const SizedBox(height: 18),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

/// Compact search box for above an AsyncList — filters client-side, no
/// network round trip per keystroke. Pair with AsyncList's `transform`.
class SearchField extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final ValueChanged<String> onChanged;
  const SearchField(
      {super.key,
      required this.controller,
      required this.hint,
      required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          hintText: hint,
          prefixIcon: const Icon(Icons.search_rounded, color: WabColors.muted2),
          suffixIcon: controller.text.isEmpty
              ? null
              : IconButton(
                  icon: const Icon(Icons.close_rounded, size: 18),
                  onPressed: () {
                    controller.clear();
                    onChanged('');
                  },
                ),
          filled: true,
          fillColor: WabColors.bg2,
          contentPadding: const EdgeInsets.symmetric(vertical: 10),
          border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide.none),
        ),
      ),
    );
  }
}

/// Shown above a list when it's serving cached data because the last fetch
/// failed — keeps the merchant informed instead of silently showing stale
/// numbers as if they were live.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: WabColors.warning.withValues(alpha: 0.12),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: const Row(
        children: [
          Icon(Icons.cloud_off_rounded, size: 16, color: WabColors.warning),
          SizedBox(width: 8),
          Expanded(
            child: Text('Showing cached data — you\'re offline',
                style: TextStyle(
                    color: WabColors.warning,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}

/// Colored status chip for orders / subscriptions / broadcasts. [status]
/// alone drives the color (so every existing vocabulary — business status,
/// broadcast status, delivery status — keeps working unchanged); pass
/// [label] only when the raw value needs a friendlier reading for this one
/// call site (see [paymentStatusLabel]).
class StatusChip extends StatelessWidget {
  final String status;
  final String? label;
  const StatusChip(this.status, {super.key, this.label});

  Color get _color => switch (status) {
        'paid' ||
        'active' ||
        'delivered' ||
        'done' ||
        'sent' ||
        'settled' ||
        'success' =>
          WabColors.accentInk,
        'pending' ||
        'confirmed' ||
        'preparing' ||
        'ready' ||
        'sending' ||
        'trial' ||
        'unpaid' =>
          WabColors.warning,
        'failed' ||
        'cancelled' ||
        'expired' ||
        'suspended' ||
        'refunded' =>
          WabColors.danger,
        _ => WabColors.muted,
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: _color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label ?? status,
          style: TextStyle(
              fontSize: 12, fontWeight: FontWeight.w700, color: _color)),
    );
  }
}

/// Friendly reading of an order's payment_status for merchants — the raw
/// backend value ('unpaid', 'pending', ...) still drives StatusChip's color,
/// this is purely the text. Unknown/non-payment values pass through
/// unchanged so this stays safe to use on a payment_status-or-status
/// fallback (home.dart's recent-orders tile).
String paymentStatusLabel(String? status) => switch (status) {
      'paid' => 'Payment received',
      'pending' || 'unpaid' => 'Awaiting payment',
      'failed' => 'Payment failed',
      'refunded' => 'Refunded',
      _ => status ?? '—',
    };

String timeAgo(dynamic isoDate) {
  if (isoDate == null) return '';
  final dt = DateTime.tryParse('$isoDate')?.toLocal();
  if (dt == null) return '';
  final diff = DateTime.now().difference(dt);
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  if (diff.inDays < 7) return '${diff.inDays}d ago';
  return DateFormat('d MMM').format(dt);
}

String shortDate(dynamic isoDate) {
  final dt = DateTime.tryParse('${isoDate ?? ''}')?.toLocal();
  if (dt == null) return '';
  return DateFormat('d MMM yyyy, HH:mm').format(dt);
}
