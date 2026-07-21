import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/push.dart';
import '../state/session.dart';
import 'admin_home.dart';
import 'chat.dart';
import 'home.dart';
import 'inbox.dart';
import 'more.dart';
import 'order_detail.dart';
import 'orders.dart';
import 'products.dart';

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;
  StreamSubscription? _tapSub;

  @override
  void initState() {
    super.initState();
    _tapSub = notificationTaps.stream.listen(_handleTap);
  }

  @override
  void dispose() {
    _tapSub?.cancel();
    super.dispose();
  }

  /// Deep-link from a notification tap into the relevant screen.
  void _handleTap(Map<String, String> data) {
    final session = context.read<Session>();
    if (session.role != SessionRole.merchant) return;
    switch (data['type']) {
      case 'order':
        final id = data['order_id'];
        if (id != null) {
          Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => OrderDetailScreen(orderId: id)));
        } else {
          setState(() => _index = 1);
        }
      case 'message':
      case 'handoff':
        // 'handoff' is a customer asking for a human — same destination as
        // a plain message tap: open the chat thread with that customer.
        final customerId = data['customer_id'];
        if (customerId != null) {
          Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => ChatScreen(customerId: customerId)));
        } else {
          setState(() => _index = 2);
        }
      case 'product':
        setState(() => _index = 3);
      default:
        setState(() => _index = 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();

    if (session.role == SessionRole.admin) {
      return const AdminHomeScreen();
    }

    const pages = [
      HomeScreen(),
      OrdersScreen(),
      InboxScreen(),
      ProductsScreen(),
      MoreScreen(),
    ];

    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home_rounded), label: 'Home'),
          NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined),
              selectedIcon: Icon(Icons.receipt_long_rounded),
              label: 'Orders'),
          NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline_rounded),
              selectedIcon: Icon(Icons.chat_bubble_rounded),
              label: 'Inbox'),
          NavigationDestination(
              icon: Icon(Icons.inventory_2_outlined),
              selectedIcon: Icon(Icons.inventory_2_rounded),
              label: 'Products'),
          NavigationDestination(
              icon: Icon(Icons.menu_rounded), selectedIcon: Icon(Icons.menu_rounded), label: 'More'),
        ],
      ),
    );
  }
}
