import '../data/models.dart';

/// The one thing the payload deliberately does not decide: what is true *today*.
///
/// `isRouteOutsideServiceIdSeason` and `getFutureRouteStartDate` on the web both
/// read the clock. Baking their verdicts into the payload would freeze them at
/// build time, and the app ships a seed copy that can be months old by the time
/// someone installs it — a summer-only train would still be drawn in November,
/// and a route that opened last week would still be ghosted.
///
/// So the payload carries the inputs (`seasonRanges`, `seasonBounded`,
/// `futureStarts`, `drawAsActive`) and this re-derives the verdict against the
/// device's own clock, every time the map is built.
class RouteVisibility {
  const RouteVisibility({
    required this.visible,
    required this.isFuture,
    required this.opacity,
    this.startDate,
  });

  final bool visible;

  /// Announced but not yet running: drawn, but faded unless tickets are on sale.
  final bool isFuture;

  /// The earliest announced start still ahead of today, if any.
  final DateTime? startDate;

  final double opacity;
}

RouteVisibility evaluateRoute(TrainRoute route, {DateTime? now}) {
  final today = _startOfDay(now ?? DateTime.now());

  final startDate = _earliestFutureStart(route.futureStarts, today);
  final isFuture = startDate != null;

  // Fade a route that has not opened yet — unless its tickets are already on
  // sale, which `drawAsActive` records and which does not depend on the date.
  final opacity =
      isFuture && !route.drawAsActive ? route.ghostOpacity : route.opacity;

  return RouteVisibility(
    visible: !_isOutOfSeason(route, today),
    isFuture: isFuture,
    startDate: startDate,
    opacity: opacity,
  );
}

/// A route is hidden only when *every* trip declares a service window and all of
/// them have already passed. A window still ahead keeps the route on the map as
/// a future ghost, which is why "upcoming" is checked separately from "current".
bool _isOutOfSeason(TrainRoute route, DateTime today) {
  if (!route.seasonBounded || route.seasonRanges.isEmpty) return false;

  var anyUpcoming = false;
  for (final range in route.seasonRanges) {
    if (range.length < 2) return false;
    final start = DateTime.tryParse(range[0]);
    final end = DateTime.tryParse(range[1]);
    if (start == null || end == null) return false;
    if (!today.isBefore(start) && !today.isAfter(end)) return false;
    if (today.isBefore(start)) anyUpcoming = true;
  }
  return !anyUpcoming;
}

DateTime? _earliestFutureStart(List<String> candidates, DateTime today) {
  DateTime? earliest;
  for (final iso in candidates) {
    final date = DateTime.tryParse(iso);
    if (date == null) continue;
    final day = _startOfDay(date);
    if (!day.isAfter(today)) continue;
    if (earliest == null || day.isBefore(earliest)) earliest = day;
  }
  return earliest;
}

DateTime _startOfDay(DateTime value) =>
    DateTime(value.year, value.month, value.day);
