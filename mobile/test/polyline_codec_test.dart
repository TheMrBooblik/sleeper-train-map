import 'package:flutter_test/flutter_test.dart';
import 'package:night_trains/data/polyline_codec.dart';

/// The decoder has to agree with `@mapbox/polyline`, because that is what
/// encodes everything the app draws. The fixtures below were produced by the JS
/// encoder itself, so this is a genuine cross-language check rather than a
/// round-trip against our own assumptions.
void main() {
  // polyline.encode([[50.0831,14.4361],[48.2082,16.3738],[47.4979,19.0402]], 5)
  const p5 = 'kztpHspbwAbemJsmyJjviC_xgO';
  // …the same points at precision 4, which is what the basemap uses.
  const p4 = '}dq]q}xGxrc@azd@|zLoas@';

  const expected = [
    [50.0831, 14.4361],
    [48.2082, 16.3738],
    [47.4979, 19.0402],
  ];

  void expectMatches(List points, {required double tolerance}) {
    expect(points.length, expected.length);
    for (var i = 0; i < expected.length; i++) {
      expect((points[i].latitude - expected[i][0]).abs(), lessThan(tolerance));
      expect((points[i].longitude - expected[i][1]).abs(), lessThan(tolerance));
    }
  }

  test('decodes precision 5, as used for route geometry', () {
    expectMatches(decodePolyline(p5), tolerance: 1e-5);
  });

  test('decodes precision 4, as used for the basemap', () {
    expectMatches(decodePolyline(p4, precision: 4), tolerance: 1e-4);
  });

  test('reading precision-4 data at the default precision is visibly wrong', () {
    // Guards against passing the basemap through the route decoder: the result
    // parses fine and lands in the wrong hemisphere, so nothing would throw.
    final wrong = decodePolyline(p4);
    expect((wrong.first.latitude - expected[0][0]).abs(), greaterThan(1));
  });

  test('an empty string decodes to nothing rather than throwing', () {
    expect(decodePolyline(''), isEmpty);
  });

  test('a truncated tail costs the rest of the line, not the app', () {
    // A corrupt download should degrade, not crash: the decoder stops at the
    // point it can no longer read a complete pair.
    final truncated = decodePolyline(p5.substring(0, p5.length - 2));
    expect(truncated.length, lessThan(expected.length));
    expect((truncated.first.latitude - expected[0][0]).abs(), lessThan(1e-5));
  });
}
