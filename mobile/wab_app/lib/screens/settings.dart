import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Map<String, dynamic>? _settings;
  Map<String, dynamic>? _subscription;
  String? _error;
  bool _saving = false;

  final _welcome = TextEditingController();
  final _supportPhone = TextEditingController();
  final _deliveryFee = TextEditingController();
  final _openTime = TextEditingController();
  final _closeTime = TextEditingController();
  String _lang = 'en';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [_welcome, _supportPhone, _deliveryFee, _openTime, _closeTime]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    final session = context.read<Session>();
    try {
      final results = await Future.wait([
        session.api
            .get('/api/business/settings', query: {'business_id': session.businessId}),
        session.api.get('/api/subscriptions/${session.businessId}'),
      ]);
      if (!mounted) return;
      final s = results[0]['settings'] as Map<String, dynamic>? ?? {};
      setState(() {
        _settings = s;
        _subscription = results[1]['subscription'] as Map<String, dynamic>?;
        _welcome.text = s['welcome_message']?.toString() ?? '';
        _supportPhone.text = s['support_phone']?.toString() ?? '';
        _deliveryFee.text = s['delivery_fee_ghs']?.toString() ?? '';
        _openTime.text = s['open_time']?.toString() ?? '';
        _closeTime.text = s['close_time']?.toString() ?? '';
        _lang = s['bot_language']?.toString() == 'tw' ? 'tw' : 'en';
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final session = context.read<Session>();
    try {
      await session.api.patch('/api/business/settings', body: {
        'business_id': session.businessId,
        'welcome_message': _welcome.text.trim().isEmpty ? null : _welcome.text.trim(),
        'support_phone': _supportPhone.text.trim(),
        if (_deliveryFee.text.trim().isNotEmpty)
          'delivery_fee_ghs': double.tryParse(_deliveryFee.text.trim()) ?? 0,
        'open_time': _openTime.text.trim().isEmpty ? null : _openTime.text.trim(),
        'close_time': _closeTime.text.trim().isEmpty ? null : _closeTime.text.trim(),
        'bot_language': _lang,
      });
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Settings saved ✓')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: _error != null
          ? ErrorRetry(message: _error!, onRetry: _load)
          : _settings == null
              ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    _subscriptionCard(),
                    const SizedBox(height: 20),
                    _sectionTitle('Bot'),
                    TextField(
                      controller: _welcome,
                      minLines: 2,
                      maxLines: 4,
                      decoration: const InputDecoration(
                          labelText: 'Welcome message',
                          hintText: 'Shown when a customer first says hi'),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        const Text('Bot language',
                            style: TextStyle(fontWeight: FontWeight.w600)),
                        const Spacer(),
                        SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'en', label: Text('English')),
                            ButtonSegment(value: 'tw', label: Text('Twi')),
                          ],
                          selected: {_lang},
                          onSelectionChanged: (s) => setState(() => _lang = s.first),
                          style: SegmentedButton.styleFrom(
                              selectedBackgroundColor: WabColors.accentSoft,
                              selectedForegroundColor: WabColors.accentInk,
                              visualDensity: VisualDensity.compact),
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),
                    _sectionTitle('Delivery & hours'),
                    TextField(
                      controller: _deliveryFee,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(
                          labelText: 'Flat delivery fee (GH₵)'),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _openTime,
                            decoration: const InputDecoration(
                                labelText: 'Opens', hintText: '08:00'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextField(
                            controller: _closeTime,
                            decoration: const InputDecoration(
                                labelText: 'Closes', hintText: '21:00'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    const Text('Leave blank to stay open around the clock.',
                        style: TextStyle(color: WabColors.muted2, fontSize: 13)),
                    const SizedBox(height: 24),
                    _sectionTitle('Support'),
                    TextField(
                      controller: _supportPhone,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(
                          labelText: 'Support phone',
                          hintText: 'Given out on "Talk to us"'),
                    ),
                    const SizedBox(height: 28),
                    FilledButton(
                      onPressed: _saving ? null : _save,
                      child: _saving
                          ? const SizedBox(
                              width: 22, height: 22,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2.5, color: Colors.white))
                          : const Text('Save settings'),
                    ),
                    const SizedBox(height: 24),
                  ],
                ),
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(t,
            style: const TextStyle(
                fontSize: 16, fontWeight: FontWeight.w800, color: WabColors.ink)),
      );

  Widget _subscriptionCard() {
    final sub = _subscription;
    final session = context.read<Session>();
    final status = (sub?['status'] ?? session.business?['status'] ?? 'trial').toString();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Subscription',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                StatusChip(status),
              ],
            ),
            const SizedBox(height: 8),
            if (sub != null) ...[
              Text(
                  '${sub['plan_display_name'] ?? sub['plan_name'] ?? 'Plan'}'
                  '${sub['price_ghs'] != null ? ' · ${ghs(sub['price_ghs'])}/mo' : ''}',
                  style: const TextStyle(color: WabColors.muted)),
              if (sub['next_billing_date'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('Next billing: ${shortDate(sub['next_billing_date'])}',
                      style: const TextStyle(color: WabColors.muted)),
                ),
            ] else
              const Text('No active subscription on record.',
                  style: TextStyle(color: WabColors.muted)),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () async {
                try {
                  await session.api
                      .post('/api/subscriptions/${session.businessId}/renew');
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                        content: Text(
                            'Renewal started — approve the payment prompt on your phone.')));
                  }
                } on ApiException catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                        content: Text(e.message),
                        backgroundColor: WabColors.danger));
                  }
                }
              },
              child: const Text('Renew now'),
            ),
          ],
        ),
      ),
    );
  }
}
