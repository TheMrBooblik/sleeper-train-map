import 'package:flutter_test/flutter_test.dart';
import 'package:night_trains/data/models.dart';
import 'package:night_trains/logic/geo.dart';
import 'package:night_trains/logic/time_format.dart';

void main() {
  group('haversine', () {
    test('matches known city distances', () {
      // Prague → Vienna is ~250 km, Prague → Brussels ~720 km. The port has to
      // agree with src/lib/geo.js, which is what ranks "stations near me".
      expect(haversineKm(50.0831, 14.4361, 48.2082, 16.3738), closeTo(250, 8));
      expect(haversineKm(50.0831, 14.4361, 50.8358, 4.3355), closeTo(719, 12));
    });

    test('is zero for a point against itself', () {
      expect(haversineKm(50, 14, 50, 14), closeTo(0, 1e-9));
    });
  });

  group('distance labels', () {
    test('switch units the way the web does', () {
      expect(formatDistanceKm(0.4), '400 m');
      expect(formatDistanceKm(2.34), '2.3 km');
      expect(formatDistanceKm(42.6), '43 km');
      expect(formatDistanceKm(double.nan), '');
    });
  });

  group('nearest stations', () {
    Station station(String name, double lat, double lng) => Station.fromJson({
          'n': name,
          'y': lat,
          'x': lng,
          'r': const ['1'],
          'm': 1,
        });

    test('ranks nearest first and honours the limit', () {
      final stations = [
        station('Vienna', 48.2082, 16.3738),
        station('Prague', 50.0831, 14.4361),
        station('Brussels', 50.8358, 4.3355),
      ];
      final nearest = nearestStations(stations, 50.08, 14.44, limit: 2);
      expect(nearest.map((n) => n.station.name), ['Prague', 'Vienna']);
    });

    test('a nonsense position returns nothing rather than a random ordering', () {
      expect(nearestStations(const [], double.nan, 14.0), isEmpty);
    });
  });

  group('stop times', () {
    test('a wall clock is shown exactly as published', () {
      // European Sleeper, PKP, Amtrak: already local to the station, so
      // converting would introduce the error rather than fix one.
      expect(formatStopTime('18:00', TimeZoneKind.wall), '18:00');
    });

    test('an instant is localised', () {
      // Nightjet and Italian publish real instants. The build refuses to
      // pre-format them because a UTC runner would print Brussels two hours out.
      final formatted = formatStopTime('2026-08-31T17:06:00.000Z', TimeZoneKind.utc);
      final expected = DateTime.parse('2026-08-31T17:06:00.000Z').toLocal();
      expect(
        formatted,
        '${expected.hour.toString().padLeft(2, '0')}:'
        '${expected.minute.toString().padLeft(2, '0')}',
      );
    });

    test('an unparseable instant falls back to the raw string', () {
      expect(formatStopTime('soon', TimeZoneKind.utc), 'soon');
    });

    test('a missing time stays missing', () {
      expect(formatStopTime(null, TimeZoneKind.wall), isNull);
      expect(formatStopTime('', TimeZoneKind.utc), isNull);
    });
  });
}
