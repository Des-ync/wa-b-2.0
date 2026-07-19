import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class PromosScreen extends StatefulWidget {
  const PromosScreen({super.key});

  @override
  State<PromosScreen> createState() => _PromosScreenState();
}

class _PromosScreenState extends State<PromosScreen> {
  int _reloadKey = 0;

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api
        .get('/api/promos', query: {'business_id': session.businessId});
    return ((res['promos'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _toggle(Map<String, dynamic> promo) async {
    final session = context.read<Session>();
    try {
      await session.api.patch('/api/promos/${promo['id']}', body: {
        'business_id': session.businessId,
        'active': !(promo['active'] == true),
      });
      setState(() => _reloadKey++);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _createSheet() async {
    final codeCtrl = TextEditingController();
    final valueCtrl = TextEditingController();
    final maxUsesCtrl = TextEditingController();
    String type = 'percent';

    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(
              24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('New promo code',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              const SizedBox(height: 20),
              TextField(
                controller: codeCtrl,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                    labelText: 'Code', hintText: 'e.g. FRIDAY10'),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'percent', label: Text('% off')),
                  ButtonSegment(value: 'fixed', label: Text('GH₵ off')),
                ],
                selected: {type},
                onSelectionChanged: (s) => setSheet(() => type = s.first),
                style: SegmentedButton.styleFrom(
                    selectedBackgroundColor: WabColors.accentSoft,
                    selectedForegroundColor: WabColors.accentInk),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: valueCtrl,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      decoration: InputDecoration(
                          labelText: type == 'percent' ? 'Percent off' : 'Amount (GH₵)'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      controller: maxUsesCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'Max uses', hintText: 'blank = unlimited'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: () async {
                  final session = context.read<Session>();
                  try {
                    await session.api.post('/api/promos', body: {
                      'business_id': session.businessId,
                      'code': codeCtrl.text.trim(),
                      'type': type,
                      'value': double.tryParse(valueCtrl.text.trim()) ?? 0,
                      if (maxUsesCtrl.text.trim().isNotEmpty)
                        'max_uses': int.tryParse(maxUsesCtrl.text.trim()),
                    });
                    if (ctx.mounted) Navigator.pop(ctx, true);
                  } on ApiException catch (e) {
                    if (ctx.mounted) {
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
                          content: Text(e.message),
                          backgroundColor: WabColors.danger));
                    }
                  }
                },
                child: const Text('Create promo'),
              ),
            ],
          ),
        ),
      ),
    );
    if (created == true) setState(() => _reloadKey++);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Promo codes')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _createSheet,
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_rounded),
        label: const Text('New promo'),
      ),
      body: AsyncList<Map<String, dynamic>>(
        key: ValueKey(_reloadKey),
        load: _load,
        emptyTitle: 'No promo codes',
        emptySubtitle:
            'Create a code customers can type at checkout for a discount.',
        emptyIcon: Icons.local_offer_rounded,
        itemBuilder: (ctx, p) {
          final active = p['active'] == true;
          final label = p['type'] == 'percent'
              ? '${p['value']}% off'
              : '${ghs(p['value'])} off';
          return Card(
            child: ListTile(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              title: Text('${p['code']}',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, letterSpacing: 0.5)),
              subtitle: Text(
                  '$label · used ${p['used_count'] ?? 0}'
                  '${p['max_uses'] != null ? '/${p['max_uses']}' : ''}',
                  style: const TextStyle(color: WabColors.muted)),
              trailing: Switch(
                value: active,
                activeThumbColor: WabColors.accent,
                onChanged: (_) => _toggle(p),
              ),
            ),
          );
        },
      ),
    );
  }
}
