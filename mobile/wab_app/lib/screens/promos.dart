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
  String _query = '';
  final _searchCtrl = TextEditingController();

  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api
        .get('/api/promos', query: {'business_id': session.businessId});
    return ((res['promos'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  List<Map<String, dynamic>> _filter(List<Map<String, dynamic>> items) {
    if (_query.isEmpty) return items;
    final q = _query.toLowerCase();
    return items
        .where((p) => '${p['code']}'.toLowerCase().contains(q))
        .toList();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
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
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Semantics(liveRegion: true, child: Text(e.message)),
            backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _createSheet() async {
    final codeCtrl = TextEditingController();
    final valueCtrl = TextEditingController();
    final maxUsesCtrl = TextEditingController();
    String type = 'percent';
    String? codeError;
    String? valueError;

    String? validateValue(String raw, String forType) {
      final v = double.tryParse(raw.trim());
      if (v == null || v <= 0) return 'Enter an amount greater than 0';
      if (forType == 'percent' && v > 100) {
        return "Percent off can't exceed 100";
      }
      return null;
    }

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
                onChanged: (_) {
                  if (codeError != null) setSheet(() => codeError = null);
                },
                decoration: InputDecoration(
                    labelText: 'Code',
                    hintText: 'e.g. FRIDAY10',
                    errorText: codeError),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'percent', label: Text('% off')),
                  ButtonSegment(value: 'fixed', label: Text('GH₵ off')),
                ],
                selected: {type},
                onSelectionChanged: (s) => setSheet(() {
                  type = s.first;
                  if (valueCtrl.text.trim().isNotEmpty) {
                    valueError = validateValue(valueCtrl.text, type);
                  }
                }),
                style: SegmentedButton.styleFrom(
                    selectedBackgroundColor: WabColors.accentSoft,
                    selectedForegroundColor: WabColors.accentInk),
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: TextField(
                      controller: valueCtrl,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) {
                        if (valueError != null) {
                          setSheet(() => valueError = null);
                        }
                      },
                      decoration: InputDecoration(
                          labelText: type == 'percent'
                              ? 'Percent off'
                              : 'Amount (GH₵)',
                          errorText: valueError),
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
                  final code = codeCtrl.text.trim();
                  final vErr = validateValue(valueCtrl.text, type);
                  if (code.isEmpty || vErr != null) {
                    setSheet(() {
                      codeError = code.isEmpty ? 'Enter a code' : null;
                      valueError = vErr;
                    });
                    return;
                  }
                  final session = context.read<Session>();
                  try {
                    await session.api.post('/api/promos', body: {
                      'business_id': session.businessId,
                      'code': code,
                      'type': type,
                      'value': double.parse(valueCtrl.text.trim()),
                      if (maxUsesCtrl.text.trim().isNotEmpty)
                        'max_uses': int.tryParse(maxUsesCtrl.text.trim()),
                    });
                    if (ctx.mounted) Navigator.pop(ctx, true);
                  } on ApiException catch (e) {
                    if (ctx.mounted) {
                      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
                          content: Semantics(
                              liveRegion: true, child: Text(e.message)),
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
    codeCtrl.dispose();
    valueCtrl.dispose();
    maxUsesCtrl.dispose();
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
      body: Column(
        children: [
          SearchField(
            controller: _searchCtrl,
            hint: 'Search code',
            onChanged: (v) => setState(() => _query = v),
          ),
          Expanded(
            child: AsyncList<Map<String, dynamic>>(
              key: ValueKey(_reloadKey),
              load: _load,
              transform: _filter,
              emptyFilteredTitle: 'No promo codes match "$_query"',
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
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
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
          ),
        ],
      ),
    );
  }
}
