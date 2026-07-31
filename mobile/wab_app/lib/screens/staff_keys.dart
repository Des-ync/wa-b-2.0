import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../api/staff_api.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Who has access to this shop, and how to take it away.
///
/// `/api/keys` had no client at all: keys could only be issued by calling the
/// API directly, and nothing could list or revoke them. A shop owner had no
/// way to answer "who still has access" — the question that matters after
/// someone leaves.
///
/// The secret is returned exactly once, at creation or rotation, and stored
/// hashed. Everything about the reveal below is built around that being
/// genuinely irreversible.
class StaffKeysScreen extends StatefulWidget {
  const StaffKeysScreen({super.key});

  @override
  State<StaffKeysScreen> createState() => _StaffKeysScreenState();
}

class _StaffKeysScreenState extends State<StaffKeysScreen> {
  List<dynamic> _keys = [];
  String? _error;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = context.read<Session>();
    final bid = session.businessId;
    if (bid == null) return;
    setState(() {
      _loading = _keys.isEmpty;
      _error = null;
    });
    try {
      final res = await session.api.getStaffKeys(bid);
      if (!mounted) return;
      setState(() {
        _keys = (res['keys'] as List?) ?? [];
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

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: error ? WabColors.danger : WabColors.accentInk,
    ));
  }

  /// The one and only time this secret exists in readable form.
  ///
  /// Deliberately not dismissible by tapping away, and the close button says
  /// what has happened rather than "OK" — because after this dialog the value
  /// is unrecoverable and the only remedy is rotating the key.
  Future<void> _revealSecret(String secret, {required String name}) async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Copy this key now'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('This is the only time it will be shown. '
                'We store it scrambled, so we cannot show it to you again — '
                'if it is lost you will have to rotate the key for $name.',
                style: const TextStyle(color: WabColors.muted, height: 1.4)),
            const SizedBox(height: 16),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: WabColors.bg2,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: WabColors.line),
              ),
              child: SelectableText(secret,
                  style: const TextStyle(
                      fontFamily: 'monospace', fontSize: 13, height: 1.4)),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: secret));
                  _toast('Key copied.');
                },
                icon: const Icon(Icons.copy_rounded, size: 18),
                label: const Text('Copy key'),
              ),
            ),
          ],
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text("I've saved it"),
          ),
        ],
      ),
    );
  }

  Future<void> _createKey() async {
    final nameCtrl = TextEditingController();
    String role = 'support';

    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(
            24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: StatefulBuilder(
          // Scrollable: four role options with their explanations plus a
          // field and a button is taller than a small phone, and taller again
          // with the keyboard up. Without this the Create button clips off
          // the bottom on exactly the cheap handsets this app targets.
          builder: (ctx, setSheet) => SingleChildScrollView(
            child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Give someone access',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              const Text('Name it after the person, so you know whose it is.',
                  style: TextStyle(color: WabColors.muted, fontSize: 13)),
              const SizedBox(height: 16),
              TextField(
                controller: nameCtrl,
                autofocus: true,
                decoration: const InputDecoration(
                    labelText: 'Who is it for', hintText: 'e.g. Ama — shop floor'),
              ),
              const SizedBox(height: 16),
              const Text('WHAT THEY CAN DO',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: WabColors.muted)),
              const SizedBox(height: 8),
              // The capability summary is shown at the point of granting
              // because "manager" and "support" mean nothing on their own.
              for (final entry in staffRoles.entries)
                if (entry.key != 'owner')
                  RadioListTile<String>(
                    value: entry.key,
                    // ignore: deprecated_member_use
                    groupValue: role,
                    // ignore: deprecated_member_use
                    onChanged: (v) => setSheet(() => role = v ?? role),
                    contentPadding: EdgeInsets.zero,
                    title: Text(entry.value.label,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(entry.value.summary,
                        style: const TextStyle(
                            color: WabColors.muted, fontSize: 12, height: 1.35)),
                  ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Create key'),
                ),
              ),
            ],
          ),
          ),
        ),
      ),
    );
    if (saved != true || !mounted) return;

    final name = nameCtrl.text.trim();
    if (name.isEmpty) {
      _toast('Give the key a name so you know whose it is.', error: true);
      return;
    }
    final session = context.read<Session>();
    setState(() => _busy = true);
    try {
      final res = await session.api
          .createStaffKey(session.businessId!, name: name, role: role);
      if (!mounted) return;
      final secret = res['key']?['plaintext']?.toString();
      if (secret != null && secret.isNotEmpty) {
        await _revealSecret(secret, name: name);
      }
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revoke(Map<String, dynamic> key) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Revoke ${key['name']}?'),
        content: const Text(
            'This key stops working straight away and cannot be turned back on. '
            'To give access again you would create a new key.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: WabColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Revoke'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() => _busy = true);
    try {
      await context.read<Session>().api.revokeStaffKey('${key['id']}');
      if (!mounted) return;
      _toast('${key['name']} revoked.');
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rotate(Map<String, dynamic> key) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Rotate ${key['name']}?'),
        content: const Text(
            'You get a fresh key with the same access, and the old one stops '
            'working immediately. Do this if the key may have been seen by '
            'someone it should not have been.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Rotate')),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() => _busy = true);
    try {
      final res = await context.read<Session>().api.rotateStaffKey('${key['id']}');
      if (!mounted) return;
      final secret = res['key']?['plaintext']?.toString();
      if (secret != null && secret.isNotEmpty) {
        await _revealSecret(secret, name: '${key['name']}');
      }
      await _load();
    } catch (e) {
      if (mounted) _toast('$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = _keys.where((k) => k['revoked_at'] == null).toList();
    final revoked = _keys.where((k) => k['revoked_at'] != null).toList();

    return Scaffold(
      appBar: AppBar(title: const Text('Staff access')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _busy ? null : _createKey,
        icon: const Icon(Icons.person_add_alt_rounded),
        label: const Text('Give access'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  color: WabColors.accent,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                    children: [
                      if (active.isEmpty && revoked.isEmpty)
                        const Padding(
                          padding: EdgeInsets.only(top: 48),
                          child: EmptyState(
                              icon: Icons.key_rounded,
                              title: 'Only you have access',
                              subtitle:
                                  'Give a manager or an assistant their own key so you can take it back later without changing yours.'),
                        ),
                      if (active.isNotEmpty) ...[
                        const Text('Active',
                            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 8),
                        for (final k in active) _keyCard(k as Map<String, dynamic>),
                      ],
                      if (revoked.isNotEmpty) ...[
                        const SizedBox(height: 24),
                        const Text('Revoked',
                            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 4),
                        const Text('Kept as a record of what access existed.',
                            style: TextStyle(color: WabColors.muted, fontSize: 13)),
                        const SizedBox(height: 8),
                        for (final k in revoked) _keyCard(k as Map<String, dynamic>),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _keyCard(Map<String, dynamic> k) {
    final isRevoked = k['revoked_at'] != null;
    final role = '${k['role'] ?? ''}';
    final lastUsed = k['last_used_at'];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${k['name'] ?? 'Unnamed key'}',
                      style: TextStyle(
                          fontWeight: FontWeight.w800,
                          decoration: isRevoked ? TextDecoration.lineThrough : null,
                          color: isRevoked ? WabColors.muted : WabColors.ink)),
                ),
                StatusChip(isRevoked ? 'expired' : 'active',
                    label: isRevoked ? 'Revoked' : (staffRoles[role]?.label ?? role)),
              ],
            ),
            const SizedBox(height: 6),
            Text(
                // "Never used" is the interesting case: a key nobody has
                // picked up is one that can be revoked with no disruption.
                lastUsed == null
                    ? 'Never used'
                    : 'Last used ${timeAgo(lastUsed)}'
                        '${k['last_used_ip'] != null ? ' · ${k['last_used_ip']}' : ''}',
                style: const TextStyle(color: WabColors.muted, fontSize: 13)),
            if (!isRevoked && staffRoles[role] != null) ...[
              const SizedBox(height: 6),
              Text(staffRoles[role]!.summary,
                  style: const TextStyle(
                      color: WabColors.muted2, fontSize: 12, height: 1.35)),
            ],
            if (!isRevoked) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  OutlinedButton(
                    onPressed: _busy ? null : () => _rotate(k),
                    child: const Text('Rotate'),
                  ),
                  const SizedBox(width: 10),
                  OutlinedButton(
                    onPressed: _busy ? null : () => _revoke(k),
                    style: OutlinedButton.styleFrom(
                        foregroundColor: WabColors.danger,
                        side: const BorderSide(color: WabColors.danger)),
                    child: const Text('Revoke'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
