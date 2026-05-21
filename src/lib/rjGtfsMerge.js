// Merges RJ GTFS timetable stops into Back-on-Track viewMap rows for RegioJet routes.
// Source files: public/data/gtfs/rjChopTimetable.json, rjPremyslTimetable.json
// Mirrors the pattern of pkpGtfsMerge.js.

import { resolveCanonicalStationName } from "../data/stationAliases";

function normalizeRjGtfsName(name) {
  if (!name) return name;
  return name
    .replace(/,\s*žst\.\s*$/i, "")          // "Košice, žst."          → "Košice"
    .replace(/,\s*žel\.\s*st\.\s*$/i, "")   // "Margecany, žel. st."   → "Margecany"
    .replace(/,\s*hl\.n\.\s*$/i, " hl.n.")  // "Ostrava, hl.n."        → "Ostrava hl.n."
    .replace(/,\s+/g, " ")                  // "Poprad, Tatry"         → "Poprad Tatry"
    .trim();
}

function toCanonical(rawName) {
  return resolveCanonicalStationName(normalizeRjGtfsName(rawName));
}

function buildVia(canonicalNames, origin, dest) {
  if (!canonicalNames || canonicalNames.length < 2) return null;
  let result = [...canonicalNames];
  const norm = (s) => (s || "").toLowerCase().trim();
  if (norm(result[0]) === norm(origin)) result = result.slice(1);
  if (result.length > 0 && norm(result[result.length - 1]) === norm(dest))
    result = result.slice(0, -1);
  return result.length > 0 ? result.join(" - ") : null;
}

function isChopRoute(route) {
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  const agency = (route.agency_id || "").toUpperCase();
  if (agency === "RJ" && (t0 === "1020" || t0 === "1021" || t1 === "1020" || t1 === "1021"))
    return true;
  const fields = [route.origin_trip_0, route.destination_trip_0, route.origin_trip_1, route.destination_trip_1]
    .map((f) => (f || "").toLowerCase());
  return agency === "RJ" && fields.some((f) => f.includes("praha")) && fields.some((f) => f.includes("chop") || f.includes("čop"));
}

function isPrzemyslRoute(route) {
  const t0 = (route.trip_short_name_0 || "").toString().trim();
  const t1 = (route.trip_short_name_1 || "").toString().trim();
  const agency = (route.agency_id || "").toUpperCase();
  if (agency === "RJ" && (t0 === "1038" || t0 === "1039" || t1 === "1038" || t1 === "1039"))
    return true;
  const fields = [route.origin_trip_0, route.destination_trip_0, route.origin_trip_1, route.destination_trip_1]
    .map((f) => (f || "").toLowerCase());
  return agency === "RJ" && fields.some((f) => f.includes("praha")) && fields.some((f) => f.includes("przemy"));
}

/**
 * Find the GTFS trip whose first stop (after canonicalization) matches botOrigin.
 * Falls back to the first trip in the timetable.
 * @param {{ trips: Array }} timetableData
 * @param {string} botOrigin - Canonical BoT origin station name
 * @returns {{ name: string, lat: number, lon: number }[] | null}
 */
function stopsForOrigin(timetableData, botOrigin) {
  const trips = timetableData?.trips ?? [];
  if (!trips.length) return null;
  const normOrigin = (botOrigin || "").toLowerCase().trim();
  const matched = trips.find((trip) => {
    if (!trip.stops?.length) return false;
    return toCanonical(trip.stops[0].name).toLowerCase().trim() === normOrigin;
  });
  const trip = matched ?? trips[0];
  return (trip?.stops ?? []).map((s) => ({
    name: toCanonical(s.name),
    lat: s.lat,
    lon: s.lon,
  }));
}

/**
 * Augment RJ viewMap routes with full GTFS stop lists and collect extra stops.
 *
 * @param {Record<string, object>} viewMap
 * @param {object | null} rjChopData    - parsed rjChopTimetable.json
 * @param {object | null} rjPremyslData - parsed rjPremyslTimetable.json
 * @param {Set<string>} existingStopIds - lowercase stop_ids already in stopsArray
 * @returns {{ viewMap: Record<string, object>, extraStops: object[] }}
 */
export function attachRjGtfsToViewMap(viewMap, rjChopData, rjPremyslData, existingStopIds) {
  if (!viewMap) return { viewMap, extraStops: [] };

  const out = {};
  const extraStopsMap = new Map();

  for (const key of Object.keys(viewMap)) {
    const route = viewMap[key];
    const isChop = isChopRoute(route);
    const isPrzemysl = !isChop && isPrzemyslRoute(route);

    if (!isChop && !isPrzemysl) {
      out[key] = route;
      continue;
    }

    const timetableData = isChop ? rjChopData : rjPremyslData;

    const stops0 = stopsForOrigin(timetableData, route.origin_trip_0);
    const stops1 = stopsForOrigin(timetableData, route.origin_trip_1);

    const via0 = buildVia(stops0?.map((s) => s.name), route.origin_trip_0, route.destination_trip_0);
    const via1 = buildVia(stops1?.map((s) => s.name), route.origin_trip_1, route.destination_trip_1);

    out[key] = { ...route };
    if (via0) out[key].via_0 = via0;
    if (via1) out[key].via_1 = via1;

    // Collect stops not already in stopsArray
    const allStops = [...(stops0 ?? []), ...(stops1 ?? [])];
    for (const stop of allStops) {
      if (!stop.name || existingStopIds.has(stop.name.toLowerCase())) continue;
      if (!extraStopsMap.has(stop.name)) {
        extraStopsMap.set(stop.name, {
          stop_id: stop.name,
          stop_name: stop.name,
          stop_lat: stop.lat,
          stop_lon: stop.lon,
        });
      }
    }
  }

  return { viewMap: out, extraStops: Array.from(extraStopsMap.values()) };
}
