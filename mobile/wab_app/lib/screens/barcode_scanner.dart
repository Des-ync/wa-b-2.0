import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/product_quick_edit.dart';
import 'order_detail.dart';

/// Order numbers look like `ORD-2026-A3F9K2` (see server's generateOrderNumber
/// in src/utils/helpers.js) — used to tell an order-lookup scan apart from a
/// product search scan.
final _orderNumberPattern =
    RegExp(r'^ORD-\d{4}-[A-Z0-9]{4,10}$', caseSensitive: false);

/// Camera scanner reachable from the Products screen. Two honest use cases,
/// scoped to what the backend actually supports today:
///
///  1. Scan text that looks like an order number (`ORD-YYYY-XXXXXX`) — there
///     is no server-side lookup-by-order-number endpoint reachable from the
///     app, so this filters the merchant's already-loaded recent orders
///     client-side and jumps to the match if there is one.
///  2. Anything else is treated as a product search shortcut — there's no
///     `barcode` column on `products`, so a scan is matched as a text search
///     against the loaded product list's name/category, not a guaranteed
///     exact lookup. A single match opens the quick editor straight away.
///
/// Scanning the shop's own storefront QR (`storefront.html?shop=<slug>`) is
/// recognised and shown for information — there's nothing for a merchant to
/// *do* with their own storefront link inside the app, so we don't fake an
/// action for it.
class BarcodeScannerScreen extends StatefulWidget {
  final List<Map<String, dynamic>> products;
  const BarcodeScannerScreen({super.key, required this.products});

  @override
  State<BarcodeScannerScreen> createState() => _BarcodeScannerScreenState();
}

class _BarcodeScannerScreenState extends State<BarcodeScannerScreen> {
  final _controller = MobileScannerController();
  bool _busy = false; // guards against a burst of detections firing twice

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy) return;
    final raw = capture.barcodes.firstOrNull?.rawValue?.trim();
    if (raw == null || raw.isEmpty) return;
    setState(() => _busy = true);
    await _controller.stop();

    if (raw.contains('storefront.html') && raw.contains('shop=')) {
      await _showStorefrontInfo(raw);
    } else if (_orderNumberPattern.hasMatch(raw)) {
      await _lookupOrder(raw);
    } else {
      await _searchProduct(raw);
    }

    if (mounted) {
      setState(() => _busy = false);
      await _controller.start();
    }
  }

  Future<void> _showStorefrontInfo(String url) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('That\'s your storefront QR'),
        content: Text(
            'This code opens your customer-facing storefront:\n\n$url\n\nIt\'s meant for customers to scan — there\'s nothing to do with it here.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
  }

  Future<void> _lookupOrder(String orderNumber) async {
    final session = context.read<Session>();
    try {
      final res = await session.api.get('/api/orders',
          query: {'business_id': session.businessId, 'limit': 100});
      final orders =
          ((res['orders'] as List?) ?? []).cast<Map<String, dynamic>>();
      final match = orders.where((o) =>
          '${o['order_number']}'.toUpperCase() == orderNumber.toUpperCase());
      if (match.isEmpty) {
        _toast(
            'No matching order found among your recent orders for "$orderNumber".');
        return;
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(
          builder: (_) => OrderDetailScreen(orderId: '${match.first['id']}')));
    } catch (e) {
      _toast('Could not look up that order: $e');
    }
  }

  Future<void> _searchProduct(String text) async {
    final needle = text.toLowerCase();
    final matches = widget.products.where((p) {
      final name = '${p['name'] ?? ''}'.toLowerCase();
      final category = '${p['category'] ?? ''}'.toLowerCase();
      return name.contains(needle) ||
          category.contains(needle) ||
          needle.contains(name);
    }).toList();

    if (matches.isEmpty) {
      _toast('No matching product for "$text".');
      return;
    }
    if (matches.length == 1) {
      await _openProduct(matches.first);
      return;
    }
    await _pickProduct(matches);
  }

  Future<void> _pickProduct(List<Map<String, dynamic>> matches) async {
    if (!mounted) return;
    final chosen = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Multiple matches — pick one',
                    style:
                        TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
              ),
            ),
            ...matches.map((p) => ListTile(
                  title: Text('${p['name']}'),
                  subtitle: Text(ghs(p['price_ghs'])),
                  onTap: () => Navigator.pop(context, p),
                )),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
    if (chosen != null) await _openProduct(chosen);
  }

  Future<void> _openProduct(Map<String, dynamic> product) async {
    if (!mounted) return;
    await showProductQuickEdit(context, product);
    if (mounted) Navigator.of(context).pop();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Semantics(liveRegion: true, child: Text(message)),
        backgroundColor: WabColors.danger));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('Scan'),
        actions: [
          ValueListenableBuilder<MobileScannerState>(
            valueListenable: _controller,
            builder: (context, state, _) {
              final on = state.torchState == TorchState.on;
              return IconButton(
                tooltip: on ? 'Turn off flashlight' : 'Turn on flashlight',
                onPressed: () => _controller.toggleTorch(),
                icon:
                    Icon(on ? Icons.flash_on_rounded : Icons.flash_off_rounded),
              );
            },
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error) => Container(
              color: Colors.black,
              alignment: Alignment.center,
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.no_photography_rounded,
                        color: Colors.white54, size: 40),
                    const SizedBox(height: 14),
                    Text(error.errorCode.name,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white70)),
                  ],
                ),
              ),
            ),
          ),
          if (_busy)
            Container(
              color: Colors.black45,
              alignment: Alignment.center,
              child: const CircularProgressIndicator(color: Colors.white),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 32,
            child: Center(
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: BoxDecoration(
                    color: Colors.black54,
                    borderRadius: BorderRadius.circular(999)),
                child: const Text(
                    'Point the camera at a barcode, QR code, or product label',
                    style: TextStyle(color: Colors.white, fontSize: 13)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

extension _FirstOrNull<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
