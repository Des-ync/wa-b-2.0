import 'package:flutter/material.dart';

/// WA-B brand tokens — mirrors public/styles.css on the web dashboard.
/// "Kente Ledger" system: forest ink, market green, one kente-gold highlight.
class WabColors {
  static const accent = Color(0xFF12704E); // deep market green — actions
  static const accentInk = Color(0xFF0C543A);
  static const accentSoft = Color(0xFFE4EFE6);
  static const gold = Color(0xFFD9A02B); // kente gold — highlight only
  static const goldInk = Color(0xFF96690F);
  static const brick = Color(0xFFB0492F); // kente strip thread
  static const ink = Color(0xFF10231C); // forest ink
  static const ink2 = Color(0xFF1E2F28);
  static const muted = Color(0xFF5D6B62);
  static const muted2 = Color(0xFF8B968C);
  static const line = Color(0xFFEAE5D8);
  static const bg = Color(0xFFFAF6ED); // warm market paper
  static const bg2 = Color(0xFFF3EEE0);
  static const paper = Color(0xFFFFFDF8);
  // Darkened from the original C97A1D — that shade only hit 3.3:1 against
  // the app's paper/bg surfaces, failing WCAG AA (4.5:1) for the small
  // status-chip and label text it's used for. This hits ~5:1.
  static const warning = Color(0xFFA95A00);
  static const danger = Color(0xFFC24234);
}

ThemeData wabTheme() {
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: WabColors.accent,
      primary: WabColors.accent,
      surface: WabColors.bg,
      error: WabColors.danger,
    ),
    scaffoldBackgroundColor: WabColors.bg,
  );
  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: WabColors.bg,
      foregroundColor: WabColors.ink,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: WabColors.ink,
        fontSize: 20,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.4,
      ),
    ),
    cardTheme: CardThemeData(
      color: WabColors.paper,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: WabColors.line),
      ),
      margin: EdgeInsets.zero,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(54),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: WabColors.ink,
        side: const BorderSide(color: WabColors.line),
        minimumSize: const Size.fromHeight(54),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: WabColors.paper,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: WabColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: WabColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: WabColors.accent, width: 1.6),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: WabColors.paper,
      indicatorColor: WabColors.accentSoft,
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 12,
          fontWeight: states.contains(WidgetState.selected)
              ? FontWeight.w700
              : FontWeight.w500,
          color: states.contains(WidgetState.selected)
              ? WabColors.accentInk
              : WabColors.muted,
        ),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: WabColors.ink,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    dividerTheme: const DividerThemeData(color: WabColors.line, thickness: 1),
  );
}

/// Format cedis the same way everywhere: GH₵1,234.50
String ghs(dynamic v) {
  final n = v is num ? v.toDouble() : double.tryParse('$v') ?? 0;
  final s = n.toStringAsFixed(2);
  final parts = s.split('.');
  final withCommas =
      parts[0].replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',');
  return 'GH₵$withCommas.${parts[1]}';
}
