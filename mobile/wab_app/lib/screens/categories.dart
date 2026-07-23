import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/catalog_api.dart';
import '../api/client.dart';
import '../state/session.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Structured category management — rename, hide, reorder (drag), and add.
/// A category with a null id is "virtual": a product.category value nobody
/// has explicitly customized yet (see category.routes.js). Rename/delete
/// only make sense once it has a real row, so those actions are hidden for
/// virtual rows; toggling hidden or dragging it materializes one via the
/// same upsert-on-conflict POST /categories uses.
class CategoriesScreen extends StatefulWidget {
  const CategoriesScreen({super.key});

  @override
  State<CategoriesScreen> createState() => _CategoriesScreenState();
}

class _CategoriesScreenState extends State<CategoriesScreen> {
  List<Map<String, dynamic>> _categories = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _categories.isEmpty;
      _error = null;
    });
    try {
      final session = context.read<Session>();
      final res = await session.api.getCategories(session.businessId!);
      if (!mounted) return;
      setState(() {
        _categories =
            ((res['categories'] as List?) ?? []).cast<Map<String, dynamic>>();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _toggleHidden(Map<String, dynamic> cat) async {
    final session = context.read<Session>();
    final newHidden = !(cat['hidden'] == true);
    try {
      if (cat['id'] == null) {
        await session.api.createCategory(session.businessId!, '${cat['name']}',
            hidden: newHidden);
      } else {
        await session.api.updateCategory('${cat['id']}', hidden: newHidden);
      }
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _rename(Map<String, dynamic> cat) async {
    final ctrl = TextEditingController(text: '${cat['name']}');
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename category'),
        content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'Category name')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('Save')),
        ],
      ),
    );
    if (name == null || name.isEmpty || !mounted) return;
    try {
      await context
          .read<Session>()
          .api
          .updateCategory('${cat['id']}', name: name);
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _delete(Map<String, dynamic> cat) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete category?'),
        content: Text(
            'This only removes the display settings for "${cat['name']}" — products keep their category.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete',
                  style: TextStyle(color: WabColors.danger))),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    try {
      await context.read<Session>().api.deleteCategory('${cat['id']}');
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _add() async {
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New category'),
        content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'Name')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('Add')),
        ],
      ),
    );
    if (name == null || name.isEmpty || !mounted) return;
    try {
      final session = context.read<Session>();
      await session.api.createCategory(session.businessId!, name,
          sortOrder: _categories.length);
      _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
    }
  }

  Future<void> _reorder(int oldIndex, int newIndex) async {
    setState(() {
      final item = _categories.removeAt(oldIndex);
      _categories.insert(newIndex, item);
    });
    final session = context.read<Session>();
    try {
      await session.api.reorderCategories(
          session.businessId!, _categories.map((c) => '${c['name']}').toList());
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.message), backgroundColor: WabColors.danger));
      }
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Categories')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _add,
        backgroundColor: WabColors.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add category'),
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: WabColors.accent))
          : _error != null
              ? ErrorRetry(message: _error!, onRetry: _load)
              : _categories.isEmpty
                  ? const Center(
                      child: EmptyState(
                          icon: Icons.category_rounded,
                          title: 'No categories yet',
                          subtitle:
                              'Categories on your products show up here automatically.'))
                  : ReorderableListView.builder(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                      itemCount: _categories.length,
                      onReorderItem: _reorder,
                      itemBuilder: (ctx, i) {
                        final c = _categories[i];
                        final hidden = c['hidden'] == true;
                        final virtual = c['id'] == null;
                        return Card(
                          key: ValueKey('${c['name']}'),
                          margin: const EdgeInsets.only(bottom: 10),
                          child: ListTile(
                            shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(14)),
                            title: Text('${c['name']}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700)),
                            subtitle: virtual
                                ? const Text('Not customized yet',
                                    style: TextStyle(
                                        color: WabColors.muted, fontSize: 12))
                                : null,
                            onTap: virtual ? null : () => _rename(c),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Switch(
                                  value: !hidden,
                                  onChanged: (_) => _toggleHidden(c),
                                  activeThumbColor: WabColors.accent,
                                ),
                                if (!virtual)
                                  IconButton(
                                    tooltip: 'Delete category',
                                    onPressed: () => _delete(c),
                                    icon: const Icon(
                                        Icons.delete_outline_rounded,
                                        color: WabColors.danger,
                                        size: 20),
                                  )
                                else
                                  const SizedBox(width: 12),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}
