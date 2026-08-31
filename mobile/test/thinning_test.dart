import 'package:flutter_test/flutter_test.dart';
import 'package:night_trains/logic/thinning.dart';

class _Marker implements Thinnable {
  const _Marker(this.lat, this.lng, {this.thinningScore = 1, this.alwaysShow = false});

  @override
  final double lat;
  @override
  final double lng;
  @override
  final int thinningScore;
  @override
  final bool alwaysShow;
}

void main() {
  // A 10°×10° box over central Europe.
  const north = 55.0;
  const south = 45.0;
  const east = 20.0;
  const west = 10.0;

  List<_Marker> markers() => const [
        _Marker(50.0, 14.0, thinningScore: 1005), // busy endpoint
        _Marker(50.05, 14.05, thinningScore: 3), // via-stop right next to it
        _Marker(48.2, 16.4, thinningScore: 1002),
        _Marker(60.0, 25.0, thinningScore: 1001), // outside the viewport
      ];

  test('above zoom 8 nothing is thinned', () {
    final kept = thinByViewport(
      markers: markers(),
      zoom: 9,
      north: north,
      south: south,
      east: east,
      west: west,
    );
    expect(kept.length, markers().length);
  });

  test('a crowded cell keeps only its highest-scoring marker', () {
    // The two Prague-ish markers fall in one 20×20 cell; the endpoint outranks
    // the via-stop by the 1000-point non-via bonus.
    final kept = thinByViewport(
      markers: markers(),
      zoom: 5,
      north: north,
      south: south,
      east: east,
      west: west,
    );
    expect(kept.any((m) => m.thinningScore == 1005), isTrue);
    expect(kept.any((m) => m.thinningScore == 3), isFalse);
  });

  test('markers outside the viewport are dropped', () {
    final kept = thinByViewport(
      markers: markers(),
      zoom: 5,
      north: north,
      south: south,
      east: east,
      west: west,
    );
    expect(kept.any((m) => m.lat == 60.0), isFalse);
  });

  test('the allowlist survives thinning and the viewport', () {
    const pinned = _Marker(60.0, 25.0, thinningScore: 0, alwaysShow: true);
    final kept = thinByViewport(
      markers: [...markers(), pinned],
      zoom: 3,
      north: north,
      south: south,
      east: east,
      west: west,
    );
    expect(kept.contains(pinned), isTrue);
  });

  test('the selected marker is never thinned away', () {
    const selected = _Marker(50.05, 14.05, thinningScore: 3);
    final kept = thinByViewport(
      markers: [...markers(), selected],
      zoom: 5,
      north: north,
      south: south,
      east: east,
      west: west,
      selected: selected,
    );
    expect(kept.contains(selected), isTrue);
  });

  test('with no bounds only forced markers are drawn', () {
    // The first frame, before the map reports a viewport: drawing everything
    // here is the dense flash the web's null-bounds branch exists to avoid.
    const pinned = _Marker(50.0, 14.0, alwaysShow: true);
    final kept = thinByViewport(markers: [...markers(), pinned], zoom: 5);
    expect(kept, [pinned]);
  });

  test('a degenerate viewport does not wipe the map', () {
    final kept = thinByViewport(
      markers: markers(),
      zoom: 5,
      north: 50,
      south: 50,
      east: 14,
      west: 14,
    );
    expect(kept, isEmpty, reason: 'nothing is forced, so nothing survives');
  });
}
