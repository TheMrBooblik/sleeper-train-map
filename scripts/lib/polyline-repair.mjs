// scripts/lib/polyline-repair.mjs
// An operator polyline must pass through the operator's own stops.
//
// The NightJet API returns a polyline and a stop list per train, and they are
// not always the same journey. NJ 11446 (Wien → Bregenz, the car-train variant
// diverted via Salzburg Süd and the Giselabahn) came back carrying NJ 446's
// polyline byte for byte — the regular routing through Rosenheim — so the map
// drew the line through Bavaria while the train's own stop list put a dot at
// Schwarzach-St. Veit, 55 km from it. Nothing downstream complains: the
// synthetic row draws whatever polyline it is handed, and every other dot on
// that route happens to sit on a line.
//
// So a train whose polyline misses one of its own stops is rebuilt leg by leg,
// stop to stop: its own geometry where a leg lies on it, else the shortest
// slice of another train's polyline that passes both ends (the other NightJets
// cover nearly every corridor this one could divert onto), else a straight hop.
// Every stop becomes a vertex, so a stop can no longer fall off its line. A
// train whose polyline already passes all its stops is left untouched.

import polyline from "@mapbox/polyline";
import {
  coordPathFromStations,
  haversineKm,
  maxStationDeviationKm,
  siblingSliceBetween,
} from "./sibling-path.mjs";

// Generous against vertex spacing (an API polyline samples every few hundred
// metres) and against a station coordinate sitting off the track centreline,
// tight against a train on another corridor: across the 73 NightJet/EuroNight
// trains every stop of every healthy polyline lies within 1.9 km of a vertex,
// and the one diverted train's worst stop is 55 km out.
export const STOP_TOLERANCE_KM = 3;

function pathKm(path) {
  let km = 0;
  for (let i = 1; i < path.length; i++) km += haversineKm(path[i - 1], path[i]);
  return km;
}

/**
 * A path through every stop in order. `own` is tried first for each leg; then
 * every donor that passes both ends, taking the shortest slice — a donor that
 * merely touches both stations on the way somewhere else is a detour, never a
 * shortcut, so the shortest candidate is the one that runs between them.
 *
 * @param {Array<[number, number]>} stops
 * @param {Array<[number, number]>} own
 * @param {Array<Array<[number, number]>>} donors
 * @param {{ toleranceKm?: number }} [options]
 * @returns {{ path: Array<[number, number]>, borrowed: number, straight: number }}
 */
export function pathThroughStops(stops, own, donors, { toleranceKm = STOP_TOLERANCE_KM } = {}) {
  if (!Array.isArray(stops) || stops.length < 2) {
    return { path: stops ?? [], borrowed: 0, straight: 0 };
  }
  const out = [stops[0]];
  let borrowed = 0;
  let straight = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    let mid = siblingSliceBetween(a, b, own, toleranceKm);
    if (!mid) {
      let best = null;
      let bestKm = Infinity;
      for (const donor of donors ?? []) {
        const slice = siblingSliceBetween(a, b, donor, toleranceKm);
        if (!slice) continue;
        const km = pathKm([a, ...slice, b]);
        if (km < bestKm) {
          best = slice;
          bestKm = km;
        }
      }
      mid = best;
      if (mid) borrowed++;
      // Adjacent stops a few hundred metres apart have no vertex between them
      // on any polyline; that is a short hop, not a missing corridor.
      else if (haversineKm(a, b) > toleranceKm) straight++;
    }
    out.push(...(mid ?? []), b);
  }
  return { path: out, borrowed, straight };
}

/**
 * Rebuild every train whose polyline misses one of its own stops.
 *
 * @param {Record<string, { polyline: string, stations: Array<object> }>} trains
 * @param {{ toleranceKm?: number }} [options]
 * @returns {{ trains: Record<string, object>, repaired: Array<{ key: string,
 *   missed: string[], beforeKm: number, afterKm: number, borrowed: number,
 *   straight: number }> }}
 */
export function repairPolylinesThroughStops(trains, { toleranceKm = STOP_TOLERANCE_KM } = {}) {
  const decoded = new Map();
  for (const [key, train] of Object.entries(trains ?? {})) {
    if (!train?.polyline) continue;
    const stops = coordPathFromStations(train.stations);
    if (stops.length < 2) continue;
    let path;
    try {
      path = polyline.decode(train.polyline);
    } catch {
      continue;
    }
    if (path.length < 2) continue;
    decoded.set(key, { stops, path, deviationKm: maxStationDeviationKm(stops, path) });
  }

  // Only a polyline that passes its own stops is evidence about a corridor.
  const healthy = [...decoded.entries()].filter(([, d]) => d.deviationKm <= toleranceKm);

  const out = { ...trains };
  const repaired = [];
  for (const [key, d] of decoded) {
    if (d.deviationKm <= toleranceKm) continue;
    const donors = healthy.filter(([k]) => k !== key).map(([, h]) => h.path);
    const { path, borrowed, straight } = pathThroughStops(d.stops, d.path, donors, {
      toleranceKm,
    });
    const missed = trains[key].stations
      .filter((s) => {
        const lat = s?.location?.latitude;
        const lon = s?.location?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        return maxStationDeviationKm([[lat, lon]], d.path) > toleranceKm;
      })
      .map((s) => s.name);
    out[key] = { ...trains[key], polyline: polyline.encode(path) };
    repaired.push({
      key,
      missed,
      beforeKm: d.deviationKm,
      afterKm: maxStationDeviationKm(d.stops, path),
      borrowed,
      straight,
    });
  }
  return { trains: out, repaired };
}
