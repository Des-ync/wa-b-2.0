/// Small, plain-Dart, rule-based parser that turns a transcribed voice note
/// into a product-update suggestion. Deliberately NOT ML — a couple of
/// regexes plus a basic fuzzy name match. Never applies anything itself; it
/// only proposes a [VoiceCommand] for the caller to confirm with the user.
library;

enum VoiceCommandAction { setOutOfStock, setInStock, setPrice }

class VoiceCommand {
  final Map<String, dynamic> product;
  final VoiceCommandAction action;
  final double? price; // only set when action == setPrice
  final String heardProductPhrase;

  VoiceCommand({
    required this.product,
    required this.action,
    required this.heardProductPhrase,
    this.price,
  });

  /// Human-readable "did I get this right?" line for the confirmation dialog.
  String get confirmationText {
    final name = '${product['name']}';
    return switch (action) {
      VoiceCommandAction.setOutOfStock => 'Mark "$name" as out of stock?',
      VoiceCommandAction.setInStock => 'Mark "$name" as in stock?',
      VoiceCommandAction.setPrice =>
        'Change the price of "$name" to GH¢${price!.toStringAsFixed(2)}?',
    };
  }
}

final _outOfStockPhrases = [
  'out of stock',
  'not available',
  'no longer available',
  'sold out',
  'no stock',
  'unavailable',
  'finished',
];
final _inStockPhrases = ['back in stock', 'in stock', 'available'];

final _priceRegex = RegExp(
  r'(?:change|update|set)\s+(?:the\s+)?price\s+(?:of|for)\s+(.+?)\s+to\s+'
  r'(?:ghc|ghs|gh¢|cedis?)?\s*([0-9]+(?:\.[0-9]+)?)',
  caseSensitive: false,
);

// "mark/make/set <product> [as] <phrase>" — phrase list is tried longest-first
// so "not available" wins over a looser match.
RegExp _stockRegex(List<String> phrases) {
  final sorted = [...phrases]..sort((a, b) => b.length.compareTo(a.length));
  final alt = sorted.map(RegExp.escape).join('|');
  return RegExp(r'(?:mark|make|set)\s+(.+?)\s+(?:as\s+)?(?:' + alt + r')\b',
      caseSensitive: false);
}

/// Attempts to parse [heard] (a raw speech transcription) into a product
/// update. Returns `null` if nothing was understood confidently — the
/// caller should tell the merchant to try again rather than guess.
VoiceCommand? parseVoiceCommand(
    String heard, List<Map<String, dynamic>> products) {
  final text = heard.trim().toLowerCase();
  if (text.isEmpty || products.isEmpty) return null;

  final priceMatch = _priceRegex.firstMatch(text);
  if (priceMatch != null) {
    final phrase = priceMatch.group(1)!.trim();
    final price = double.tryParse(priceMatch.group(2)!.trim());
    final product = _bestMatch(phrase, products);
    if (product != null && price != null) {
      return VoiceCommand(
          product: product,
          action: VoiceCommandAction.setPrice,
          price: price,
          heardProductPhrase: phrase);
    }
    return null;
  }

  final outMatch = _stockRegex(_outOfStockPhrases).firstMatch(text);
  if (outMatch != null) {
    final phrase = outMatch.group(1)!.trim();
    final product = _bestMatch(phrase, products);
    if (product != null) {
      return VoiceCommand(
          product: product,
          action: VoiceCommandAction.setOutOfStock,
          heardProductPhrase: phrase);
    }
    return null;
  }

  final inMatch = _stockRegex(_inStockPhrases).firstMatch(text);
  if (inMatch != null) {
    final phrase = inMatch.group(1)!.trim();
    final product = _bestMatch(phrase, products);
    if (product != null) {
      return VoiceCommand(
          product: product,
          action: VoiceCommandAction.setInStock,
          heardProductPhrase: phrase);
    }
    return null;
  }

  return null;
}

/// Best-effort fuzzy match of a spoken phrase against the loaded product
/// list: exact name match scores highest, substring containment next, and a
/// normalized Levenshtein distance covers the rest (mishearings, plurals,
/// etc). Below the confidence threshold, we'd rather say "didn't catch that"
/// than silently act on the wrong product.
Map<String, dynamic>? _bestMatch(
    String phrase, List<Map<String, dynamic>> products) {
  final needle = phrase.trim().toLowerCase();
  if (needle.length < 2) return null;

  Map<String, dynamic>? best;
  var bestScore = 0.0;
  for (final p in products) {
    final name = '${p['name'] ?? ''}'.trim().toLowerCase();
    if (name.isEmpty) continue;
    double score;
    if (name == needle) {
      score = 1.0;
    } else if (name.contains(needle) || needle.contains(name)) {
      score = 0.85;
    } else {
      score = _similarity(name, needle);
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  const confidenceThreshold = 0.55;
  return bestScore >= confidenceThreshold ? best : null;
}

double _similarity(String a, String b) {
  final maxLen = a.length > b.length ? a.length : b.length;
  if (maxLen == 0) return 1.0;
  return 1 - (_levenshtein(a, b) / maxLen);
}

/// Classic iterative Levenshtein edit distance (no external package needed).
int _levenshtein(String a, String b) {
  if (a == b) return 0;
  if (a.isEmpty) return b.length;
  if (b.isEmpty) return a.length;

  var prev = List<int>.generate(b.length + 1, (i) => i);
  var curr = List<int>.filled(b.length + 1, 0);

  for (var i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (var j = 1; j <= b.length; j++) {
      final cost = a[i - 1] == b[j - 1] ? 0 : 1;
      final deletion = prev[j] + 1;
      final insertion = curr[j - 1] + 1;
      final substitution = prev[j - 1] + cost;
      curr[j] =
          [deletion, insertion, substitution].reduce((x, y) => x < y ? x : y);
    }
    final tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}
