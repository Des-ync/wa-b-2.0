import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import 'analytics.dart';
import 'broadcasts.dart';
import 'customers.dart';
import 'promos.dart';
import 'settings.dart';

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final name = session.business?['name']?.toString() ?? '';
    final phone = session.business?['whatsapp_number']?.toString() ?? '';

    Widget item(IconData icon, String title, String subtitle, Widget screen) {
      return Card(
        child: ListTile(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          leading: Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
                color: WabColors.accentSoft, borderRadius: BorderRadius.circular(12)),
            child: Icon(icon, color: WabColors.accentInk, size: 22),
          ),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(subtitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: WabColors.muted, fontSize: 13)),
          trailing: const Icon(Icons.chevron_right_rounded, color: WabColors.muted2),
          onTap: () =>
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen)),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: CircleAvatar(
                radius: 24,
                backgroundColor: WabColors.accent,
                child: Text(name.isEmpty ? 'W' : name[0].toUpperCase(),
                    style: const TextStyle(
                        color: Colors.white, fontWeight: FontWeight.w800, fontSize: 20)),
              ),
              title: Text(name,
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
              subtitle: Text(phone, style: const TextStyle(color: WabColors.muted)),
            ),
          ),
          const SizedBox(height: 16),
          item(Icons.insights_rounded, 'Analytics',
              'Revenue trend, top products, busiest hours', const AnalyticsScreen()),
          const SizedBox(height: 10),
          item(Icons.people_alt_rounded, 'Customers',
              'Everyone who has chatted or ordered', const CustomersScreen()),
          const SizedBox(height: 10),
          item(Icons.local_offer_rounded, 'Promo codes',
              'Discount codes for checkout', const PromosScreen()),
          const SizedBox(height: 10),
          item(Icons.campaign_rounded, 'Broadcasts',
              'Message all opted-in customers', const BroadcastsScreen()),
          const SizedBox(height: 10),
          item(Icons.settings_rounded, 'Settings',
              'Bot, delivery, hours, subscription', const SettingsScreen()),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: () async {
              final confirm = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Sign out?'),
                  content: const Text(
                      'You\'ll stop receiving notifications on this phone until you log in again.'),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: const Text('Cancel')),
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text('Sign out',
                            style: TextStyle(color: WabColors.danger))),
                  ],
                ),
              );
              if (confirm == true && context.mounted) {
                await context.read<Session>().logout();
              }
            },
            style: OutlinedButton.styleFrom(foregroundColor: WabColors.danger),
            icon: const Icon(Icons.logout_rounded, size: 20),
            label: const Text('Sign out'),
          ),
        ],
      ),
    );
  }
}
