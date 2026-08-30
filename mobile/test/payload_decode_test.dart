import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:night_trains/data/basemap.dart';
import 'package:night_trains/data/models.dart';
import 'package:night_trains/logic/season.dart';

/// Decode the assets the app actually ships, through the models the app
/// actually uses.
///
/// `tests/verify-mobile-payload.mjs` proves the build writes a sound payload;
/// this proves the app can read it. Between them the contract is covered from
/// both sides, which matters because the two halves are in different languages
/// and only ever meet at this file format.
///
/// The assets are read from disk rather than through `rootBundle` so this stays
/// a plain unit test with no widget binding.
void main() {
  Map<String, dynamic> readGzipJson(String path) {
    final file = File(path);
    expect(
      file.existsSync(),
      isTrue,
      reason: '$path is missing — run `npm run build-mobile-payload` '
          'and `npm run sync-mobile-seed`',
    );
    return jsonDecode(utf8.decode(gzip.decode(file.readAsBytesSync())))
        as Map<String, dynamic>;
  }

  group('payload', () {
    late MapPayload payload;

    setUpAll(() {
      payload = MapPayload.fromJson(readGzipJson('assets/seed-v1.json.gz'));
    });

    test('decodes the whole network', () {
      expect(payload.version, 1);
      expect(payload.routes.length, greaterThan(200));
      expect(payload.stations.length, greaterThan(1500));
      expect(payload.groups.length, greaterThan(1000));
    });

    test('every route has drawable geometry and at least one direction', () {
      for (final route in payload.routes) {
        expect(route.strokes, isNotEmpty, reason: 'route ${route.id}');
        expect(route.directions, isNotEmpty, reason: 'route ${route.id}');
        for (final stroke in route.strokes) {
          expect(stroke.points.length, greaterThanOrEqualTo(2));
        }
      }
    });

    test('geometry lands in plausible places', () {
      // Catches a precision or lat/lng mix-up, which decodes cleanly and simply
      // draws the network somewhere else.
      for (final route in payload.routes) {
        for (final point in route.strokes.first.points) {
          expect(point.latitude, inInclusiveRange(-90, 90));
          expect(point.longitude, inInclusiveRange(-180, 180));
        }
      }
    });

    test('dash patterns are safe for StrokePattern.dashed', () {
      // An odd segment count trips an assert inside flutter_map, so this is a
      // crash rather than a cosmetic issue.
      for (final route in payload.routes) {
        final dash = route.dash;
        if (dash == null) continue;
        expect(dash.length.isEven, isTrue, reason: 'route ${route.id}');
        expect(dash.length, greaterThanOrEqualTo(2));
      }
    });

    test('city groups index real stations', () {
      for (final group in payload.groups) {
        expect(group.stationIndices, isNotEmpty);
        for (final index in group.stationIndices) {
          expect(index, inInclusiveRange(0, payload.stations.length - 1));
        }
      }
    });

    test('timetables carry stops and a usable timezone tag', () {
      var withSchedule = 0;
      for (final route in payload.routes) {
        for (final direction in route.directions) {
          for (final schedule
              in [direction.schedule, direction.cdSchedule].nonNulls) {
            withSchedule++;
            expect(schedule.stops.length, greaterThanOrEqualTo(2));
            expect(schedule.source, isNotEmpty);
          }
        }
      }
      expect(withSchedule, greaterThan(200));
    });

    test('every route can be evaluated against the clock without throwing', () {
      for (final route in payload.routes) {
        final now = evaluateRoute(route);
        expect(now.opacity, inInclusiveRange(0, 1));
        // Two years out: seasonal and future routes flip, and nothing may crash
        // on a payload the device has not refreshed.
        final later = evaluateRoute(route, now: DateTime(2028, 3, 1));
        expect(later.opacity, inInclusiveRange(0, 1));
      }
    });

    test('some stations are pinned by the always-show allowlist', () {
      // Resolved at build time; if the normalisation ever stopped matching, the
      // flag would silently vanish and low zooms would lose their anchors.
      expect(payload.stations.where((s) => s.alwaysShow).length, greaterThan(10));
      expect(payload.groups.where((g) => g.alwaysShow).length, greaterThan(10));
    });
  });

  group('basemap', () {
    late Basemap basemap;

    setUpAll(() {
      basemap = Basemap.fromJson(readGzipJson('assets/basemap.json.gz'));
    });

    test('decodes both levels of detail plus labels', () {
      expect(basemap.coarseCountries.length, greaterThan(100));
      expect(basemap.fineCountries.length, greaterThan(1000));
      expect(basemap.places.length, greaterThan(300));
      expect(basemap.attribution, contains('Natural Earth'));
    });

    test('swaps detail at the zoom threshold', () {
      expect(basemap.countriesForZoom(3), same(basemap.coarseCountries));
      expect(basemap.countriesForZoom(7), same(basemap.fineCountries));
      expect(basemap.lakesForZoom(3), isEmpty);
      expect(basemap.lakesForZoom(7), isNotEmpty);
    });

    test('reveals labels progressively', () {
      expect(basemap.placesForZoom(3), isEmpty);
      final capitals = basemap.placesForZoom(4.5);
      final everything = basemap.placesForZoom(8);
      expect(capitals.every((p) => p.rank == 0), isTrue);
      expect(everything.length, greaterThan(capitals.length));
    });

    test('rings are closed so polygons fill instead of leaking', () {
      for (final polygon in basemap.fineCountries.take(200)) {
        for (final ring in polygon.rings) {
          expect(ring.length, greaterThanOrEqualTo(3));
          expect((ring.first.latitude - ring.last.latitude).abs(), lessThan(1e-3));
          expect(
              (ring.first.longitude - ring.last.longitude).abs(), lessThan(1e-3));
        }
      }
    });
  });
}
