// The stop list to show when no operator feed claims the train.
//
// TrainDetailPanel picks a schedule by looking the train number up in one of
// nine per-operator feeds. A train none of them carries — which is every
// Back-on-Track-only route, all four Norwegian night trains and SNCF's
// Intercités de Nuit among them — therefore had no stop list in the panel at
// all, while the connection page for the same train showed one, because
// src/lib/seo/data.js falls back to the row's own via names. This is that
// fallback as a shared function, so the two surfaces cannot disagree.
//
// `.mjs` and dependency-free so the raw-node suites can test it, the same
// reason operatorNames.mjs and slugify.mjs are.
import { parseViaList } from "./seo/format.js";

/**
 * Build a panel schedule from a view-map row's own via list.
 *
 * Times are only ever the endpoint times the row already carries: a via name
 * has no time attached, and inventing one would be worse than leaving it blank.
 *
 * @param {object|null|undefined} route  a viewMap row
 * @param {0|1} dir                      direction to read
 * @returns {{tripId: string, stops: Array<object>, days: string|null,
 *            validFrom: null, validUntil: null, source: "viewmap"}|null}
 *          null when the row cannot describe at least two stops, so the caller
 *          keeps rendering nothing rather than a one-stop journey.
 */
export function viaScheduleForTrip(route, dir) {
  if (!route) return null;
  const d = dir === 1 ? 1 : 0;
  const origin = route[`origin_trip_${d}`] || "";
  const destination = route[`destination_trip_${d}`] || "";
  // An enrichment may write the endpoints into via_* as well; repeating them
  // would show the origin twice.
  const middle = parseViaList(route[`via_${d}`]).filter(
    (name) => name !== origin && name !== destination,
  );
  const names = [origin, ...middle, destination].filter(Boolean);
  if (names.length < 2) return null;
  return {
    tripId: `via-${route.route_id ?? "row"}-${d}`,
    stops: names.map((name, i) => ({
      stopId: name || String(i),
      sequence: i + 1,
      name,
      arrival:
        i === names.length - 1 ? route[`destination_arrival_time_${d}`] || null : null,
      departure: i === 0 ? route[`origin_departure_time_${d}`] || null : null,
    })),
    days: route[`service_id_${d}`] || null,
    validFrom: null,
    validUntil: null,
    source: "viewmap",
  };
}
