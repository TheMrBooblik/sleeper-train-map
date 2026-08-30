import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/models.dart';
import '../logic/season.dart';
import '../logic/time_format.dart';

/// Open a booking or deals link in the browser rather than a web view, so the
/// operator's own session, autofill and payment sheet all work.
Future<void> openExternal(String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// The train's card: one section per direction, with the stop-by-stop timetable
/// underneath.
///
/// The web builds this by fetching up to nine operator feeds and merging them by
/// precedence at render time. Here the winner was already chosen at build time,
/// so this widget only lays out what it is given — which is why there is no
/// loading state, no retry and no "timetable unavailable" spinner.
class RouteSheet extends StatelessWidget {
  const RouteSheet({super.key, required this.route, this.visibility});

  final TrainRoute route;
  final RouteVisibility? visibility;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final startDate = visibility?.startDate;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.94,
      builder: (context, controller) => ListView(
        controller: controller,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
        children: [
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration:
                    BoxDecoration(color: route.color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(route.agency, style: theme.textTheme.titleMedium),
              ),
            ],
          ),
          if (startDate != null) ...[
            const SizedBox(height: 8),
            _Banner(
              icon: Icons.schedule,
              // Evaluated against the device clock, not the build date — see
              // logic/season.dart.
              text: 'Starts ${_formatDate(startDate)}',
            ),
          ],
          if (route.hasUnknownStart) ...[
            const SizedBox(height: 8),
            const _Banner(
              icon: Icons.help_outline,
              text: 'No opening date announced yet',
            ),
          ],
          const SizedBox(height: 8),
          for (final direction in route.directions)
            _DirectionCard(route: route, direction: direction),
          if (route.deals != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => _launch(route.deals!.url),
              icon: const Icon(Icons.local_offer_outlined, size: 18),
              label: Text(route.deals!.label ?? 'Deals'),
            ),
          ],
        ],
      ),
    );
  }

  static Future<void> _launch(String url) => openExternal(url);

  static String _formatDate(DateTime date) =>
      '${date.day.toString().padLeft(2, '0')}.'
      '${date.month.toString().padLeft(2, '0')}.${date.year}';
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Icon(icon, size: 16, color: theme.colorScheme.onSecondaryContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.onSecondaryContainer),
            ),
          ),
        ],
      ),
    );
  }
}

class _DirectionCard extends StatelessWidget {
  const _DirectionCard({required this.route, required this.direction});

  final TrainRoute route;
  final RouteDirection direction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(top: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${direction.from} → ${direction.to}',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                if (direction.train != null)
                  Chip(
                    label: Text(direction.train!),
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  ),
              ],
            ),
            if (direction.via.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                'via ${direction.via.join(' · ')}',
                style: theme.textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _Fact(
                    label: 'Departure',
                    value: direction.departure ?? '—',
                  ),
                ),
                Expanded(
                  child: _Fact(label: 'Arrival', value: direction.arrival ?? '—'),
                ),
              ],
            ),
            if (direction.duration != null || direction.service != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  if (direction.duration != null)
                    Expanded(
                      child: _Fact(label: 'Duration', value: direction.duration!),
                    ),
                  if (direction.service != null)
                    Expanded(
                      child: _Fact(label: 'Frequency', value: direction.service!),
                    ),
                ],
              ),
            ],
            if (direction.classes != null) ...[
              const SizedBox(height: 10),
              _Fact(label: 'Classes', value: direction.classes!),
            ],
            if (direction.irregularities != null &&
                direction.irregularities!.isNotEmpty) ...[
              const SizedBox(height: 10),
              _Fact(label: 'Notes', value: direction.irregularities!),
            ],
            if (direction.schedule != null) ...[
              const SizedBox(height: 8),
              _ScheduleTile(
                title: 'Timetable',
                schedule: direction.schedule!,
              ),
            ],
            if (direction.cdSchedule != null) ...[
              // ČD publishes its own stop list for some EuroNights; the web
              // shows it as a second accordion rather than replacing the first.
              const SizedBox(height: 4),
              _ScheduleTile(
                title: 'ČD timetable',
                schedule: direction.cdSchedule!,
              ),
            ],
            if (direction.bookingUrl != null) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () => openExternal(direction.bookingUrl!),
                icon: const Icon(Icons.open_in_new, size: 18),
                label: const Text('Book this train'),
              ),
            ],
          ],
        ),
      ),
    );
  }

}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label.toUpperCase(),
          style: theme.textTheme.labelSmall
              ?.copyWith(letterSpacing: 0.6, color: theme.hintColor),
        ),
        const SizedBox(height: 2),
        Text(value, style: theme.textTheme.bodyMedium),
      ],
    );
  }
}

class _ScheduleTile extends StatelessWidget {
  const _ScheduleTile({required this.title, required this.schedule});

  final String title;
  final Schedule schedule;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ExpansionTile(
      title: Text(title, style: theme.textTheme.labelLarge),
      subtitle: Text(
        '${schedule.stops.length} stops',
        style: theme.textTheme.bodySmall,
      ),
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: 8),
      children: [
        for (final stop in schedule.stops)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: Text(stop.name, style: theme.textTheme.bodySmall)),
                const SizedBox(width: 8),
                // The only place the utc/wall distinction is spent: an instant
                // is localised here, a wall clock is shown as published.
                Text(
                  _times(stop),
                  style: theme.textTheme.bodySmall
                      ?.copyWith(fontFeatures: const [], color: theme.hintColor),
                ),
              ],
            ),
          ),
      ],
    );
  }

  String _times(Stop stop) {
    final arrival = formatStopTime(stop.arrival, schedule.tz);
    final departure = formatStopTime(stop.departure, schedule.tz);
    if (arrival == null && departure == null) return '';
    if (arrival == departure) return departure ?? '';
    return '${arrival ?? '·'} / ${departure ?? '·'}';
  }
}
