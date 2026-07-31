import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../api/account_api.dart';
import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';

/// Your data and your account: take a copy out, close the shop, or ask for
/// everything to be erased.
///
/// The three are deliberately on one screen and in that order, because they
/// are the same decision at different depths — and because someone who is
/// closing an account should be offered their copy of the data BEFORE they
/// give up access to it, not after.
///
/// The wording here is held to one rule: closing is not deleting. The server
/// keeps every order, customer and message when an account closes, so the
/// screen says exactly that rather than letting "close" imply erasure. Real
/// deletion is a separate, identity-verified request, and it is named here
/// instead of being hidden in a support email.
class AccountDataScreen extends StatefulWidget {
  const AccountDataScreen({super.key});

  @override
  State<AccountDataScreen> createState() => _AccountDataScreenState();
}

class _AccountDataScreenState extends State<AccountDataScreen> {
  bool _exporting = false;
  bool _closing = false;

  void _toast(String message, {bool bad = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
      backgroundColor: bad ? WabColors.danger : WabColors.accentInk,
    ));
  }

  /// Downloads the bundle and hands it straight to the system share sheet.
  ///
  /// The share sheet rather than a save-to-disk button because on the phones
  /// this app is built for, "somewhere in Downloads" is a file the merchant
  /// will never find again — whereas sending it to themselves on WhatsApp, or
  /// into Drive, puts it somewhere they already know how to get back to.
  Future<void> _export() async {
    final session = context.read<Session>();
    final businessId = session.businessId;
    if (businessId == null) return;

    setState(() => _exporting = true);
    try {
      final body = await session.api.exportBusinessData(businessId);
      final bytes = utf8.encode(body);
      final stamp = DateTime.now().toIso8601String().split('T').first;
      final name = 'wa-b-export-$stamp.json';

      if (!mounted) return;
      await SharePlus.instance.share(ShareParams(
        files: [
          XFile.fromData(bytes, mimeType: 'application/json', name: name)
        ],
        fileNameOverrides: [name],
        subject: 'My WA-B data export',
      ));
      _toast('Your data is ready — ${_size(bytes.length)}.');
    } on ApiException catch (e) {
      _toast(e.message, bad: true);
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  static String _size(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  Future<void> _close() async {
    final session = context.read<Session>();
    final businessId = session.businessId;
    if (businessId == null) return;

    final reason = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _CloseSheet(),
    );
    if (reason == null || !mounted) return;

    setState(() => _closing = true);
    try {
      await session.api.closeBusiness(businessId, reason: reason);
      if (!mounted) return;
      // Signed out rather than left on a live-looking dashboard: the bot and
      // storefront are down from this moment, and every screen behind this
      // one would be describing a shop that is no longer trading.
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Account closed'),
          content: const Text(
              'Your storefront and bot have stopped. Your orders, customers '
              'and messages are still kept.\n\n'
              'To reopen, contact support — you have not lost anything.'),
          actions: [
            FilledButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Sign out')),
          ],
        ),
      );
      if (mounted) await context.read<Session>().logout();
    } on ApiException catch (e) {
      _toast(e.message, bad: true);
    } finally {
      if (mounted) setState(() => _closing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final closedAt = session.business?['closed_at'];
    final isClosed = closedAt != null && '$closedAt'.isNotEmpty;

    return Scaffold(
      appBar: AppBar(title: const Text('Your data & account')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (isClosed) ...[
            const _Banner(
              icon: Icons.pause_circle_filled_rounded,
              tone: WabColors.warning,
              title: 'This account is closed',
              body: 'Your storefront and bot are switched off. Your records '
                  'are still here, and you can still download them below.',
            ),
            const SizedBox(height: 16),
          ],

          // ─── Download ───────────────────────────────────────────────────
          _Section(
            icon: Icons.download_rounded,
            title: 'Download your data',
            body: 'One file with everything this account holds: your business '
                'details, products, customers, every order, and your message '
                'history.',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const _Note(
                    'This is your full history, so it can be a large file. '
                    'Use Wi-Fi if you can.'),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _exporting ? null : _export,
                  icon: _exporting
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.download_rounded, size: 18),
                  label: Text(_exporting ? 'Preparing…' : 'Download my data'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),

          // ─── Close ──────────────────────────────────────────────────────
          if (!isClosed) ...[
            _Section(
              icon: Icons.power_settings_new_rounded,
              title: 'Close this account',
              body: 'Stops your storefront and your WhatsApp bot. Customers '
                  'can no longer order from you.',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Note(
                      'Closing does NOT delete anything. Your orders, '
                      'customers and messages are kept, and you can download '
                      'them afterwards.'),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _closing ? null : _close,
                    style: OutlinedButton.styleFrom(
                        foregroundColor: WabColors.danger),
                    icon: const Icon(Icons.power_settings_new_rounded,
                        size: 18),
                    label: Text(_closing ? 'Closing…' : 'Close my account'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
          ],

          // ─── Delete ─────────────────────────────────────────────────────
          const _Section(
            icon: Icons.delete_forever_rounded,
            title: 'Delete everything permanently',
            body: 'Erases your profile, catalogue, orders, customers and '
                'message history for good. This cannot be undone.',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Note(
                    'We check the request against the WhatsApp number on '
                    'file first, so nobody else can delete your business. '
                    'That is why it is an email and not a button.'),
                SizedBox(height: 12),
                Text('Email us from an address you control:',
                    style: TextStyle(fontSize: 13, color: WabColors.muted)),
                SizedBox(height: 6),
                _CopyRow(label: 'To', value: deletionRequestEmail),
                SizedBox(height: 6),
                _CopyRow(label: 'Subject', value: deletionRequestSubject),
                SizedBox(height: 10),
                Text('Include in the message:',
                    style: TextStyle(fontSize: 13, color: WabColors.muted)),
                SizedBox(height: 4),
                _Bullet('The WhatsApp number your account is linked to'),
                _Bullet('Your business name'),
                SizedBox(height: 10),
                Text(
                    'Deletion is completed within $deletionProcessingDays days '
                    'of us confirming it is you.',
                    style: TextStyle(fontSize: 12.5, color: WabColors.muted)),
                SizedBox(height: 10),
                _Note(
                    'Download your data first if you want to keep a copy — '
                    'after deletion there is nothing left to download.'),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

/// Asks WHY before closing, and makes the consequences concrete one last time.
///
/// The reason is optional and free-text: a merchant closing because they are
/// switching phones is a different problem from one closing because the bot
/// stopped working, and the second is worth knowing about.
class _CloseSheet extends StatefulWidget {
  const _CloseSheet();

  @override
  State<_CloseSheet> createState() => _CloseSheetState();
}

class _CloseSheetState extends State<_CloseSheet> {
  final _reason = TextEditingController();
  final _confirm = TextEditingController();
  bool _canClose = false;

  @override
  void initState() {
    super.initState();
    // Typed confirmation, not just a second button: closing takes a shop
    // offline, and a mis-tap on a small screen should not be able to do that.
    _confirm.addListener(() {
      final ok = _confirm.text.trim().toUpperCase() == 'CLOSE';
      if (ok != _canClose) setState(() => _canClose = ok);
    });
  }

  @override
  void dispose() {
    _reason.dispose();
    _confirm.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.only(
            left: 16,
            right: 16,
            top: 16,
            bottom: MediaQuery.of(context).viewInsets.bottom + 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Close your account',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 10),
            const _Bullet('Your storefront link stops working'),
            const _Bullet('Your WhatsApp bot stops replying to customers'),
            const _Bullet('Your orders, customers and messages are kept'),
            const SizedBox(height: 14),
            TextField(
              controller: _reason,
              maxLines: 2,
              maxLength: 500,
              decoration: const InputDecoration(
                labelText: 'Why are you closing? (optional)',
                hintText: 'It helps us fix what went wrong',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _confirm,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Type CLOSE to confirm',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Keep my account')),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: _canClose
                        ? () => Navigator.pop(context, _reason.text)
                        : null,
                    style:
                        FilledButton.styleFrom(backgroundColor: WabColors.danger),
                    child: const Text('Close account'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(
      {required this.icon,
      required this.title,
      required this.body,
      required this.child});

  final IconData icon;
  final String title;
  final String body;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: WabColors.accentInk),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(title,
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, fontSize: 16)),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(body,
                style: const TextStyle(fontSize: 13.5, color: WabColors.muted)),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: WabColors.bg2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: WabColors.line),
      ),
      child: Text(text,
          style: const TextStyle(fontSize: 12.5, color: WabColors.ink2)),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner(
      {required this.icon,
      required this.tone,
      required this.title,
      required this.body});

  final IconData icon;
  final Color tone;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: tone, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: TextStyle(fontWeight: FontWeight.w800, color: tone)),
                const SizedBox(height: 4),
                Text(body,
                    style: const TextStyle(
                        fontSize: 12.5, color: WabColors.ink2)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('•  ', style: TextStyle(color: WabColors.muted)),
          Expanded(
            child: Text(text,
                style:
                    const TextStyle(fontSize: 13, color: WabColors.ink2)),
          ),
        ],
      ),
    );
  }
}

/// A value the merchant has to reproduce exactly in an email — so it is
/// copyable rather than something to squint at and retype.
class _CopyRow extends StatelessWidget {
  const _CopyRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () {
        Clipboard.setData(ClipboardData(text: value));
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Semantics(liveRegion: true, child: Text('$label copied')),
          backgroundColor: WabColors.accentInk,
          duration: const Duration(seconds: 2),
        ));
      },
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: WabColors.paper,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: WabColors.line),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 58,
              child: Text(label,
                  style: const TextStyle(
                      fontSize: 12,
                      color: WabColors.muted,
                      fontWeight: FontWeight.w600)),
            ),
            Expanded(
              child: Text(value,
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w600)),
            ),
            const Icon(Icons.copy_rounded, size: 15, color: WabColors.muted2),
          ],
        ),
      ),
    );
  }
}
