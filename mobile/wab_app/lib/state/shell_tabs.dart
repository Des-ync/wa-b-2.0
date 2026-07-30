import 'dart:async';

/// Tab indices of [MainShell]'s bottom navigation. Named so callers elsewhere
/// never hard-code a bare integer that silently points at the wrong screen
/// when a tab is inserted.
class ShellTab {
  static const home = 0;
  static const orders = 1;
  static const inbox = 2;
  static const products = 3;
  static const more = 4;
}

/// Lets a screen inside the shell ask it to switch tabs.
///
/// The Task Center's whole promise is that every item "resolves in place" —
/// tapping "2 customers waiting for a reply" must land the merchant in the
/// Inbox, not on a pushed copy of it stacked over Home with a back arrow.
/// The shell owns the tab index, so it needs telling.
///
/// A broadcast stream rather than a callback threaded down through three
/// widgets, mirroring `notificationTaps` in services/push.dart, which solves
/// the same problem for notification deep-links.
final shellTabRequests = StreamController<int>.broadcast();
