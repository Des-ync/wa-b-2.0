import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/auditlog_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

// Mirrors the real `action` strings recordAudit() writes today (grepped
// across business/apikey/promo/inventory/accounting/onboarding.routes.js +
// middleware/auth.js) — anything not listed here still renders via the
// fallback label below, just without a curated icon/phrasing.
const _actionLabels = {
  'settings.update': 'Updated business settings',
  'business.update': 'Business profile updated by WA-B support',
  'business.data_export': 'Exported account data',
  'business.closed': 'Closed the account',
  'onboarding.sample_catalog_loaded': 'Loaded a starter catalog',
  'api_key.issue': 'Created a staff key',
  'api_key.revoke': 'Revoked a staff key',
  'api_key.rotate': 'Rotated a staff key',
  'promo.create': 'Created a promo code',
  'inventory.restock': 'Restocked inventory',
  'inventory.adjust': 'Adjusted stock quantity',
  'accounting.payout_recorded': 'Recorded a payout',
  'accounting.payout_auto_initiated': 'Initiated an automatic payout',
  'auth.suspicious_new_ip': 'Staff key used from a new location',
  'admin.impersonate_start': 'WA-B support accessed your account',
  'admin.impersonate_end': 'WA-B support session ended',
};

const _actionIcons = {
  'settings.update': Icons.tune_rounded,
  'business.update': Icons.support_agent_rounded,
  'business.data_export': Icons.download_rounded,
  'business.closed': Icons.cancel_rounded,
  'onboarding.sample_catalog_loaded': Icons.checklist_rounded,
  'api_key.issue': Icons.vpn_key_rounded,
  'api_key.revoke': Icons.key_off_rounded,
  'api_key.rotate': Icons.autorenew_rounded,
  'promo.create': Icons.local_offer_rounded,
  'inventory.restock': Icons.add_box_rounded,
  'inventory.adjust': Icons.inventory_2_rounded,
  'accounting.payout_recorded': Icons.account_balance_wallet_rounded,
  'accounting.payout_auto_initiated': Icons.account_balance_wallet_rounded,
  'auth.suspicious_new_ip': Icons.warning_amber_rounded,
  'admin.impersonate_start': Icons.support_agent_rounded,
  'admin.impersonate_end': Icons.support_agent_rounded,
};

String _labelFor(String action) =>
    _actionLabels[action] ?? action.replaceAll('_', ' ').replaceAll('.', ' — ');

String _actorFor(Map<String, dynamic> e) {
  if (e['actor_type'] == 'admin') return 'WA-B support';
  if (e['actor_type'] == 'system') return 'System';
  final keyName = e['actor_key_name']?.toString();
  if (keyName != null && keyName.isNotEmpty) return keyName;
  return 'Owner';
}

String? _detailFor(Map<String, dynamic> e) {
  final detail = e['detail'];
  if (detail is! Map || detail.isEmpty) return null;
  switch (e['action']) {
    case 'settings.update':
    case 'business.update':
      final fields = (detail['fields'] as List?)?.join(', ');
      return fields == null || fields.isEmpty ? null : 'Fields: $fields';
    case 'business.closed':
      return detail['reason'] != null ? 'Reason: ${detail['reason']}' : null;
    case 'api_key.issue':
    case 'api_key.revoke':
    case 'api_key.rotate':
      return detail['name'] != null ? 'Key: ${detail['name']}' : null;
    case 'promo.create':
      return detail['code'] != null ? 'Code: ${detail['code']}' : null;
    case 'inventory.restock':
      return detail['quantity'] != null ? '+${detail['quantity']} units' : null;
    case 'accounting.payout_recorded':
    case 'accounting.payout_auto_initiated':
      return detail['amount_ghs'] != null ? ghs(detail['amount_ghs']) : null;
    case 'auth.suspicious_new_ip':
      return detail['new_ip'] != null ? 'From ${detail['new_ip']}' : null;
    default:
      return null;
  }
}

class AuditLogScreen extends StatefulWidget {
  const AuditLogScreen({super.key});

  @override
  State<AuditLogScreen> createState() => _AuditLogScreenState();
}

class _AuditLogScreenState extends State<AuditLogScreen> {
  Future<List<Map<String, dynamic>>> _load() async {
    final session = context.read<Session>();
    final res = await session.api.getAuditLog(session.businessId!);
    return ((res['entries'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Activity log')),
      body: AsyncList<Map<String, dynamic>>(
        load: _load,
        emptyTitle: 'No activity yet',
        emptySubtitle:
            'Settings changes, staff key actions, and other account-level\n'
            'events will show up here.',
        emptyIcon: Icons.history_rounded,
        itemBuilder: (ctx, e) {
          final action = '${e['action']}';
          final detail = _detailFor(e);
          return Card(
            child: ListTile(
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
              leading: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                    color: WabColors.accentSoft,
                    borderRadius: BorderRadius.circular(12)),
                child: Icon(_actionIcons[action] ?? Icons.bolt_rounded,
                    color: WabColors.accentInk, size: 20),
              ),
              title: Text(_labelFor(action),
                  style: const TextStyle(
                      fontWeight: FontWeight.w700, fontSize: 14)),
              subtitle: Text(
                  [_actorFor(e), if (detail != null) detail].join(' · '),
                  style: const TextStyle(color: WabColors.muted)),
              trailing: Text(timeAgo(e['created_at']),
                  style: const TextStyle(color: WabColors.muted, fontSize: 12)),
            ),
          );
        },
      ),
    );
  }
}
