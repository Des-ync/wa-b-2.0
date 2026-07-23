import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../api/client.dart';
import '../services/offline_cache.dart';
import '../services/offline_queue.dart';
import '../state/session.dart';
import '../theme.dart';
import '../utils/voice_command_parser.dart';

/// Mic button for the Products screen: records a short voice note, transcribes
/// it fully on-device (speech_to_text with `onDevice: true` — no cloud speech
/// API, no API key), runs it through the plain-Dart rule-based parser, and
/// asks the merchant to confirm before touching anything. Never mutates
/// silently.
class VoiceUpdateButton extends StatefulWidget {
  final List<Map<String, dynamic>> Function() productsProvider;
  final VoidCallback onUpdated;
  const VoiceUpdateButton(
      {super.key, required this.productsProvider, required this.onUpdated});

  @override
  State<VoiceUpdateButton> createState() => _VoiceUpdateButtonState();
}

class _VoiceUpdateButtonState extends State<VoiceUpdateButton> {
  final _speech = SpeechToText();
  bool _listening = false;
  bool _busy = false;

  @override
  void dispose() {
    if (_listening) _speech.stop();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      return;
    }
    if (_busy) return;

    final available = await _speech.initialize(
      onStatus: (status) {
        if ((status == 'done' || status == 'notListening') && mounted) {
          setState(() => _listening = false);
        }
      },
      onError: (error) {
        if (mounted) setState(() => _listening = false);
        _toast('Voice recognition error: ${error.errorMsg}');
      },
    );
    if (!available) {
      _toast('Voice recognition isn\'t available on this device.');
      return;
    }

    if (!mounted) return;
    setState(() => _listening = true);
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content: Text('Listening… try "mark <product> out of stock" or '
          '"change price of <product> to 25"'),
      duration: Duration(seconds: 6),
    ));

    await _speech.listen(
      onResult: _onResult,
      listenOptions: SpeechListenOptions(
        onDevice: true, // hard requirement: on-device only, never cloud.
        partialResults: true,
        cancelOnError: true,
        listenMode: ListenMode.confirmation,
      ),
    );
  }

  Future<void> _onResult(SpeechRecognitionResult result) async {
    if (!result.finalResult) return;
    await _speech.stop();
    if (mounted) setState(() => _listening = false);

    final heard = result.recognizedWords.trim();
    if (heard.isEmpty) {
      _toast('Didn\'t catch a clear product update — try again.');
      return;
    }
    final products = widget.productsProvider();
    final command = parseVoiceCommand(heard, products);
    if (command == null) {
      _toast(
          'Heard "$heard" — didn\'t catch a clear product update. Try again.');
      return;
    }

    final confirmed = await _confirm(command);
    if (confirmed == true) await _apply(command);
  }

  Future<bool?> _confirm(VoiceCommand command) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirm update'),
        content: Text(command.confirmationText),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Confirm')),
        ],
      ),
    );
  }

  Future<void> _apply(VoiceCommand command) async {
    final id = '${command.product['id']}';
    final body = switch (command.action) {
      VoiceCommandAction.setOutOfStock => {'in_stock': false},
      VoiceCommandAction.setInStock => {'in_stock': true},
      VoiceCommandAction.setPrice => {'price_ghs': command.price},
    };
    setState(() => _busy = true);
    final session = context.read<Session>();
    try {
      await session.api.patch('/api/products/$id', body: body);
      await OfflineCache.patchCachedProduct(id, body);
      widget.onUpdated();
      _toast('Updated "${command.product['name']}".');
    } on ApiException catch (e) {
      if (e.status == 0) {
        await OfflineQueue.enqueue(QueuedAction(
          id: 'product-voice-$id-${DateTime.now().microsecondsSinceEpoch}',
          method: 'PATCH',
          path: '/api/products/$id',
          body: body,
          description: 'Voice update: ${command.confirmationText}',
        ));
        await OfflineCache.patchCachedProduct(id, body);
        widget.onUpdated();
        _toast('Offline — queued the update for "${command.product['name']}".');
      } else {
        _toast(e.message);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Semantics(liveRegion: true, child: Text(message)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: _listening ? 'Listening — tap to stop' : 'Voice update',
      onPressed: _busy ? null : _toggle,
      icon: Icon(_listening ? Icons.mic_rounded : Icons.mic_none_rounded,
          color: _listening ? WabColors.danger : null),
    );
  }
}
