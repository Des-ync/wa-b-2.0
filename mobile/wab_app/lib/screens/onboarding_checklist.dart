import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../api/onboarding_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'settings.dart';

/// The real onboarding checklist — not the first-run marketing carousel
/// (welcome_carousel.dart). Walks a merchant through the steps
/// src/routes/onboarding.routes.js#computeOnboardingSteps actually checks,
/// with an action wired to each one wherever mobile can complete it itself.
class OnboardingChecklistScreen extends StatefulWidget {
  const OnboardingChecklistScreen({super.key});

  @override
  State<OnboardingChecklistScreen> createState() =>
      _OnboardingChecklistScreenState();
}

class _OnboardingChecklistScreenState extends State<OnboardingChecklistScreen> {
  Map<String, dynamic>? _status;
  Map<String, dynamic>? _health;
  String? _error;
  bool _loading = true;
  String? _busyAction; // step key currently running an action, if any

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _status == null;
      _error = null;
    });
    final session = context.read<Session>();
    try {
      final results = await Future.wait([
        session.api.getOnboardingStatus(session.businessId!),
        session.api.getWebhookHealth(session.businessId!),
      ]);
      if (!mounted) return;
      setState(() {
        _status = results[0];
        _health = results[1];
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _editProfile() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const SettingsScreen()));
    _load();
  }

  Future<void> _sendTestMessage() async {
    setState(() => _busyAction = 'test_message');
    final session = context.read<Session>();
    try {
      await session.api.sendOnboardingTestMessage(session.businessId!);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(
                liveRegion: true,
                child: const Text(
                    'Test message sent — check your shop\'s WhatsApp ✓'))));
      }
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busyAction = null);
    }
  }

  Future<void> _loadSampleCatalog() async {
    setState(() => _busyAction = 'first_products');
    final session = context.read<Session>();
    try {
      final res = await session.api.loadSampleCatalog(session.businessId!);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(
                liveRegion: true,
                child: Text(
                    '${res['products_added'] ?? 0} sample products added ✓'))));
      }
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _busyAction = null);
    }
  }

  IconData _iconFor(String key) => switch (key) {
        'business_profile' => Icons.storefront_rounded,
        'whatsapp_number' => Icons.chat_rounded,
        'payment_provider' => Icons.payments_rounded,
        'first_products' => Icons.inventory_2_rounded,
        'test_message' => Icons.send_rounded,
        'invite_staff' => Icons.group_add_rounded,
        _ => Icons.circle_outlined,
      };

  Widget? _actionFor(Map<String, dynamic> step) {
    final key = '${step['key']}';
    final busy = _busyAction == key;
    switch (key) {
      case 'business_profile':
      case 'payment_provider':
        return OutlinedButton(
          onPressed: _editProfile,
          child: Text(key == 'payment_provider'
              ? 'Add payout details'
              : 'Edit business profile'),
        );
      case 'first_products':
        return OutlinedButton(
          onPressed: busy ? null : _loadSampleCatalog,
          child: busy
              ? Semantics(
                  label: 'Loading sample catalog',
                  child: const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2)))
              : const Text('Load a sample catalog'),
        );
      case 'test_message':
        return FilledButton.icon(
          onPressed: busy ? null : _sendTestMessage,
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.white))
              : const Icon(Icons.send_rounded, size: 18),
          label: const Text('Test my shop'),
        );
      default:
        return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Setup checklist')),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      _progressHeader(),
                      const SizedBox(height: 20),
                      for (final s in (_status?['steps'] as List? ?? []))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: _stepCard(s as Map<String, dynamic>),
                        ),
                      const SizedBox(height: 10),
                      _healthCard(),
                    ],
                  ),
                ),
    );
  }

  Widget _progressHeader() {
    final completed = _status?['completed_count'] ?? 0;
    final total = _status?['total_count'] ?? 0;
    final percent = ((_status?['percent'] ?? 0) as num) / 100;
    final allComplete = _status?['all_complete'] == true;
    return Container(
      decoration: BoxDecoration(
          color: WabColors.ink, borderRadius: BorderRadius.circular(20)),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
              allComplete
                  ? 'You\'re all set 🎉'
                  : 'Finish setting up your shop',
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text('$completed of $total steps complete',
              style: const TextStyle(color: Color(0xB3FFFFFF))),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: percent.clamp(0, 1).toDouble(),
              minHeight: 8,
              backgroundColor: Colors.white24,
              valueColor: const AlwaysStoppedAnimation(WabColors.gold),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stepCard(Map<String, dynamic> step) {
    final complete = step['complete'] == true;
    final optional = step['optional'] == true;
    final action = complete ? null : _actionFor(step);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              complete
                  ? Icons.check_circle_rounded
                  : _iconFor('${step['key']}'),
              color: complete ? WabColors.accentInk : WabColors.muted2,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('${step['label']}',
                            style: TextStyle(
                                fontWeight: FontWeight.w700,
                                decoration: complete
                                    ? TextDecoration.lineThrough
                                    : null,
                                color: complete
                                    ? WabColors.muted
                                    : WabColors.ink)),
                      ),
                      if (optional)
                        const Padding(
                          padding: EdgeInsets.only(left: 6),
                          child: Text('optional',
                              style: TextStyle(
                                  color: WabColors.muted, fontSize: 11)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text('${step['description']}',
                      style: const TextStyle(
                          color: WabColors.muted, fontSize: 13, height: 1.35)),
                  if (action != null) ...[
                    const SizedBox(height: 12),
                    action,
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _healthCard() {
    final wa = (_health?['whatsapp'] as Map?)?.cast<String, dynamic>() ?? {};
    final ps = (_health?['paystack'] as Map?)?.cast<String, dynamic>() ?? {};
    final waStatus = '${wa['status'] ?? 'not_connected'}';
    final waLabel = switch (waStatus) {
      'healthy' => 'Receiving messages normally',
      'no_inbound_received' =>
        'Connected, but no messages received yet — check your Meta webhook setup',
      'unknown' => 'Just connected — give it a little time',
      _ => 'Not connected yet',
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Connection health',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const SizedBox(height: 12),
            Row(
              children: [
                StatusChip(
                    waStatus == 'healthy'
                        ? 'active'
                        : waStatus == 'not_connected'
                            ? 'failed'
                            : 'pending',
                    label: 'WhatsApp'),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(waLabel,
                        style: const TextStyle(
                            color: WabColors.muted, fontSize: 13))),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                StatusChip(ps['mode'] == 'live' ? 'active' : 'pending',
                    label: 'Paystack (${ps['mode'] ?? 'unconfigured'})'),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                      'Shared across every shop on the platform — nothing to set up per shop.',
                      style: TextStyle(color: WabColors.muted, fontSize: 13)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
