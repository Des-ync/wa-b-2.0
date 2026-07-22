import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/business_api.dart';
import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

const _industries = [
  'food',
  'retail',
  'fashion',
  'pharmacy',
  'grocery',
  'electronics',
  'beauty',
  'general'
];
const _momoNetworks = ['mtn', 'vodafone', 'airteltigo'];

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
  final _name = TextEditingController();
  final _ownerName = TextEditingController();
  final _slug = TextEditingController();
  final _logoUrl = TextEditingController();
  final _bannerUrl = TextEditingController();
  final _payoutMomoNumber = TextEditingController();
  final _cartNudgeDelay = TextEditingController();
  String _lang = 'en';
  String _industry = 'general';
  String? _payoutMomoNetwork;
  bool _cartNudgeEnabled = false;
  String? _nameError;
  String? _deliveryFeeError;
  String? _cartNudgeDelayError;
  String? _openTimeError;
  String? _closeTimeError;

  static final _timeRe = RegExp(r'^([01]?\d|2[0-3]):[0-5]\d$');

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [
      _welcome,
      _supportPhone,
      _deliveryFee,
      _openTime,
      _closeTime,
      _name,
      _ownerName,
      _slug,
      _logoUrl,
      _bannerUrl,
      _payoutMomoNumber,
      _cartNudgeDelay,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    final session = context.read<Session>();
    try {
      final results = await Future.wait([
        session.api.getBusinessSettings(session.businessId!),
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
        _name.text = s['name']?.toString() ?? '';
        _ownerName.text = s['owner_name']?.toString() ?? '';
        _slug.text = s['slug']?.toString() ?? '';
        _logoUrl.text = s['logo_url']?.toString() ?? '';
        _bannerUrl.text = s['banner_url']?.toString() ?? '';
        _industry =
            _industries.contains(s['industry']) ? s['industry'] : 'general';
        _payoutMomoNumber.text = s['payout_momo_number']?.toString() ?? '';
        _payoutMomoNetwork = _momoNetworks.contains(s['payout_momo_network'])
            ? s['payout_momo_network']
            : null;
        _cartNudgeEnabled = s['cart_nudge_enabled'] == true;
        _cartNudgeDelay.text =
            s['cart_nudge_delay_minutes']?.toString() ?? '60';
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _save() async {
    final nameError =
        _name.text.trim().isEmpty ? 'Business name is required' : null;

    final feeRaw = _deliveryFee.text.trim();
    final fee = feeRaw.isEmpty ? null : double.tryParse(feeRaw);
    final deliveryFeeError = feeRaw.isNotEmpty && (fee == null || fee < 0)
        ? 'Enter a valid amount'
        : null;

    final delayRaw = _cartNudgeDelay.text.trim();
    final delay = delayRaw.isEmpty ? null : int.tryParse(delayRaw);
    final cartNudgeDelayError = _cartNudgeEnabled &&
            delayRaw.isNotEmpty &&
            (delay == null || delay <= 0)
        ? 'Enter a whole number of minutes'
        : null;

    final openRaw = _openTime.text.trim();
    final openTimeError = openRaw.isNotEmpty && !_timeRe.hasMatch(openRaw)
        ? 'Use 24-hour HH:MM, e.g. 08:00'
        : null;
    final closeRaw = _closeTime.text.trim();
    final closeTimeError = closeRaw.isNotEmpty && !_timeRe.hasMatch(closeRaw)
        ? 'Use 24-hour HH:MM, e.g. 21:00'
        : null;

    if ([
      nameError,
      deliveryFeeError,
      cartNudgeDelayError,
      openTimeError,
      closeTimeError
    ].any((e) => e != null)) {
      setState(() {
        _nameError = nameError;
        _deliveryFeeError = deliveryFeeError;
        _cartNudgeDelayError = cartNudgeDelayError;
        _openTimeError = openTimeError;
        _closeTimeError = closeTimeError;
      });
      return;
    }

    setState(() => _saving = true);
    final session = context.read<Session>();
    try {
      await session.api.updateBusinessSettings(session.businessId!, {
        'name': _name.text.trim(),
        'owner_name': _ownerName.text.trim(),
        'industry': _industry,
        if (_slug.text.trim().isNotEmpty) 'slug': _slug.text.trim(),
        'logo_url': _logoUrl.text.trim().isEmpty ? null : _logoUrl.text.trim(),
        'banner_url':
            _bannerUrl.text.trim().isEmpty ? null : _bannerUrl.text.trim(),
        'payout_momo_number': _payoutMomoNumber.text.trim(),
        if (_payoutMomoNetwork != null)
          'payout_momo_network': _payoutMomoNetwork,
        'welcome_message':
            _welcome.text.trim().isEmpty ? null : _welcome.text.trim(),
        'support_phone': _supportPhone.text.trim(),
        if (fee != null) 'delivery_fee_ghs': fee,
        'open_time': openRaw.isEmpty ? null : openRaw,
        'close_time': closeRaw.isEmpty ? null : closeRaw,
        'bot_language': _lang,
        'cart_nudge_enabled': _cartNudgeEnabled,
        if (delay != null) 'cart_nudge_delay_minutes': delay,
      });
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Settings saved ✓')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
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
              ? const Center(
                  child: CircularProgressIndicator(color: WabColors.accent))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    _subscriptionCard(),
                    const SizedBox(height: 20),
                    _sectionTitle('Business profile'),
                    TextField(
                        controller: _name,
                        onChanged: (_) {
                          if (_nameError != null) {
                            setState(() => _nameError = null);
                          }
                        },
                        decoration: InputDecoration(
                            labelText: 'Business name', errorText: _nameError)),
                    const SizedBox(height: 12),
                    TextField(
                        controller: _ownerName,
                        decoration:
                            const InputDecoration(labelText: 'Owner name')),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _industry,
                      decoration: const InputDecoration(labelText: 'Industry'),
                      items: [
                        for (final i in _industries)
                          DropdownMenuItem(
                              value: i, child: Text(_industryLabel(i))),
                      ],
                      onChanged: (v) =>
                          setState(() => _industry = v ?? _industry),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _slug,
                      decoration: const InputDecoration(
                          labelText: 'Storefront link',
                          prefixText: 'wa-b.app/',
                          hintText: 'your-shop-name'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                        controller: _logoUrl,
                        decoration: const InputDecoration(
                            labelText: 'Logo URL (optional)',
                            hintText: 'https://…')),
                    const SizedBox(height: 12),
                    TextField(
                        controller: _bannerUrl,
                        decoration: const InputDecoration(
                            labelText: 'Banner URL (optional)',
                            hintText: 'https://…')),
                    const SizedBox(height: 24),
                    _sectionTitle('Payment'),
                    TextField(
                      controller: _payoutMomoNumber,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(
                          labelText: 'Payout MoMo number',
                          hintText: 'Where your settlements land'),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _payoutMomoNetwork,
                      decoration: const InputDecoration(labelText: 'Network'),
                      items: [
                        for (final n in _momoNetworks)
                          DropdownMenuItem(
                              value: n, child: Text(n.toUpperCase())),
                      ],
                      onChanged: (v) => setState(() => _payoutMomoNetwork = v),
                    ),
                    const SizedBox(height: 24),
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
                          onSelectionChanged: (s) =>
                              setState(() => _lang = s.first),
                          style: SegmentedButton.styleFrom(
                              selectedBackgroundColor: WabColors.accentSoft,
                              selectedForegroundColor: WabColors.accentInk,
                              visualDensity: VisualDensity.compact),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    SwitchListTile(
                      value: _cartNudgeEnabled,
                      onChanged: (v) => setState(() => _cartNudgeEnabled = v),
                      title: const Text('Abandoned cart reminders',
                          style: TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: const Text(
                          'Nudge a customer who left items in their cart',
                          style: TextStyle(fontSize: 12)),
                      activeThumbColor: WabColors.accent,
                      contentPadding: EdgeInsets.zero,
                    ),
                    if (_cartNudgeEnabled)
                      TextField(
                        controller: _cartNudgeDelay,
                        keyboardType: TextInputType.number,
                        onChanged: (_) {
                          if (_cartNudgeDelayError != null) {
                            setState(() => _cartNudgeDelayError = null);
                          }
                        },
                        decoration: InputDecoration(
                            labelText: 'Wait before nudging (minutes)',
                            hintText: '60',
                            errorText: _cartNudgeDelayError),
                      ),
                    const SizedBox(height: 24),
                    _sectionTitle('Delivery & hours'),
                    TextField(
                      controller: _deliveryFee,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) {
                        if (_deliveryFeeError != null) {
                          setState(() => _deliveryFeeError = null);
                        }
                      },
                      decoration: InputDecoration(
                          labelText: 'Flat delivery fee (GH₵)',
                          errorText: _deliveryFeeError),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _openTime,
                            onChanged: (_) {
                              if (_openTimeError != null) {
                                setState(() => _openTimeError = null);
                              }
                            },
                            decoration: InputDecoration(
                                labelText: 'Opens',
                                hintText: '08:00',
                                errorText: _openTimeError),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextField(
                            controller: _closeTime,
                            onChanged: (_) {
                              if (_closeTimeError != null) {
                                setState(() => _closeTimeError = null);
                              }
                            },
                            decoration: InputDecoration(
                                labelText: 'Closes',
                                hintText: '21:00',
                                errorText: _closeTimeError),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    const Text('Leave blank to stay open around the clock.',
                        style:
                            TextStyle(color: WabColors.muted2, fontSize: 13)),
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
                              width: 22,
                              height: 22,
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
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: WabColors.ink)),
      );

  // Matches onboarding.routes.js#SAMPLE_CATALOGS' keys — friendlier labels
  // for the same underlying values, since a starter catalog is picked off
  // this exact string.
  String _industryLabel(String key) => switch (key) {
        'food' => 'Food & drinks',
        'retail' => 'Retail',
        'fashion' => 'Fashion',
        'pharmacy' => 'Pharmacy',
        'grocery' => 'Grocery',
        'electronics' => 'Electronics',
        'beauty' => 'Beauty',
        _ => 'General',
      };

  Widget _subscriptionCard() {
    final sub = _subscription;
    final session = context.read<Session>();
    final status =
        (sub?['status'] ?? session.business?['status'] ?? 'trial').toString();
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
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
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
                  child: Text(
                      'Next billing: ${shortDate(sub['next_billing_date'])}',
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
