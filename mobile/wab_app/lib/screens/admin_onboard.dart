import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Admin-initiated onboarding: create a new business tenant on the spot —
/// at a demo, on the road, wherever. Sends the owner a WhatsApp welcome.
class AdminOnboardScreen extends StatefulWidget {
  const AdminOnboardScreen({super.key});

  @override
  State<AdminOnboardScreen> createState() => _AdminOnboardScreenState();
}

class _AdminOnboardScreenState extends State<AdminOnboardScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _owner = TextEditingController();
  final _phone = TextEditingController();
  final _waPhoneId = TextEditingController();

  String _industry = 'retail';
  int _trialDays = 14;
  bool _sendWelcome = true;
  bool _saving = false;

  static const _industries = [
    'retail', 'food', 'fashion', 'beauty', 'electronics', 'pharmacy', 'services', 'other'
  ];

  @override
  void dispose() {
    _name.dispose();
    _owner.dispose();
    _phone.dispose();
    _waPhoneId.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    try {
      final res = await context.read<Session>().api.post(
        '/api/admin/businesses',
        body: {
          'name': _name.text.trim(),
          'owner_name': _owner.text.trim(),
          'whatsapp_number': _phone.text.trim(),
          if (_waPhoneId.text.trim().isNotEmpty)
            'wa_phone_number_id': _waPhoneId.text.trim(),
          'industry': _industry,
          'trial_days': _trialDays,
          'send_welcome': _sendWelcome,
        },
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${res['business']?['name'] ?? 'Business'} onboarded 🎉'),
        backgroundColor: WabColors.accentInk,
      ));
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('$e'),
        backgroundColor: WabColors.danger,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Onboard a business')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const KenteStrip(borderRadius: BorderRadius.all(Radius.circular(4))),
            const SizedBox(height: 18),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                  labelText: 'Business name *', hintText: 'Ama\'s Kitchen'),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Business name is required' : null,
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _owner,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                  labelText: 'Owner name', hintText: 'Ama Mensah'),
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'WhatsApp number *', hintText: '024 123 4567'),
              validator: (v) {
                final digits = (v ?? '').replaceAll(RegExp(r'[^\d]'), '');
                if (digits.length < 9) return 'Enter a valid phone number';
                return null;
              },
            ),
            const SizedBox(height: 14),
            DropdownButtonFormField<String>(
              initialValue: _industry,
              decoration: const InputDecoration(labelText: 'Industry'),
              items: _industries
                  .map((i) => DropdownMenuItem(value: i, child: Text(i)))
                  .toList(),
              onChanged: (v) => setState(() => _industry = v ?? 'retail'),
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _waPhoneId,
              decoration: const InputDecoration(
                labelText: 'Meta phone number ID (optional)',
                helperText: 'Only if they have their own WhatsApp Cloud API number',
              ),
            ),
            const SizedBox(height: 18),
            Row(
              children: [
                const Text('Free trial',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                const Spacer(),
                SegmentedButton<int>(
                  segments: const [
                    ButtonSegment(value: 7, label: Text('7d')),
                    ButtonSegment(value: 14, label: Text('14d')),
                    ButtonSegment(value: 30, label: Text('30d')),
                  ],
                  selected: {_trialDays},
                  onSelectionChanged: (s) => setState(() => _trialDays = s.first),
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Send WhatsApp welcome message'),
              subtitle: const Text('Akwaaba text with their trial details',
                  style: TextStyle(color: WabColors.muted, fontSize: 13)),
              value: _sendWelcome,
              activeThumbColor: WabColors.accent,
              onChanged: (v) => setState(() => _sendWelcome = v),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _saving ? null : _submit,
              style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16)),
              child: _saving
                  ? const SizedBox(
                      width: 20, height: 20,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : const Text('Create business & start trial'),
            ),
            const SizedBox(height: 30),
          ],
        ),
      ),
    );
  }
}
