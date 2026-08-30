import 'package:flutter_test/flutter_test.dart';
import 'package:night_trains/data/models.dart';
import 'package:night_trains/logic/season.dart';

/// The clock-dependent half of route styling.
///
/// This is the logic the payload deliberately does NOT bake, so it is also the
/// only styling the app can get wrong on its own. Each case pins a `now`, which
/// is what makes the suite mean anything a year from today.
TrainRoute route({
  List<List<String>> seasonRanges = const [],
  bool seasonBounded = false,
  List<String> futureStarts = const [],
  bool drawAsActive = false,
  double opacity = 0.92,
  double ghostOpacity = 0.35,
}) =>
    TrainRoute.fromJson({
      'id': 'test',
      'agency': 'ÖBB',
      'color': '#112233',
      'weight': 4.5,
      'opacity': opacity,
      'ghostOpacity': ghostOpacity,
      'dash': null,
      'geom': const [],
      'dirs': const [],
      'seasonRanges': seasonRanges,
      'seasonBounded': seasonBounded,
      'futureStarts': futureStarts,
      'hasUnknownStart': false,
      'drawAsActive': drawAsActive,
    });

void main() {
  final august = DateTime(2026, 8, 30);

  group('season', () {
    test('a route with no declared window is always visible', () {
      expect(evaluateRoute(route(), now: august).visible, isTrue);
    });

    test('a route running today is visible', () {
      final r = route(
        seasonBounded: true,
        seasonRanges: [
          ['2026-06-13', '2026-09-06'],
        ],
      );
      expect(evaluateRoute(r, now: august).visible, isTrue);
    });

    test('a route whose whole season has passed is hidden', () {
      final r = route(
        seasonBounded: true,
        seasonRanges: [
          ['2026-06-13', '2026-07-06'],
        ],
      );
      expect(evaluateRoute(r, now: august).visible, isFalse);
    });

    test('a season still ahead keeps the route on the map', () {
      // A summer train seen in spring is a future ghost, not an absence — the
      // reason `isRouteOutsideServiceIdSeason` checks "upcoming" separately.
      final r = route(
        seasonBounded: true,
        seasonRanges: [
          ['2027-06-13', '2027-09-06'],
        ],
      );
      expect(evaluateRoute(r, now: august).visible, isTrue);
    });

    test('one unbounded trip keeps the whole route year-round', () {
      // seasonBounded is false when any trip lacks a window, which is exactly
      // when the web declines to hide the route.
      final r = route(
        seasonBounded: false,
        seasonRanges: [
          ['2026-06-13', '2026-07-06'],
        ],
      );
      expect(evaluateRoute(r, now: august).visible, isTrue);
    });
  });

  group('future starts', () {
    test('the earliest date still ahead wins', () {
      final r = route(futureStarts: ['2027-01-01', '2026-09-09', '2020-01-01']);
      final result = evaluateRoute(r, now: august);
      expect(result.isFuture, isTrue);
      expect(result.startDate, DateTime(2026, 9, 9));
    });

    test('a route that has already opened is not future', () {
      final r = route(futureStarts: ['2026-08-01']);
      final result = evaluateRoute(r, now: august);
      expect(result.isFuture, isFalse);
      expect(result.startDate, isNull);
    });

    test('a route that has not opened is ghosted', () {
      final r = route(futureStarts: ['2027-01-01']);
      expect(evaluateRoute(r, now: august).opacity, 0.35);
    });

    test('tickets already on sale keep full opacity', () {
      final r = route(futureStarts: ['2027-01-01'], drawAsActive: true);
      expect(evaluateRoute(r, now: august).opacity, 0.92);
    });

    test('the ghost lifts on its own once the start date passes', () {
      // The bug this whole design exists to prevent: ES 239 is "postponed to
      // 2027", so a payload built today bakes the ghost. An app still running in
      // 2027 must draw it normally without a new payload.
      final r = route(futureStarts: ['2027-01-01']);
      expect(evaluateRoute(r, now: august).opacity, 0.35);
      expect(evaluateRoute(r, now: DateTime(2027, 6, 1)).opacity, 0.92);
      expect(evaluateRoute(r, now: DateTime(2027, 6, 1)).isFuture, isFalse);
    });
  });
}
