import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Full client profile: view + edit everything an admin may need to fix
/// on the road — status, trial, contact details, bot settings — plus
/// direct actions (WhatsApp the owner, issue an API key).
class AdminBusinessDetailScreen extends StatefulWidget {
  final String businessId;
  const AdminBusinessDetailScreen({super.key, required this.businessId});

  @override
  State<AdminBusinessDetailScreen> createState() =>
      _AdminBusinessDetailScreenState();
}

class _AdminBusinessDetailScreenState extends State<AdminBusinessDetailScreen> {
  Map<String, dynamic>? _business;
  Map<String, dynamic>? _counters;
  List<Map<String, dynamic>> _messages = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final res = await context
          .read<Session>()
          .api
          .get('/api/admin/businesses/${widget.businessId}');
      if (!mounted) return;
      setState(() {
        _business = res['business'] as Map<String, dynamic>?;
        _counters = res['counters'] as Map<String, dynamic>?;
        _messages = ((res['recent_messages'] as List?) ?? [])
            .cast<Map<String, dynamic>>();
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _patch(Map<String, dynamic> body, String successMsg) async {
    try {
      await context
          .read<Session>()
          .api
          .patch('/api/admin/businesses/${widget.businessId}', body: body);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(successMsg), backgroundColor: WabColors.accentInk));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  Future<void> _changeStatus() async {
    const statuses = ['trial', 'active', 'grace', 'suspended', 'cancelled'];
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Change status',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            ),
            ...statuses.map((s) => ListTile(
                  title: Text(s),
                  trailing: s == _business?['status']
                      ? const Icon(Icons.check_rounded, color: WabColors.accent)
                      : null,
                  onTap: () => Navigator.pop(ctx, s),
                )),
          ],
        ),
      ),
    );
    if (picked != null && picked != _business?['status']) {
      await _patch({'status': picked}, 'Status changed to $picked');
    }
  }

  Future<void> _extendTrial() async {
    final days = await showModalBottomSheet<int>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Extend trial by…',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            ),
            for (final d in [7, 14, 30])
              ListTile(
                  title: Text('$d days'), onTap: () => Navigator.pop(ctx, d)),
          ],
        ),
      ),
    );
    if (days == null) return;
    final currentEnd =
        DateTime.tryParse('${_business?['trial_ends_at'] ?? ''}') ??
            DateTime.now();
    final base =
        currentEnd.isAfter(DateTime.now()) ? currentEnd : DateTime.now();
    await _patch(
      {
        'trial_ends_at':
            base.add(Duration(days: days)).toUtc().toIso8601String()
      },
      'Trial extended by $days days',
    );
  }

  Future<void> _sendMessage() async {
    final controller = TextEditingController();
    final send = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title:
            Text('WhatsApp ${_business?['owner_name'] ?? _business?['name']}'),
        content: TextField(
          controller: controller,
          maxLines: 4,
          autofocus: true,
          decoration: const InputDecoration(
              labelText: 'Message', hintText: 'Type your message…'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Send')),
        ],
      ),
    );
    if (send != true || controller.text.trim().isEmpty || !mounted) return;
    try {
      await context.read<Session>().api.post(
        '/api/admin/businesses/${widget.businessId}/message',
        body: {'body': controller.text.trim()},
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Message sent ✓'),
          backgroundColor: WabColors.accentInk));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  Future<void> _issueApiKey() async {
    try {
      final res = await context
          .read<Session>()
          .api
          .post('/api/admin/businesses/${widget.businessId}/api-key');
      final plaintext = res['key']?['plaintext'] as String?;
      if (!mounted || plaintext == null) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('API key issued'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Copy it now — it is shown exactly once.',
                  style: TextStyle(color: WabColors.muted, fontSize: 13)),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: WabColors.bg2,
                    borderRadius: BorderRadius.circular(10)),
                child: SelectableText(plaintext,
                    style:
                        const TextStyle(fontSize: 13, fontFamily: 'monospace')),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: plaintext));
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Key copied to clipboard'),
                    backgroundColor: WabColors.accentInk));
              },
              child: const Text('Copy & close'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  Future<void> _editProfile() async {
    final b = _business!;
    final changed = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => _EditProfileScreen(business: b)),
    );
    if (changed == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
          appBar: AppBar(title: const Text('Business')),
          body: ErrorRetry(message: _error!, onRetry: _load));
    }
    final b = _business;
    if (b == null) {
      return Scaffold(
          appBar: AppBar(title: const Text('Business')),
          body: const Center(
              child: CircularProgressIndicator(color: WabColors.accent)));
    }
    final c = _counters ?? {};
    final sub = b['subscription'] as Map<String, dynamic>?;

    return Scaffold(
      appBar: AppBar(
        title: Text('${b['name']}'),
        actions: [
          IconButton(
              tooltip: 'Edit business profile',
              onPressed: _editProfile,
              icon: const Icon(Icons.edit_rounded)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        color: WabColors.accent,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('${b['owner_name'] ?? 'No owner name'}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w700, fontSize: 16)),
                        ),
                        StatusChip('${b['status']}'),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                        '${b['whatsapp_number']} · ${b['industry'] ?? ''}'
                        '${sub != null ? ' · ${sub['plan_name']} (${sub['status']})' : ' · no subscription'}',
                        style: const TextStyle(color: WabColors.muted)),
                    if (b['status'] == 'trial') ...[
                      const SizedBox(height: 6),
                      Text('Trial ends ${shortDate(b['trial_ends_at'])}',
                          style: const TextStyle(
                              color: WabColors.warning,
                              fontWeight: FontWeight.w600,
                              fontSize: 13)),
                    ],
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        _Counter('Customers', '${c['customers'] ?? 0}'),
                        _Counter('Orders', '${c['orders'] ?? 0}'),
                        _Counter('Revenue', ghs(c['revenue_ghs'] ?? 0)),
                        _Counter('Msgs 7d', '${c['messages_7d'] ?? 0}'),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ActionChip(
                    avatar: const Icon(Icons.swap_horiz_rounded, size: 18),
                    label: const Text('Change status'),
                    onPressed: _changeStatus),
                ActionChip(
                    avatar: const Icon(Icons.more_time_rounded, size: 18),
                    label: const Text('Extend trial'),
                    onPressed: _extendTrial),
                ActionChip(
                    avatar: const Icon(Icons.chat_rounded, size: 18),
                    label: const Text('WhatsApp owner'),
                    onPressed: _sendMessage),
                ActionChip(
                    avatar: const Icon(Icons.vpn_key_rounded, size: 18),
                    label: const Text('Issue API key'),
                    onPressed: _issueApiKey),
              ],
            ),
            const SizedBox(height: 20),
            const Text('Recent messages',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            if (_messages.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(
                    child: Text('No messages yet',
                        style: TextStyle(color: WabColors.muted))),
              ),
            ..._messages.map((m) => Card(
                  child: ListTile(
                    dense: true,
                    leading: Semantics(
                      label: m['direction'] == 'inbound'
                          ? 'Received message'
                          : 'Sent message',
                      child: Icon(
                        m['direction'] == 'inbound'
                            ? Icons.call_received_rounded
                            : Icons.call_made_rounded,
                        size: 18,
                        color: m['direction'] == 'inbound'
                            ? WabColors.goldInk
                            : WabColors.accentInk,
                      ),
                    ),
                    title: Text('${m['content'] ?? '[${m['message_type']}]'}',
                        maxLines: 2, overflow: TextOverflow.ellipsis),
                    subtitle: Text(
                        '${m['customer_name'] ?? 'Customer'} · ${timeAgo(m['created_at'])} · ${m['status']}',
                        style: const TextStyle(
                            color: WabColors.muted, fontSize: 12)),
                  ),
                )),
            const SizedBox(height: 30),
          ],
        ),
      ),
    );
  }
}

class _Counter extends StatelessWidget {
  final String label;
  final String value;
  const _Counter(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Text(value,
              style:
                  const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          const SizedBox(height: 2),
          Text(label,
              style: const TextStyle(color: WabColors.muted, fontSize: 11.5)),
        ],
      ),
    );
  }
}

/// Editable client profile form — every field the PATCH endpoint accepts.
class _EditProfileScreen extends StatefulWidget {
  final Map<String, dynamic> business;
  const _EditProfileScreen({required this.business});

  @override
  State<_EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<_EditProfileScreen> {
  late final _name =
      TextEditingController(text: '${widget.business['name'] ?? ''}');
  late final _owner =
      TextEditingController(text: '${widget.business['owner_name'] ?? ''}');
  late final _phone = TextEditingController(
      text: '${widget.business['whatsapp_number'] ?? ''}');
  late final _waPhoneId = TextEditingController(
      text: '${widget.business['wa_phone_number_id'] ?? ''}');
  late final _support =
      TextEditingController(text: '${widget.business['support_phone'] ?? ''}');
  late final _welcome = TextEditingController(
      text: '${widget.business['welcome_message'] ?? ''}');
  late final _deliveryFee = TextEditingController(
      text: '${widget.business['delivery_fee_ghs'] ?? ''}');
  late final _openTime =
      TextEditingController(text: '${widget.business['open_time'] ?? ''}');
  late final _closeTime =
      TextEditingController(text: '${widget.business['close_time'] ?? ''}');
  late String _industry = '${widget.business['industry'] ?? 'retail'}';
  late String _botLanguage = '${widget.business['bot_language'] ?? 'en'}';
  bool _saving = false;

  static const _industries = [
    'retail',
    'food',
    'fashion',
    'beauty',
    'electronics',
    'pharmacy',
    'services',
    'other'
  ];

  @override
  void dispose() {
    for (final c in [
      _name,
      _owner,
      _phone,
      _waPhoneId,
      _support,
      _welcome,
      _deliveryFee,
      _openTime,
      _closeTime
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await context.read<Session>().api.patch(
        '/api/admin/businesses/${widget.business['id']}',
        body: {
          'name': _name.text.trim(),
          'owner_name': _owner.text.trim(),
          'whatsapp_number': _phone.text.trim(),
          'wa_phone_number_id': _waPhoneId.text.trim(),
          'support_phone': _support.text.trim(),
          'welcome_message': _welcome.text.trim(),
          'industry': _industry,
          'bot_language': _botLanguage,
          if (_deliveryFee.text.trim().isNotEmpty)
            'delivery_fee_ghs': _deliveryFee.text.trim(),
          'open_time': _openTime.text.trim(),
          'close_time': _closeTime.text.trim(),
        },
      );
      if (!mounted) return;
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit profile'),
        actions: [
          TextButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Save')),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Business name')),
          const SizedBox(height: 14),
          TextField(
              controller: _owner,
              decoration: const InputDecoration(labelText: 'Owner name')),
          const SizedBox(height: 14),
          TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'WhatsApp number')),
          const SizedBox(height: 14),
          DropdownButtonFormField<String>(
            initialValue: _industries.contains(_industry) ? _industry : 'other',
            decoration: const InputDecoration(labelText: 'Industry'),
            items: _industries
                .map((i) => DropdownMenuItem(value: i, child: Text(i)))
                .toList(),
            onChanged: (v) => setState(() => _industry = v ?? 'retail'),
          ),
          const SizedBox(height: 14),
          DropdownButtonFormField<String>(
            initialValue: _botLanguage == 'tw' ? 'tw' : 'en',
            decoration: const InputDecoration(labelText: 'Bot language'),
            items: const [
              DropdownMenuItem(value: 'en', child: Text('English')),
              DropdownMenuItem(value: 'tw', child: Text('Twi')),
            ],
            onChanged: (v) => setState(() => _botLanguage = v ?? 'en'),
          ),
          const SizedBox(height: 14),
          TextField(
              controller: _support,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'Support phone',
                  helperText: 'Handed out on "Talk to us"')),
          const SizedBox(height: 14),
          TextField(
              controller: _welcome,
              maxLines: 3,
              decoration:
                  const InputDecoration(labelText: 'Custom welcome message')),
          const SizedBox(height: 14),
          TextField(
              controller: _waPhoneId,
              decoration:
                  const InputDecoration(labelText: 'Meta phone number ID')),
          const SizedBox(height: 14),
          TextField(
              controller: _deliveryFee,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration:
                  const InputDecoration(labelText: 'Flat delivery fee (GHS)')),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: TextField(
                    controller: _openTime,
                    decoration: const InputDecoration(
                        labelText: 'Opens', hintText: '08:00')),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                    controller: _closeTime,
                    decoration: const InputDecoration(
                        labelText: 'Closes', hintText: '21:00')),
              ),
            ],
          ),
          const SizedBox(height: 30),
        ],
      ),
    );
  }
}
