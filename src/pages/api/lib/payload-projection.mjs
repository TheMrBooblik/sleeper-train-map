// api/lib/payload-projection.mjs
//
// Serve-time projections over the merged {stops, viewMap, trips} payload, in the
// same spirit as stripDisabledRoutes(): the published artifact stays complete
// (canonicalize, verify-build-parity and the SEO layer all read it whole) and
// these narrow it down to what the browser actually renders.
//
// They exist because the map's first paint used to cost 1.4 MB gzip, most of it
// data no component can reach:
//
//   - stops carried all 29 771 Back-on-Track stations, but useMapMarkers only
//     ever renders one that some route names (it drops any stop with no
//     cities[] entry), so ~94% of them were downloaded, coordinate-enriched and
//     then filtered away — 2.83 MB of the 4.65 MB payload.
//   - trips carried five columns left over from the upstream spreadsheet export
//     ("Merged Doc URL - ONTD_Chatbase_Export" and friends, plus one empty-named
//     "#N/A" column) that nothing reads — 110 KB.
//   - viewMap carried 1.05 MB of encoded polylines that the default first paint
//     does not draw at all: showRoutes starts false (Layout.js), so geometry is
//     needed only once the user turns routes on or selects a station.
//
// `.mjs` and dependency-free so tests/verify-payload-projection.mjs can run it
// under raw node against the committed payload.

import { normalizeStationNameForLookup } from "../../../lib/stationKey.mjs";
import { viaNameCandidates } from "../../../lib/viaSplit.mjs";

/** Route fields naming a single station. */
const ENDPOINT_FIELDS = [
  "origin_trip_0",
  "destination_trip_0",
  "origin_trip_1",
  "destination_trip_1",
];

/** Route fields naming " - "-joined intermediate stations. */
const VIA_FIELDS = ["via_0", "via_1"];

/** Route fields holding a PLK-sourced stop list ([{name, ...}]). */
const SCHEDULE_FIELDS = ["pkp_schedule_0", "pkp_schedule_1"];

/** Per-direction encoded polylines, moved out of the first payload. */
const GEOMETRY_FIELDS = ["nj_polyline_0", "nj_polyline_1", "nj_polyline"];

/**
 * Row fields only the static connection pages read. A fare calendar is every
 * night of six weeks per direction — worth a page, not the map's first paint.
 */
function isPageOnlyField(field) {
  return field === "fare_calendar_0" || field === "fare_calendar_1";
}

/**
 * Trip columns carried over from the upstream Back-on-Track spreadsheet export.
 * Nothing in the app, the SEO layer or the scrape pipeline reads them.
 */
function isDeadTripColumn(field) {
  return (
    field === "" ||
    field.startsWith("Merged Doc ") ||
    field.startsWith("Document Merge Status") ||
    field.startsWith("Link to merged Doc")
  );
}

/**
 * Every station name a viewMap row refers to, as lookup keys.
 * @param {Record<string, object>} viewMap
 * @returns {Set<string>}
 */
export function routeStationKeys(viewMap) {
  const keys = new Set();
  const add = (name) => {
    if (!name) return;
    const key = normalizeStationNameForLookup(name);
    if (key) keys.add(key);
  };

  for (const route of Object.values(viewMap ?? {})) {
    if (!route) continue;
    for (const field of ENDPOINT_FIELDS) add(route[field]);
    for (const field of VIA_FIELDS) {
      if (!route[field]) continue;
      // Not a plain " - " split: 437 stops have that separator inside their own
      // name, and splitting on it dropped the real station from the payload
      // entirely — "Rocamadour - Padirac" arrived as two fragments matching no
      // stop, so the browser never received the station and no amount of
      // downstream care could give it a marker. Keeping is a superset
      // operation, so every candidate reading is added and the wrong ones
      // simply match nothing.
      viaNameCandidates(route[field]).forEach(add);
    }
    for (const field of SCHEDULE_FIELDS) {
      if (!Array.isArray(route[field])) continue;
      route[field].forEach((stop) => add(stop?.name));
    }
  }

  return keys;
}

/**
 * Drop stops no route names — the ones useMapMarkers would filter out anyway.
 *
 * `extraStationNames` covers the gap left by merges that run in the browser
 * *after* this payload is built: attachPkpGtfsPolylinesToViewMap rewrites via_0
 * from the GTFS bundle's own stop list and expects to find those stations in
 * stops, so without their names here five Berlin–Warszawa corridor stops
 * (Zbąszynek, Świebodzin, Opalenica, Nowy Tomyśl, Frankfurt/Oder) would lose
 * their markers. attachRjGtfsToViewMap carries its own extraStops, so RegioJet
 * needs nothing here.
 *
 * @param {{stops?: object[], viewMap?: Record<string, object>}} payload
 * @param {Iterable<string>} [extraStationNames]
 * @returns {object} payload with a narrowed `stops`
 */
export function projectStopsToRoutes(payload, extraStationNames = []) {
  if (!payload?.stops?.length) return payload;

  const keys = routeStationKeys(payload.viewMap);
  for (const name of extraStationNames) {
    const key = normalizeStationNameForLookup(name);
    if (key) keys.add(key);
  }

  // Matched on stop_id (what useMapMarkers looks up) *and* stop_name, because
  // 703 records spell the two differently — the bilingual Belgian names, where
  // stop_id is "Mons / Bergen" and stop_name just "Mons". Keeping both costs
  // three extra records and means no consumer that reads stop_name can be
  // surprised by a station the id-side match let go.
  const stops = payload.stops.filter((stop) => {
    const id = stop?.stop_id;
    if (!id) return false;
    if (keys.has(id) || keys.has(normalizeStationNameForLookup(id))) return true;
    const name = stop.stop_name;
    return Boolean(
      name && (keys.has(name) || keys.has(normalizeStationNameForLookup(name))),
    );
  });

  return { ...payload, stops };
}

/**
 * Strip the upstream spreadsheet's bookkeeping columns from every trip.
 * @param {{trips?: Record<string, object>}} payload
 * @returns {object}
 */
export function stripDeadTripColumns(payload) {
  if (!payload?.trips) return payload;

  const trips = {};
  for (const [tripKey, trip] of Object.entries(payload.trips)) {
    if (!trip || typeof trip !== "object") {
      trips[tripKey] = trip;
      continue;
    }
    const kept = {};
    for (const [field, value] of Object.entries(trip)) {
      if (!isDeadTripColumn(field)) kept[field] = value;
    }
    trips[tripKey] = kept;
  }

  return { ...payload, trips };
}

/**
 * Drop the row fields only the connection pages read (isPageOnlyField).
 * @param {{viewMap?: Record<string, object>}} payload
 * @returns {object}
 */
export function stripPageOnlyFields(payload) {
  if (!payload?.viewMap) return payload;
  const viewMap = {};
  for (const [routeKey, route] of Object.entries(payload.viewMap)) {
    if (!route || typeof route !== "object" || !Object.keys(route).some(isPageOnlyField)) {
      viewMap[routeKey] = route;
      continue;
    }
    viewMap[routeKey] = Object.fromEntries(
      Object.entries(route).filter(([field]) => !isPageOnlyField(field)),
    );
  }
  return { ...payload, viewMap };
}

/**
 * Lift the encoded route polylines out of the payload so the map can paint
 * stations before the geometry has arrived. The client fetches the second half
 * from /api/route-geometry and merges it back in (see useInitialData).
 *
 * @param {{viewMap?: Record<string, object>}} payload
 * @returns {{payload: object, geometry: Record<string, object>}}
 */
export function splitRouteGeometry(payload) {
  if (!payload?.viewMap) return { payload, geometry: {} };

  const viewMap = {};
  const geometry = {};

  for (const [routeKey, route] of Object.entries(payload.viewMap)) {
    if (!route || typeof route !== "object") {
      viewMap[routeKey] = route;
      continue;
    }

    const stripped = {};
    const lifted = {};
    for (const [field, value] of Object.entries(route)) {
      if (GEOMETRY_FIELDS.includes(field) && value) lifted[field] = value;
      else stripped[field] = value;
    }

    viewMap[routeKey] = stripped;
    if (Object.keys(lifted).length > 0) geometry[routeKey] = lifted;
  }

  return { payload: { ...payload, viewMap }, geometry };
}

/**
 * Put geometry lifted by splitRouteGeometry() back onto the rows it came from.
 * Used by the client once /api/route-geometry lands.
 *
 * @param {Record<string, object>} viewMap
 * @param {Record<string, object>} geometry
 * @returns {Record<string, object>}
 */
export function mergeRouteGeometry(viewMap, geometry) {
  if (!viewMap || !geometry) return viewMap;

  const out = {};
  for (const [routeKey, route] of Object.entries(viewMap)) {
    const lifted = geometry[routeKey];
    out[routeKey] = lifted ? { ...route, ...lifted } : route;
  }
  return out;
}
