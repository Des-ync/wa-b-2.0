import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Brings [f] into the viewport whether or not it has been built yet.
///
/// Neither half is enough on its own, and getting it wrong does not fail
/// loudly — it fails by passing. `scrollUntilVisible` returns the moment its
/// finder matches, and a ListView builds a cache extent past the viewport, so
/// it will happily stop on a widget that is still off-screen; a `tap` on that
/// widget then computes an offset outside the render tree, silently hits
/// nothing, and the assertions after it check a screen that never changed.
/// `ensureVisible` scrolls the built widget the rest of the way into reach.
///
/// Use this for anything below the fold rather than tapping it directly.
Future<void> reveal(WidgetTester t, Finder f) async {
  await t.scrollUntilVisible(f, 120,
      scrollable: find.byType(Scrollable).first);
  await t.ensureVisible(f);
  await t.pumpAndSettle();
}
