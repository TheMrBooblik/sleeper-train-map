// Merges GTFS-derived polylines into Back-on-Track viewMap rows (PKP / PKP/ČD only).
// Bundle: public/data/gtfs/pkpTrainShapes.json from scripts/parse-pkp-gtfs.js

import { positionsForBoTTripLabel } from "./pkpTrainKeyExtract";

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
