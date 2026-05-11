// Merges GTFS-derived polylines into Back-on-Track viewMap rows (PKP / PKP/ČD only).
// Bundle: public/data/gtfs/pkpTrainShapes.json from scripts/parse-pkp-gtfs.js

import {
  positionsForBoTTripLabel,
  stopsForBoTTripLabel,
  railSegmentsForBoTTripLabel,
  busSegmentsForBoTTripLabel,
} from "./pkpTrainKeyExtract";

/**
 * Returns true for the Przemyśl Gł. ↔ Świnoujście PKP route.
 * Its trip label "EN 430 / IC 28170" causes key "28170" to be extracted, which maps to
 * the Chełm → Świnoujście GTFS shape (wrong corridor: via Warsaw/Łódź instead of Kraków/Wrocław).
 * Skipping GTFS lets the station-coord fallback show the correct route.
 * @param {object} route
 * @returns {boolean}
 */
function isPrzemyslSwinoujscieRoute(route) {
  const o0 = (route.origin_trip_0 || "").toLowerCase();
  const d0 = (route.destination_trip_0 || "").toLowerCase();
  const o1 = (route.origin_trip_1 || "").toLowerCase();
  const d1 = (route.destination_trip_1 || "").toLowerCase();
  const hasPrzemysl =
    o0.includes("przemyśl") || o0.includes("przemysl") ||
    d0.includes("przemyśl") || d0.includes("przemysl") ||
    o1.includes("przemyśl") || o1.includes("przemysl") ||
    d1.includes("przemyśl") || d1.includes("przemysl");
  const hasSwinoujscie =
    o0.includes("winouj") || d0.includes("winouj") ||
    o1.includes("winouj") || d1.includes("winouj");
  return hasPrzemysl && hasSwinoujscie;
}

/**
 * Returns true for the Praha hl.n. ↔ Warszawa Wschodnia EN 443 / IC 406 route.
 * Trip labels "EN 443 / IC 406" and "IC 407 / EN 442" cause key "406"/"407" to be
 * extracted first, which maps to the München↔Warszawa NightJet GTFS shape (wrong corridor).
 * Skipping GTFS lets the station-coord fallback (via BoT via_0) show the correct route.
 * @param {object} route
 * @returns {boolean}
 */
function isPrahaWarszawaRoute(route) {
  const fields = [
    route.origin_trip_0,
    route.destination_trip_0,
    route.origin_trip_1,
    route.destination_trip_1,
  ].map((f) => (f || "").toLowerCase());
  return (
    fields.some((f) => f.includes("praha")) &&
    fields.some((f) => f.includes("warszawa"))
  );
}

/**
 * @param {Record<string, object>} viewMap
 * @param {{ byTrainKey?: Record<string, { positions?: number[][] }> } | null} bundle
 * @returns {Record<string, object>}
 */
export function attachPkpGtfsPolylinesToViewMap(viewMap, bundle) {
  if (!viewMap || !bundle?.byTrainKey) return viewMap;

  const byTrainKey = bundle.byTrainKey;
  const out = {};

  for (const key of Object.keys(viewMap)) {
    const route = viewMap[key];
    const agency = route?.agency_id;
    if (agency !== "PKP" && agency !== "PKP/ČD") {
      out[key] = route;
      continue;
    }

    if (isPrzemyslSwinoujscieRoute(route)) {
      out[key] = route;
      continue;
    }

    if (isPrahaWarszawaRoute(route)) {
      out[key] = route;
      continue;
    }

    const p0 = positionsForBoTTripLabel(route.trip_short_name_0, byTrainKey);
    const p1 = positionsForBoTTripLabel(route.trip_short_name_1, byTrainKey);
    const stops0 = stopsForBoTTripLabel(route.trip_short_name_0, byTrainKey);
    const stops1 = stopsForBoTTripLabel(route.trip_short_name_1, byTrainKey);
    const railSegs0 = railSegmentsForBoTTripLabel(route.trip_short_name_0, byTrainKey);
    const railSegs1 = railSegmentsForBoTTripLabel(route.trip_short_name_1, byTrainKey);
    const busSegs0 = busSegmentsForBoTTripLabel(route.trip_short_name_0, byTrainKey);
    const busSegs1Raw = busSegmentsForBoTTripLabel(route.trip_short_name_1, byTrainKey);
    // If the return direction has no bus segments but the forward direction does,
    // derive them by reversing the forward segments (e.g. IC 61170 return of IC 16170).
    const busSegs1 =
      busSegs1Raw ||
      (busSegs0
        ? busSegs0.map((s) => ({ positions: [...s.positions].reverse(), from: s.to, to: s.from }))
        : null);

    if (!p0 && !p1) {
      out[key] = route;
      continue;
    }

    out[key] = { ...route };
    if (p0) out[key].pkp_gtfs_positions_0 = p0;
    if (p1) out[key].pkp_gtfs_positions_1 = p1;
    if (railSegs0) out[key].pkp_rail_segments_0 = railSegs0.map((s) => s.positions);
    if (railSegs1) out[key].pkp_rail_segments_1 = railSegs1.map((s) => s.positions);
    if (busSegs0) out[key].pkp_bus_segments_0 = busSegs0;
    if (busSegs1) out[key].pkp_bus_segments_1 = busSegs1;

    // Override via_0 / via_1 with the full GTFS stop list so intermediate
    // stations appear when a route is selected on the map. The first stop
    // is excluded when it matches the BoT origin (avoid duplication); the
    // last stop is excluded when it matches the BoT destination.
    const buildVia = (stops, origin, destination) => {
      if (!stops || stops.length < 2) return null;
      let result = [...stops];
      const norm = (s) => (s || "").toLowerCase().trim();
      if (norm(result[0]) === norm(origin)) result = result.slice(1);
      if (result.length > 0 && norm(result[result.length - 1]) === norm(destination))
        result = result.slice(0, -1);
      return result.length > 0 ? result.join(" - ") : null;
    };

    const via0 = buildVia(stops0, route.origin_trip_0, route.destination_trip_0);
    const via1 = buildVia(stops1, route.origin_trip_1, route.destination_trip_1);
    if (via0) out[key].via_0 = via0;
    if (via1) out[key].via_1 = via1;
  }

  return out;
}
