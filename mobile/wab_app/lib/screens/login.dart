import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  bool _codeSent = false;
  bool _busy = false;
  int _resendIn = 0;
  Timer? _resendTimer;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    _resendTimer?.cancel();
    super.dispose();
  }

  void _startResendCountdown() {
    _resendTimer?.cancel();
    setState(() => _resendIn = 60);
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _resendIn = _resendIn > 0 ? _resendIn - 1 : 0);
      if (_resendIn == 0) t.cancel();
    });
  }

  void _toast(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? WabColors.danger : WabColors.ink,
    ));
  }

  Future<void> _requestCode() async {
    final phone = _phoneCtrl.text.trim();
    if (phone.length < 9) return _toast('Enter your business WhatsApp number', error: true);
    setState(() => _busy = true);
    try {
      await context.read<Session>().requestOtp(phone);
      setState(() => _codeSent = true);
      _startResendCountdown();
      _toast('Code sent to your WhatsApp 📲');
    } on ApiException catch (e) {
      if (e.code == 'link_required') {
        _toast('Finish setup on the web dashboard first, then log in here.', error: true);
      } else {
        _toast(e.message, error: true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final code = _codeCtrl.text.trim();
    if (code.length != 6) return _toast('Enter the 6-digit code', error: true);
    setState(() => _busy = true);
    try {
      await context.read<Session>().verifyOtp(_phoneCtrl.text.trim(), code);
      // _Gate rebuilds into the main shell.
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _teamLogin() async {
    final keyCtrl = TextEditingController();
    final key = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: WabColors.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Team login',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: WabColors.ink)),
            const SizedBox(height: 8),
            const Text('Paste your WA-B admin API key (sk_admin_...).',
                style: TextStyle(color: WabColors.muted)),
            const SizedBox(height: 20),
            TextField(
              controller: keyCtrl,
              autofocus: true,
              obscureText: true,
              decoration: const InputDecoration(hintText: 'sk_admin_...'),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, keyCtrl.text.trim()),
              child: const Text('Sign in'),
            ),
          ],
        ),
      ),
    );
    if (key == null || key.isEmpty || !mounted) return;
    setState(() => _busy = true);
    try {
      await context.read<Session>().loginAdmin(key);
    } on ApiException catch (e) {
      _toast(e.status == 401 || e.status == 403 ? 'That key was rejected.' : e.message,
          error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: WabColors.bg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 60),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: WabColors.ink,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: const Center(
                  child: Text('W',
                      style: TextStyle(
                          color: WabColors.gold, fontSize: 34, fontWeight: FontWeight.w900)),
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: 64,
                child: KenteStrip(height: 4, borderRadius: BorderRadius.circular(2)),
              ),
              const SizedBox(height: 24),
              Text(
                _codeSent ? 'Check WhatsApp' : 'Welcome back',
                style: const TextStyle(
                    fontSize: 30, fontWeight: FontWeight.w800, color: WabColors.ink, letterSpacing: -0.6),
              ),
              const SizedBox(height: 10),
              Text(
                _codeSent
                    ? 'We sent a 6-digit code to ${_phoneCtrl.text.trim()} on WhatsApp.'
                    : 'Log in with your business WhatsApp number.',
                style: const TextStyle(fontSize: 16, color: WabColors.muted, height: 1.4),
              ),
              const SizedBox(height: 36),
              if (!_codeSent) ...[
                TextField(
                  controller: _phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                    hintText: '024 123 4567',
                    prefixIcon: Icon(Icons.phone_rounded, color: WabColors.muted),
                  ),
                  onSubmitted: (_) => _requestCode(),
                ),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _busy ? null : _requestCode,
                  child: _busy
                      ? const SizedBox(
                          width: 22, height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                      : const Text('Send login code'),
                ),
              ] else ...[
                TextField(
                  controller: _codeCtrl,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofocus: true,
                  style: const TextStyle(fontSize: 24, letterSpacing: 12, fontWeight: FontWeight.w700),
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(counterText: '', hintText: '••••••'),
                  onSubmitted: (_) => _verify(),
                ),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _busy ? null : _verify,
                  child: _busy
                      ? const SizedBox(
                          width: 22, height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                      : const Text('Verify & sign in'),
                ),
                const SizedBox(height: 12),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    TextButton(
                      onPressed: () => setState(() {
                        _codeSent = false;
                        _codeCtrl.clear();
                      }),
                      child: const Text('Change number', style: TextStyle(color: WabColors.muted)),
                    ),
                    TextButton(
                      onPressed: _resendIn > 0 || _busy ? null : _requestCode,
                      child: Text(_resendIn > 0 ? 'Resend in ${_resendIn}s' : 'Resend code'),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 48),
              Center(
                child: TextButton.icon(
                  onPressed: _busy ? null : _teamLogin,
                  icon: const Icon(Icons.shield_rounded, size: 18, color: WabColors.muted),
                  label: const Text('Team login', style: TextStyle(color: WabColors.muted)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
