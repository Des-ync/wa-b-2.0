import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/onboarding_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'admin_business_detail.dart';

const _stepLabels = {
  'business_profile': 'Business profile',
  'whatsapp_number': 'WhatsApp number',
  'payment_provider': 'Payment settings',
  'first_products': 'First products',
  'test_message': 'Test message',
  'invite_staff': 'Invite staff',
};

/// Merchants who haven't finished onboarding, with the specific steps still
/// missing — lets support proactively chase setup instead of waiting for a
/// "why isn't my bot working" ticket (see admin.routes.js#incomplete-setup).
class AdminIncompleteSetupScreen extends StatefulWidget {
  const AdminIncompleteSetupScreen({super.key});

  @override
  State<AdminIncompleteSetupScreen> createState() =>
      _AdminIncompleteSetupScreenState();
}

class _AdminIncompleteSetupScreenState
    extends State<AdminIncompleteSetupScreen> {
  Future<List<Map<String, dynamic>>> _load() async {
    final res =
        await context.read<Session>().api.getIncompleteSetupBusinesses();
    return ((res['businesses'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Incomplete setup')),
      body: AsyncList<Map<String, dynamic>>(
        load: _load,
        emptyTitle: 'Everyone is fully set up 🎉',
        emptyIcon: Icons.verified_rounded,
        itemBuilder: (ctx, b) {
          final missing = ((b['missing_steps'] as List?) ?? []).cast<String>();
          return Card(
            child: ListTile(
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
              title: Text('${b['name']}',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final key in missing)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                            color: WabColors.warning.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(999)),
                        child: Text(_stepLabels[key] ?? key,
                            style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: WabColors.warning)),
                      ),
                  ],
                ),
              ),
              isThreeLine: missing.length > 2,
              trailing: Text('${b['percent']}%',
                  style: const TextStyle(
                      fontWeight: FontWeight.w800, color: WabColors.muted)),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) =>
                      AdminBusinessDetailScreen(businessId: '${b['id']}'))),
            ),
          );
        },
      ),
    );
  }
}
