import 'package:flutter/material.dart';

/// WA-B brand tokens — mirrors public/styles.css on the web dashboard.
class WabColors {
  static const accent = Color(0xFF10A37F);
  static const accentInk = Color(0xFF0A8B6A);
  static const accentSoft = Color(0xFFE8F7F1);
  static const ink = Color(0xFF0A0D0C);
  static const muted = Color(0xFF5B6864);
  static const muted2 = Color(0xFF8A9591);
  static const line = Color(0xFFEBEDE9);
  static const bg = Color(0xFFFCFCFA);
  static const bg2 = Color(0xFFF5F5F0);
  static const paper = Color(0xFFFFFFFF);
  static const warning = Color(0xFFC97A1D);
  static const danger = Color(0xFFD14545);
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
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: WabColors.ink,
        side: const BorderSide(color: WabColors.line),
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
          fontWeight:
              states.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          color: states.contains(WidgetState.selected) ? WabColors.accentInk : WabColors.muted,
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
  final withCommas = parts[0].replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',');
  return 'GH₵$withCommas.${parts[1]}';
}
