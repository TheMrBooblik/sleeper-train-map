import 'package:latlong2/latlong.dart';

/// Google/Mapbox polyline decoding.
///
/// Everything the app draws arrives in this encoding — route strokes at
/// precision 5, the Natural Earth basemap at precision 4 — which is the whole
/// reason the build side re-encodes the basemap instead of inventing a second
/// binary format. Thirty lines here replaces a package.
///
/// The encoding is a base-64-ish varint of deltas between consecutive points,
/// so a decoder only ever moves forward and never allocates twice.
List<LatLng> decodePolyline(String encoded, {int precision = 5}) {
  final factor = _pow10(precision);
  final points = <LatLng>[];
  var index = 0;
  var lat = 0;
  var lng = 0;

  while (index < encoded.length) {
    final latDelta = _readDelta(encoded, index);
    if (latDelta == null) break;
    index = latDelta.nextIndex;
    lat += latDelta.value;

    final lngDelta = _readDelta(encoded, index);
    if (lngDelta == null) break;
    index = lngDelta.nextIndex;
    lng += lngDelta.value;

    points.add(LatLng(lat / factor, lng / factor));
  }
  return points;
}

class _Delta {
  const _Delta(this.value, this.nextIndex);
  final int value;
  final int nextIndex;
}

/// One zig-zag encoded varint. Returns null on a truncated tail rather than
/// throwing: a corrupt download should cost the rest of a line, not the app.
_Delta? _readDelta(String encoded, int start) {
  var index = start;
  var shift = 0;
  var result = 0;
  int chunk;
  do {
    if (index >= encoded.length) return null;
    chunk = encoded.codeUnitAt(index) - 63;
    index += 1;
    result |= (chunk & 0x1f) << shift;
    shift += 5;
  } while (chunk >= 0x20);

  final value = (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
  return _Delta(value, index);
}

double _pow10(int exponent) {
  var value = 1.0;
  for (var i = 0; i < exponent; i++) {
    value *= 10;
  }
  return value;
}
