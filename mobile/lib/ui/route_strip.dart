import 'package:flutter/material.dart';

import '../data/models.dart';

/// The horizontally scrolling strip of routes through the selected station —
/// the app's version of `TrainBottomBar`, which is 158 stateless lines on the
/// web and derives everything from props.
///
/// It exists so a tap on a city answers "what runs from here?" before asking for
/// a second tap. Each chip carries the route's own colour, which is how the
/// strip and the lines on the map stay legible as one selection.
class RouteStrip extends StatelessWidget {
  const RouteStrip({
    super.key,
    required this.routes,
    required this.onSelect,
    required this.onClose,
  });

  final List<TrainRoute> routes;
  final ValueChanged<TrainRoute> onSelect;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Container(
        margin: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(16),
          boxShadow: const [
            BoxShadow(color: Color(0x22000000), blurRadius: 12, offset: Offset(0, 4)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 6, 0),
              child: Row(
                children: [
                  Text(
                    routes.length == 1 ? '1 train' : '${routes.length} trains',
                    style: theme.textTheme.labelLarge,
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: onClose,
                    icon: const Icon(Icons.close, size: 20),
                    tooltip: 'Clear selection',
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
            ),
            SizedBox(
              height: 76,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                itemCount: routes.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (context, index) =>
                    _RouteChip(route: routes[index], onTap: () => onSelect(routes[index])),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RouteChip extends StatelessWidget {
  const _RouteChip({required this.route, required this.onTap});

  final TrainRoute route;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final direction = route.directions.isEmpty ? null : route.directions.first;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: 210,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: theme.dividerColor),
          // The route's own colour as a left rule, so the chip and the line on
          // the map are obviously the same thing.
          gradient: LinearGradient(
            colors: [route.color.withValues(alpha: 0.16), Colors.transparent],
            stops: const [0, 0.035],
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Row(
              children: [
                Container(width: 8, height: 8,
                    decoration: BoxDecoration(color: route.color, shape: BoxShape.circle)),
                const SizedBox(width: 6),
                Text(
                  direction?.train ?? route.agency,
                  style: theme.textTheme.labelMedium
                      ?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    route.agency,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              route.label,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
