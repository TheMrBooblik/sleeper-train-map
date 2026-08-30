import 'package:latlong2/latlong.dart';

import 'polyline_codec.dart';

/// The offline basemap, built by `scripts/build-basemap.mjs` from Natural Earth.
///
/// There is no tile server: the OSMF tile policy forbids apps, and the hosted
/// alternatives are metered and mostly non-commercial-only. Everything drawn
/// under the routes comes from one committed 326 KB asset, which also means the
/// map is complete in a tunnel.
///
/// Two levels of detail because a 1:50m world is wasted below zoom 5. The
/// geometry is polyline-encoded at precision 4 — the same codec the routes use,
/// so [decodePolyline] is the app's only decoder.

/// A polygon: `rings.first` is the outline, the rest are holes (Lesotho inside
/// South Africa, the Caspian inside Asia).
class BasemapPolygon {
  const BasemapPolygon(this.rings);

  final List<List<LatLng>> rings;

  List<LatLng> get outline => rings.first;
  List<List<LatLng>> get holes => rings.length > 1 ? rings.sublist(1) : const [];
}

/// A city label. [rank] is 0 for a national capital, 1 for 1M+, 2 for 300k+;
/// the list is sorted by it, so taking the head is a zoom filter.
class BasemapPlace {
  const BasemapPlace(this.name, this.position, this.rank);

  final String name;
  final LatLng position;
  final int rank;
}

class Basemap {
  const Basemap({
    required this.attribution,
    required this.coarseCountries,
    required this.fineCountries,
    required this.lakes,
    required this.places,
  });

  final String attribution;
  final List<BasemapPolygon> coarseCountries;
  final List<BasemapPolygon> fineCountries;
  final List<BasemapPolygon> lakes;
  final List<BasemapPlace> places;

  /// Below this the coarse set is indistinguishable and six times cheaper.
  static const double detailZoom = 5;

  List<BasemapPolygon> countriesForZoom(double zoom) =>
      zoom < detailZoom ? coarseCountries : fineCountries;

  /// Lakes only earn their pixels once the coastline has real shape.
  List<BasemapPolygon> lakesForZoom(double zoom) =>
      zoom < detailZoom ? const [] : lakes;

  /// Capitals first, then progressively smaller cities as the map zooms in.
  List<BasemapPlace> placesForZoom(double zoom) {
    final maxRank = zoom < 4
        ? -1
        : zoom < 5
            ? 0
            : zoom < 6.5
                ? 1
                : 2;
    if (maxRank < 0) return const [];
    return places.where((p) => p.rank <= maxRank).toList();
  }

  static Basemap fromJson(Map<String, dynamic> json) {
    final precision = json['precision'] as int? ?? 4;

    List<BasemapPolygon> polygons(dynamic raw) => (raw as List<dynamic>? ?? [])
        .map((polygon) => BasemapPolygon(
              (polygon as List<dynamic>)
                  .map((ring) =>
                      decodePolyline(ring as String, precision: precision))
                  .where((points) => points.length >= 3)
                  .toList(),
            ))
        .where((polygon) => polygon.rings.isNotEmpty)
        .toList();

    final lo = json['lo'] as Map<String, dynamic>? ?? const {};
    final hi = json['hi'] as Map<String, dynamic>? ?? const {};

    return Basemap(
      attribution: json['attribution'] as String? ?? 'Natural Earth',
      coarseCountries: polygons(lo['countries']),
      fineCountries: polygons(hi['countries']),
      lakes: polygons(hi['lakes']),
      places: (json['places'] as List<dynamic>? ?? [])
          .map((p) => BasemapPlace(
                (p as Map<String, dynamic>)['n'] as String,
                LatLng((p['y'] as num).toDouble(), (p['x'] as num).toDouble()),
                p['r'] as int? ?? 2,
              ))
          .toList(),
    );
  }
}
