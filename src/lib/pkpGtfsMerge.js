// Merges GTFS-derived polylines into Back-on-Track viewMap rows (PKP / PKP/ČD only).
// Bundle: public/data/gtfs/pkpTrainShapes.json from scripts/parse-pkp-gtfs.js

import { positionsForBoTTripLabel } from "./pkpTrainKeyExtract";

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

    if (!p0 && !p1) {
      out[key] = route;
      continue;
    }

    out[key] = { ...route };
    if (p0) out[key].pkp_gtfs_positions_0 = p0;
    if (p1) out[key].pkp_gtfs_positions_1 = p1;
  }

  return out;
}
