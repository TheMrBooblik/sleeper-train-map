/**
 * Simple geodesic helpers (no library).
 * Used by "Trains near me" to rank sleeper stations by distance.
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in kilometres between two WGS84 points. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Rank stops by distance from a user position.
 * @param {{ stop_lat?: number, stop_lon?: number }[]} stops
 * @param {number} lat
 * @param {number} lon
 * @param {number} [limit=8]
 */
export function nearestStops(stops, lat, lon, limit = 8) {
  if (!Array.isArray(stops) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [];
  }
  return stops
    .filter(
      (s) =>
        Number.isFinite(s?.stop_lat) && Number.isFinite(s?.stop_lon) && s.stop_id,
    )
    .map((stop) => ({
      stop,
      distanceKm: haversineKm(lat, lon, stop.stop_lat, stop.stop_lon),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** Human-readable distance label. */
export function formatDistanceKm(km) {
  if (!Number.isFinite(km)) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
