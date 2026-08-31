import 'dart:math' as math;

import '../data/models.dart';

/// Geodesic helpers for "Stations near me" — a port of `src/lib/geo.js`, which
/// is 52 dependency-free lines and the cleanest thing in the repo to carry over.
/// Kept identical so the app ranks the same stations in the same order as the
/// web, down to the rounding in the labels.

const double _earthRadiusKm = 6371;

double _toRad(double degrees) => degrees * math.pi / 180;

/// Great-circle distance in kilometres between two WGS84 points.
double haversineKm(double lat1, double lon1, double lat2, double lon2) {
  final dLat = _toRad(lat2 - lat1);
  final dLon = _toRad(lon2 - lon1);
  final a = math.pow(math.sin(dLat / 2), 2) +
      math.cos(_toRad(lat1)) *
          math.cos(_toRad(lat2)) *
          math.pow(math.sin(dLon / 2), 2);
  return 2 * _earthRadiusKm * math.asin(math.sqrt(a.toDouble()));
}

class NearbyStation {
  const NearbyStation(this.station, this.distanceKm);

  final Station station;
  final double distanceKm;
}

/// Rank stations by distance from a position, nearest first.
List<NearbyStation> nearestStations(
  List<Station> stations,
  double lat,
  double lon, {
  int limit = 8,
}) {
  if (!lat.isFinite || !lon.isFinite) return const [];
  final ranked = stations
      .map((s) => NearbyStation(
            s,
            haversineKm(lat, lon, s.position.latitude, s.position.longitude),
          ))
      .toList()
    ..sort((a, b) => a.distanceKm.compareTo(b.distanceKm));
  return ranked.take(limit).toList();
}

/// Human-readable distance label, matching `formatDistanceKm`.
String formatDistanceKm(double km) {
  if (!km.isFinite) return '';
  if (km < 1) return '${(km * 1000).round()} m';
  if (km < 10) return '${km.toStringAsFixed(1)} km';
  return '${km.round()} km';
}
