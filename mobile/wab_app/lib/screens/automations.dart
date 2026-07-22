import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/automations_api.dart';
import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

const _configField = {
  'reorder_reminder': ('delay_days', 'Days after last order'),
  'win_back': ('inactive_days', 'Days inactive'),
  'post_purchase_review': ('delay_hours', 'Hours after delivery'),
  'delivery_feedback': ('delay_hours', 'Hours after delivery'),
};

const _icons = {
  'reorder_reminder': Icons.replay_rounded,
  'win_back': Icons.favorite_rounded,
  'post_purchase_review': Icons.star_rounded,
  'delivery_feedback': Icons.local_shipping_rounded,
};

/// Toggle list for the lifecycle-automation templates (src/services/
/// automations.js). Abandoned-cart reminders and birthday offers already
/// have their own settings elsewhere (Settings > Bot, Settings > Loyalty)
/// and aren't duplicated here.
class AutomationsScreen extends StatefulWidget {
  const AutomationsScreen({super.key});

  @override
  State<AutomationsScreen> createState() => _AutomationsScreenState();
}

class _AutomationsScreenState extends State<AutomationsScreen> {
  List<Map<String, dynamic>> _automations = [];
  String? _error;
  bool _loading = true;
  String? _savingKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _automations.isEmpty;
      _error = null;
    });
    try {
      final session = context.read<Session>();
      final res = await session.api.getAutomations(session.businessId!);
      if (!mounted) return;
      setState(() {
        _automations = ((res['automations'] as List?) ?? []).cast<Map<String, dynamic>>();
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

  Future<void> _toggle(Map<String, dynamic> a, bool value) async {
    setState(() => _savingKey = a['key']);
    try {
      final session = context.read<Session>();
      await session.api.updateAutomation(session.businessId!, a['key'], enabled: value);
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _savingKey = null);
    }
  }

  Future<void> _editConfig(Map<String, dynamic> a) async {
    final field = _configField[a['key']];
    if (field == null) return;
    final (configKey, label) = field;
    final ctrl = TextEditingController(text: '${a['config']?[configKey] ?? ''}');
    final value = await showDialog<int>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(label),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, int.tryParse(ctrl.text.trim())),
              child: const Text('Save')),
        ],
      ),
    );
    if (value == null || value <= 0 || !mounted) return;
    setState(() => _savingKey = a['key']);
    try {
      final session = context.read<Session>();
      await session.api
          .updateAutomation(session.businessId!, a['key'], config: {configKey: value});
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _savingKey = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Automations')),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      const Text(
                          'Automatic WhatsApp messages that keep customers coming back — no manual work once turned on.',
                          style: TextStyle(color: WabColors.muted, height: 1.4)),
                      const SizedBox(height: 16),
                      for (final a in _automations) _automationCard(a),
                    ],
                  ),
                ),
    );
  }

  Widget _automationCard(Map<String, dynamic> a) {
    final key = a['key'] as String;
    final enabled = a['enabled'] == true;
    final field = _configField[key];
    final busy = _savingKey == key;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(_icons[key] ?? Icons.bolt_rounded, color: WabColors.accentInk),
                const SizedBox(width: 10),
                Expanded(
                  child: Text('${a['label']}',
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                ),
                busy
                    ? const SizedBox(
                        width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : Switch(
                        value: enabled,
                        activeThumbColor: WabColors.accent,
                        onChanged: (v) => _toggle(a, v),
                      ),
              ],
            ),
            const SizedBox(height: 6),
            Text('${a['description']}',
                style: const TextStyle(color: WabColors.muted, fontSize: 13, height: 1.35)),
            if (field != null) ...[
              const SizedBox(height: 10),
              GestureDetector(
                onTap: busy ? null : () => _editConfig(a),
                child: Row(
                  children: [
                    Text('${field.$2}: ${a['config']?[field.$1]}',
                        style: const TextStyle(
                            color: WabColors.accentInk, fontWeight: FontWeight.w600, fontSize: 13)),
                    const SizedBox(width: 4),
                    const Icon(Icons.edit_rounded, size: 14, color: WabColors.accentInk),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
