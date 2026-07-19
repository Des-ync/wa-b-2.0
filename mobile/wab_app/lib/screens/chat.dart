import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ChatScreen extends StatefulWidget {
  final String customerId;
  final String? customerName;
  final bool botPaused;
  const ChatScreen(
      {super.key, required this.customerId, this.customerName, this.botPaused = false});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  List<Map<String, dynamic>> _messages = [];
  Map<String, dynamic>? _customer;
  bool _paused = false;
  bool _sending = false;
  final _textCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _paused = widget.botPaused;
    _load();
    // Light polling keeps the thread fresh while the merchant is looking at it.
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => _load(quiet: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    _textCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    try {
      final session = context.read<Session>();
      final res = await session.api.get(
          '/api/conversations/${widget.customerId}/messages',
          query: {'business_id': session.businessId, 'limit': 200});
      if (!mounted) return;
      final wasAtBottom = !_scrollCtrl.hasClients ||
          _scrollCtrl.position.pixels >= _scrollCtrl.position.maxScrollExtent - 60;
      setState(() {
        _messages = ((res['messages'] as List?) ?? []).cast<Map<String, dynamic>>();
        _customer = res['customer'] as Map<String, dynamic>?;
        _paused = _customer?['bot_paused'] == true;
      });
      if (wasAtBottom) _jumpToBottom();
    } catch (e) {
      if (!quiet && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('$e'), backgroundColor: WabColors.danger));
      }
    }
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.jumpTo(_scrollCtrl.position.maxScrollExtent);
      }
    });
  }

  Future<void> _send() async {
    final text = _textCtrl.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await context
          .read<Session>()
          .api
          .post('/api/conversations/${widget.customerId}/reply', body: {'text': text});
      _textCtrl.clear();
      setState(() => _paused = true); // replying pauses the bot server-side
      await _load(quiet: true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _togglePause() async {
    final action = _paused ? 'resume' : 'pause';
    try {
      await context
          .read<Session>()
          .api
          .post('/api/conversations/${widget.customerId}/$action');
      setState(() => _paused = !_paused);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(_paused
                ? 'Bot paused — you\'re handling this chat'
                : 'Bot resumed for this customer')));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final name =
        widget.customerName ?? _customer?['display_name'] ?? _customer?['whatsapp_number'] ?? 'Chat';
    return Scaffold(
      backgroundColor: WabColors.bg2,
      appBar: AppBar(
        title: Text('$name'),
        actions: [
          TextButton.icon(
            onPressed: _togglePause,
            icon: Icon(_paused ? Icons.smart_toy_outlined : Icons.front_hand_rounded,
                size: 18, color: _paused ? WabColors.accentInk : WabColors.warning),
            label: Text(_paused ? 'Resume bot' : 'Take over',
                style: TextStyle(
                    color: _paused ? WabColors.accentInk : WabColors.warning,
                    fontWeight: FontWeight.w700)),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_paused)
            Container(
              width: double.infinity,
              color: WabColors.warning.withValues(alpha: 0.1),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: const Text('Bot paused — the customer only hears from you.',
                  style: TextStyle(
                      color: WabColors.warning, fontSize: 13, fontWeight: FontWeight.w600)),
            ),
          Expanded(
            child: ListView.builder(
              controller: _scrollCtrl,
              padding: const EdgeInsets.all(16),
              itemCount: _messages.length,
              itemBuilder: (_, i) {
                final m = _messages[i];
                final out = m['direction'] == 'outbound';
                return Align(
                  alignment: out ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    constraints: BoxConstraints(
                        maxWidth: MediaQuery.of(context).size.width * 0.78),
                    decoration: BoxDecoration(
                      color: out ? const Color(0xFFD9FDD3) : Colors.white,
                      borderRadius: BorderRadius.only(
                        topLeft: const Radius.circular(14),
                        topRight: const Radius.circular(14),
                        bottomLeft: Radius.circular(out ? 14 : 4),
                        bottomRight: Radius.circular(out ? 4 : 14),
                      ),
                      border: Border.all(color: WabColors.line),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text('${m['content'] ?? ''}',
                            style: const TextStyle(fontSize: 15, height: 1.35)),
                        const SizedBox(height: 3),
                        Text(timeAgo(m['created_at']),
                            style: const TextStyle(
                                fontSize: 11, color: WabColors.muted2)),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
          SafeArea(
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              color: WabColors.paper,
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _textCtrl,
                      minLines: 1,
                      maxLines: 4,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(
                        hintText: 'Reply as the shop…',
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      ),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _sending ? null : _send,
                    style: IconButton.styleFrom(
                        backgroundColor: WabColors.accent, minimumSize: const Size(48, 48)),
                    icon: _sending
                        ? const SizedBox(
                            width: 18, height: 18,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.send_rounded, color: Colors.white),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
