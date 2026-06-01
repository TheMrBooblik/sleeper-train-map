// lib/build-initial-data.mjs
// Pure merge of all night-train sources into the legacy { stops, viewMap, trips }
// payload served by /api/initial-data. Extracted verbatim from the former
// in-route logic so the live API and the build-time canonicalize script
// (scripts/canonicalize.mjs) share one code path — output is identical by
// construction. ESM/.mjs so raw `node` can run it; no external dependencies.

import {
  isActiveRecord,
  isTrain4you,
  resolveCanonicalStationName,
  routeIdsReferencedInTrips,
  routeIdsFromFilteredTrips,
  keepViewMapRowForTripActivity,
} from "./primitives.mjs";

const identity = (name) => name;

// ─── Operator filtering ──────────────────────────────────────────────────────

// NJ/EN are kept here so they render as Back-on-Track routes initially; the
// client filters them out once official NightJet/EuroNight data loads.
function filterTrips(data) {
  const filtered = {};
  Object.entries(data || {}).forEach(([key, trip]) => {
    if (!isActiveRecord(trip)) return;
    const tripName = (
      trip?.trip_short_name ||
      trip?.route_short_name ||
      ""
    ).toString();
    const isT4y = isTrain4you(trip, tripName);
    if (!isT4y) {
      filtered[key] = trip;
    }
  });
  return filtered;
}

// BoT source data misspells the Polish city "Katowice" as "Katovice" in some
// via fields. "Katovice" (Czech village near Písek) resolves to wrong coordinates
// and wrong display text. Fix both by substituting at the data level.
function sanitizeVia(str) {
  if (!str) return str;
  return str.replace(/\bKatovice\b/g, "Katowice");
}

// view_ontd_map rows often lack is_active; trips.json is authoritative per
// service. If every trip for a route_id is inactive (filtered out), hide the row.
function filterViewMap(data, rawTrips, filteredTrips) {
  const referencedIds = routeIdsReferencedInTrips(rawTrips);
  const visibleIds = routeIdsFromFilteredTrips(filteredTrips);
  const filtered = {};
  Object.entries(data || {}).forEach(([key, route]) => {
    if (!isActiveRecord(route)) return;
    const trip0 = (route?.trip_short_name_0 || "").toString();
    const trip1 = (route?.trip_short_name_1 || "").toString();
    const isT4y = isTrain4you(route, trip0) || isTrain4you(route, trip1);
    const rowOk = !isT4y;
    if (
      !keepViewMapRowForTripActivity(
        rowOk,
        route?.route_id,
        referencedIds,
        visibleIds,
      )
    ) {
      return;
    }
    filtered[key] = {
      ...route,
      via_0: sanitizeVia(route.via_0),
      via_1: sanitizeVia(route.via_1),
    };
  });
  return filtered;
}

// ─── Stops ─────────────────────────────────────────────────────────────────

function normalizeStops(rawStops) {
  const stopsArray = Array.isArray(rawStops)
    ? rawStops
    : Object.values(rawStops || {});
  return stopsArray.map((s) => ({
    stop_id: s.stop_id,
    stop_name: s.stop_name,
    stop_lat: s.stop_lat,
    stop_lon: s.stop_lon,
  }));
}

// NightJet stations: keyed by exact name (first occurrence), stored under their
// canonical Back-on-Track name so synthetic routes reference NJ coordinates.
function injectNJStations(trimmedStops, stopNameSet, njTrains) {
  const njStationsByName = new Map();
  Object.values(njTrains).forEach((train) => {
    (train.stations ?? []).forEach((s) => {
      if (
        s?.name &&
        Number.isFinite(s?.location?.latitude) &&
        Number.isFinite(s?.location?.longitude) &&
        !njStationsByName.has(s.name)
      ) {
        njStationsByName.set(s.name, s);
      }
    });
  });
  njStationsByName.forEach((njStation) => {
    const canonicalName = resolveCanonicalStationName(njStation.name);
    if (stopNameSet.has(canonicalName.toLowerCase())) return;
    trimmedStops.push({
      stop_id: canonicalName,
      stop_name: canonicalName,
      stop_lat: njStation.location.latitude,
      stop_lon: njStation.location.longitude,
    });
    stopNameSet.add(canonicalName.toLowerCase());
  });
}

// Generic station injection (raw names) for CR / Italian / Caucasus trains.
function injectTrainStations(trimmedStops, stopNameSet, trains) {
  Object.values(trains).forEach((train) => {
    (train.stations ?? []).forEach((s) => {
      if (
        !s?.name ||
        !Number.isFinite(s?.location?.latitude) ||
        !Number.isFinite(s?.location?.longitude)
      ) return;
      if (stopNameSet.has(s.name.toLowerCase())) return;
      trimmedStops.push({
        stop_id: s.name,
        stop_name: s.name,
        stop_lat: s.location.latitude,
        stop_lon: s.location.longitude,
      });
      stopNameSet.add(s.name.toLowerCase());
    });
  });
}

// ─── Synthetic routes ────────────────────────────────────────────────────────

// Builds synthetic view_ontd_map rows from a list of [lineName, data] trains
// with decoded polylines, pairing each direction with its reverse where found.
// Shared by NJ, Chinese, Italian and Caucasus sources; per-source differences
// are passed as options.
function appendSyntheticRoutes(
  viewMap,
  trainList,
  { idPrefix, agency, resolveName, withService = false },
) {
  const paired = new Set();
  trainList.forEach(([lineName, data]) => {
    if (paired.has(lineName)) return;
    const origin = resolveName(data.stations[0].name);
    const dest = resolveName(data.stations[data.stations.length - 1].name);
    const reversePair = trainList.find(
      ([k, v]) =>
        k !== lineName &&
        !paired.has(k) &&
        resolveName(v.stations?.[0]?.name) === dest &&
        resolveName(v.stations?.[v.stations.length - 1]?.name) === origin,
    );
    const safeId = lineName.replace(/\s+/g, "_");
    const entry = {
      route_id: `${idPrefix}${safeId}`,
      agency_id: agency(data),
      trip_short_name_0: lineName,
      origin_trip_0: origin,
      destination_trip_0: dest,
      via_0: data.stations
        .slice(1, -1)
        .map((s) => resolveName(s.name))
        .filter(Boolean)
        .join(" - "),
      route_long_name: `${origin} – ${dest}`,
      ...(withService ? { service_id_0: data.frequency || null } : {}),
      nj_polyline: data.polyline,
      is_active: "Y",
    };
    if (reversePair) {
      const [revName, revData] = reversePair;
      entry.trip_short_name_1 = revName;
      entry.origin_trip_1 = resolveName(revData.stations[0].name);
      entry.destination_trip_1 = resolveName(
        revData.stations[revData.stations.length - 1].name,
      );
      entry.via_1 = revData.stations
        .slice(1, -1)
        .map((s) => resolveName(s.name))
        .filter(Boolean)
        .join(" - ");
      if (withService) entry.service_id_1 = revData.frequency || null;
      paired.add(revName);
    }
    paired.add(lineName);
    viewMap[entry.route_id] = entry;
  });
}

function withPolylineAndStations([, data]) {
  return data.polyline && data.stations?.length >= 2;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Merge all sources into the legacy serving payload.
 * @param {object} inputs
 * @param {object|Array} inputs.stops    Raw Back-on-Track stops
 * @param {object} inputs.viewMap        Raw Back-on-Track view_ontd_map
 * @param {object} inputs.trips          Raw Back-on-Track trips
 * @param {object} [inputs.njTrains]     NightJet/EuroNight trains keyed by line
 * @param {object} [inputs.crTrains]     Chinese Railway trains
 * @param {object} [inputs.itTrains]     Italian (Trenitalia ICN) trains
 * @param {object} [inputs.caucasusTrains] Caucasus trains
 * @returns {{ stops: Array, viewMap: object, trips: object }}
 */
export function buildInitialData({
  stops,
  viewMap,
  trips,
  njTrains = {},
  crTrains = {},
  itTrains = {},
  caucasusTrains = {},
} = {}) {
  const filteredTrips = filterTrips(trips);
  const filteredViewMap = filterViewMap(viewMap, trips, filteredTrips);

  const trimmedStops = normalizeStops(stops);
  const stopNameSet = new Set(
    trimmedStops.map((s) => (s.stop_id || "").toLowerCase()),
  );

  // ── NightJet / EuroNight ────────────────────────────────────────────────
  injectNJStations(trimmedStops, stopNameSet, njTrains);

  // BoT station lists for NJ/EN are stale; drop them in favour of synthetic
  // routes built from accurate NJ API data below.
  const njApiTrainNumbers = new Set(Object.keys(njTrains));
  Object.keys(filteredViewMap).forEach((key) => {
    const route = filteredViewMap[key];
    const t0 = (route?.trip_short_name_0 || "").trim();
    const t1 = (route?.trip_short_name_1 || "").trim();
    if (njApiTrainNumbers.has(t0) || njApiTrainNumbers.has(t1)) {
      delete filteredViewMap[key];
    }
  });

  const botMatchedNJNumbers = new Set();
  Object.values(filteredViewMap).forEach((route) => {
    [route.trip_short_name_0, route.trip_short_name_1]
      .filter(Boolean)
      .forEach((n) => botMatchedNJNumbers.add(n.trim()));
  });
  const unmatchedNJ = Object.entries(njTrains).filter(
    ([lineName, data]) =>
      !botMatchedNJNumbers.has(lineName) &&
      data.polyline &&
      data.stations?.length >= 2,
  );
  appendSyntheticRoutes(filteredViewMap, unmatchedNJ, {
    idPrefix: "nj_standalone_",
    agency: () => "ÖBB",
    resolveName: resolveCanonicalStationName,
  });

  // ── Chinese Railway (CR) ──────────────────────────────────────────────────
  injectTrainStations(trimmedStops, stopNameSet, crTrains);
  appendSyntheticRoutes(
    filteredViewMap,
    Object.entries(crTrains).filter(withPolylineAndStations),
    { idPrefix: "cr_", agency: () => "CR", resolveName: identity },
  );

  // ── Italian Railways (Trenitalia ICN) ─────────────────────────────────────
  // BoT uses "IC Notte 770"; our data uses "ICN 770" — normalise to bare number.
  const icnApiTrainNumbers = new Set(
    Object.keys(itTrains).map((n) => n.replace(/^ICN\s+/i, "").trim()),
  );
  Object.keys(filteredViewMap).forEach((key) => {
    if (key.startsWith("icn_")) return;
    const route = filteredViewMap[key];
    const t0 = (route?.trip_short_name_0 || "")
      .replace(/^IC\s+Notte\s+/i, "")
      .replace(/\s*\([^)]*\)$/, "")
      .trim();
    const t1 = (route?.trip_short_name_1 || "")
      .replace(/^IC\s+Notte\s+/i, "")
      .replace(/\s*\([^)]*\)$/, "")
      .trim();
    if (icnApiTrainNumbers.has(t0) || icnApiTrainNumbers.has(t1)) {
      delete filteredViewMap[key];
    }
  });
  injectTrainStations(trimmedStops, stopNameSet, itTrains);
  appendSyntheticRoutes(
    filteredViewMap,
    Object.entries(itTrains).filter(withPolylineAndStations),
    { idPrefix: "icn_", agency: () => "FS", resolveName: identity },
  );

  // ── Caucasus Railways (GR, ADY, SCR) ──────────────────────────────────────
  injectTrainStations(trimmedStops, stopNameSet, caucasusTrains);
  appendSyntheticRoutes(
    filteredViewMap,
    Object.entries(caucasusTrains).filter(withPolylineAndStations),
    {
      idPrefix: "caucasus_",
      agency: (data) => data.agency_id || "GR",
      resolveName: identity,
      withService: true,
    },
  );

  return {
    stops: trimmedStops,
    viewMap: filteredViewMap,
    trips: filteredTrips,
  };
}
