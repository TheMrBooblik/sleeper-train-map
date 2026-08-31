/// Viewport marker thinning — a port of
/// `src/components/Map/utils/thinStationsByViewport.js`.
///
/// This is one of the few things that genuinely cannot be precomputed: it
/// depends on the live zoom and bounds. Above [_showAllZoom] every marker is
/// drawn; below it the viewport is cut into a grid and each cell keeps its
/// highest-scoring station, so a continent-wide view shows the important
/// stations rather than a solid mass of dots.
///
/// The allowlist match is NOT ported — the web resolves it through 50 lines of
/// station-name normalisation, so the build script resolves it instead and the
/// payload carries a boolean per marker.
///
/// Deliberately free of any Flutter or flutter_map import: bounds arrive as four
/// doubles, which is what lets this be exercised by a plain `flutter test`
/// without a widget binding — the same reason the web keeps `mapBounds` a plain
/// object rather than a Leaflet `LatLngBounds`.
library;

const int _showAllZoom = 8;

/// Anything a marker layer can thin: a station or a grouped city marker.
abstract class Thinnable {
  double get lat;
  double get lng;

  /// Ranks a marker within its grid cell. Endpoints outrank via-stops by a wide
  /// margin, then more routes wins — the same "non-via bonus + route count"
  /// the web uses, so the two maps keep the same dots.
  int get thinningScore;

  /// Never thinned, at any zoom.
  bool get alwaysShow;
}

/// 12×12 below zoom 4, 20×20 above: a wider view keeps fewer markers.
({int rows, int cols}) _grid(double zoom) =>
    zoom <= 3 ? (rows: 12, cols: 12) : (rows: 20, cols: 20);

/// Returns the markers to draw, in no particular order.
///
/// With no bounds yet — the first frame — only the allowlist is drawn, which
/// avoids a dense flash before the map settles.
List<T> thinByViewport<T extends Thinnable>({
  required List<T> markers,
  required double zoom,
  double? north,
  double? south,
  double? east,
  double? west,
  T? selected,
}) {
  if (markers.isEmpty) return const [];
  if (zoom >= _showAllZoom) return markers;

  bool forced(T marker) => marker.alwaysShow || identical(marker, selected);

  if (north == null || south == null || east == null || west == null) {
    return markers.where(forced).toList();
  }

  final latSpan = north - south;
  final lngSpan = east - west;
  if (latSpan <= 0 || lngSpan <= 0) return markers.where(forced).toList();

  final grid = _grid(zoom);
  final cellLat = latSpan / grid.rows;
  final cellLng = lngSpan / grid.cols;
  if (cellLat <= 0 || cellLng <= 0) return markers.where(forced).toList();

  final kept = <T>[];
  final winners = <int, ({T marker, int score})>{};

  for (final marker in markers) {
    if (forced(marker)) {
      kept.add(marker);
      continue;
    }

    final lat = marker.lat;
    final lng = marker.lng;
    if (lat < south || lat > north || lng < west || lng > east) continue;

    final row = ((lat - south) / cellLat).floor().clamp(0, grid.rows - 1);
    final col = ((lng - west) / cellLng).floor().clamp(0, grid.cols - 1);
    final cell = row * grid.cols + col;

    final score = marker.thinningScore;
    final existing = winners[cell];
    if (existing == null || score > existing.score) {
      winners[cell] = (marker: marker, score: score);
    }
  }

  for (final entry in winners.values) {
    kept.add(entry.marker);
  }
  return kept;
}
