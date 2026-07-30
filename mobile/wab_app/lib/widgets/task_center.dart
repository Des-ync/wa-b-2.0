import 'package:flutter/material.dart';

import '../state/shell_tabs.dart';
import '../state/task_center.dart';
import '../theme.dart';

/// "Things to do" on the home screen.
///
/// Actions, not analytics: every row is tappable and lands on the screen that
/// resolves it. The list is derived from data the home screen has already
/// fetched (see state/task_center.dart), so it costs nothing extra on a cold
/// load — which is the whole reason it can sit above the fold on a 3G phone.
class TaskCenter extends StatelessWidget {
  final List<MerchantTask> tasks;

  const TaskCenter({super.key, required this.tasks});

  static (Color, IconData) _style(TaskUrgency u) => switch (u) {
        TaskUrgency.blocking => (WabColors.danger, Icons.error_rounded),
        TaskUrgency.attention => (WabColors.warning, Icons.schedule_rounded),
        TaskUrgency.info => (WabColors.muted, Icons.info_outline_rounded),
      };

  @override
  Widget build(BuildContext context) {
    // Nothing to do is a good morning, not an empty state to apologise for.
    // Rendering a cheerful "all clear" card every day would be noise; the
    // section simply isn't there.
    if (tasks.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text('Things to do',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: WabColors.accentSoft,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text('${tasks.length}',
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: WabColors.accentInk)),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: WabColors.paper,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: WabColors.line),
          ),
          child: Column(
            children: [
              for (final (i, task) in tasks.indexed) ...[
                if (i > 0) const Divider(height: 1, indent: 52),
                _TaskRow(task: task),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _TaskRow extends StatelessWidget {
  final MerchantTask task;
  const _TaskRow({required this.task});

  @override
  Widget build(BuildContext context) {
    final (color, icon) = TaskCenter._style(task.urgency);

    return InkWell(
      // The shell owns the tab index, so ask it to switch rather than pushing
      // a second copy of Orders on top of Home with a back arrow.
      onTap: () => shellTabRequests.add(task.tabIndex),
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Icon(icon, size: 20, color: color),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(task.title,
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, height: 1.3)),
                  if (task.subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(task.subtitle!,
                        style: const TextStyle(
                            color: WabColors.muted, fontSize: 13, height: 1.3)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right_rounded,
                size: 20, color: WabColors.muted2),
          ],
        ),
      ),
    );
  }
}
