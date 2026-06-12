// Merges GTFS-derived polylines + timetables into Back-on-Track viewMap rows
// (PKP / PKP/ČD only). Bundle: public/data/gtfs/pkpTrainShapes.json from
// scripts/parse-pkp-gtfs.js.
//
// Collisions (a reused train number matching the wrong shape) are handled
// generically: pkpEntryForRoute only returns a shape whose endpoints match the
// route's own origin/destination, so wrong-corridor shapes are skipped and the
// map falls back to OSM / static / station-coord geometry. No per-route
// hardcoding — new routes work automatically.

// Explicit extension so raw-node scripts (scripts/lib/enrich-view-map.mjs)
// can import this module too, not just the webpack bundle.
import { pkpEntryForRoute } from "./pkpTrainKeyExtract.js";

/**
 * Build the "via" string from a GTFS stop list, dropping the endpoints when
 * they duplicate the BoT origin / destination. Stops are objects ({name,...}).
 * @param {{name?: string}[]} stops
 * @param {string} origin
 * @param {string} destination
 * @returns {string | null}
 */
export function buildVia(stops, origin, destination) {
  if (!stops || stops.length < 2) return null;
  let result = stops.map((s) => s?.name).filter(Boolean);
  const norm = (s) => (s || "").toLowerCase().trim();
  if (norm(result[0]) === norm(origin)) result = result.slice(1);
  if (result.length > 0 && norm(result[result.length - 1]) === norm(destination))
    result = result.slice(0, -1);
  return result.length > 0 ? result.join(" - ") : null;
}

/**
 * @param {Record<string, object>} viewMap
 * @param {{ byTrainKey?: Record<string, object> } | null} bundle
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

    // Resolve one GTFS entry per direction, validated against that direction's
    // endpoints (rejects wrong-corridor shapes from reused train numbers).
    const e0 = pkpEntryForRoute(
      route.trip_short_name_0,
      byTrainKey,
      route.origin_trip_0,
      route.destination_trip_0,
    );
    const e1 = pkpEntryForRoute(
      route.trip_short_name_1,
      byTrainKey,
      route.origin_trip_1,
      route.destination_trip_1,
    );

    if (!e0 && !e1) {
      out[key] = route;
      continue;
    }

    out[key] = { ...route };

    if (e0?.positions?.length >= 2) out[key].pkp_gtfs_positions_0 = e0.positions;
    if (e1?.positions?.length >= 2) out[key].pkp_gtfs_positions_1 = e1.positions;
    if (e0?.rail_segments?.length)
      out[key].pkp_rail_segments_0 = e0.rail_segments.map((s) => s.positions);
    if (e1?.rail_segments?.length)
      out[key].pkp_rail_segments_1 = e1.rail_segments.map((s) => s.positions);

    const busSegs0 = e0?.bus_segments?.length ? e0.bus_segments : null;
    const busSegs1Raw = e1?.bus_segments?.length ? e1.bus_segments : null;
    // If the return direction has no bus segments but the forward direction
    // does, derive them by reversing the forward segments (e.g. IC 61170 is the
    // return of IC 16170).
    const busSegs1 =
      busSegs1Raw ||
      (busSegs0
        ? busSegs0.map((s) => ({
            positions: [...s.positions].reverse(),
            from: s.to,
            to: s.from,
          }))
        : null);
    if (busSegs0) out[key].pkp_bus_segments_0 = busSegs0;
    if (busSegs1) out[key].pkp_bus_segments_1 = busSegs1;

    // Full GTFS stop list as the "via" line so intermediate stations show when
    // a route is selected on the map.
    const via0 = buildVia(e0?.stops, route.origin_trip_0, route.destination_trip_0);
    const via1 = buildVia(e1?.stops, route.origin_trip_1, route.destination_trip_1);
    if (via0) out[key].via_0 = via0;
    if (via1) out[key].via_1 = via1;

    // Per-station timetable + service calendar for the detail panel.
    if (e0?.stops?.length) {
      out[key].pkp_schedule_0 = e0.stops;
      out[key].pkp_valid_0 = {
        validFrom: e0.validFrom,
        validUntil: e0.validUntil,
        days: e0.days,
      };
    }
    if (e1?.stops?.length) {
      out[key].pkp_schedule_1 = e1.stops;
      out[key].pkp_valid_1 = {
        validFrom: e1.validFrom,
        validUntil: e1.validUntil,
        days: e1.days,
      };
    }
  }

  return out;
}
