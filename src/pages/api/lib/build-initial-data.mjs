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

// Source registry: declares per-source synthetic-route config (id prefix,
// agency, aliasing, dedup strategy). Bundled via ESM JSON import so the
// lambda build traces it (same pattern as station-aliases in primitives.mjs).
import SOURCE_REGISTRY from "../../../../data/sources/registry.json" with { type: "json" };

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
      filtered[key] = trip.via ? { ...trip, via: sanitizeVia(trip.via) } : trip;
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
      nj_polyline_0: data.polyline || null,
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
      entry.nj_polyline_1 = revData.polyline || null;
      paired.add(revName);
    }
    paired.add(lineName);
    viewMap[entry.route_id] = entry;
  });
}

function withPolylineAndStations([, data]) {
  return data.polyline && data.stations?.length >= 2;
}

// ─── Per-source BoT-row dedup strategies ─────────────────────────────────────
// When official operator data covers a train, the matching (stale) Back-on-Track
// row is dropped in favour of the synthetic route built from the official data.

// "exact": BoT trip_short_name matches the official train key verbatim (NJ/EN).
function dropBotRowsExact(filteredViewMap, trains) {
  const apiTrainNumbers = new Set(Object.keys(trains));
  Object.keys(filteredViewMap).forEach((key) => {
    const route = filteredViewMap[key];
    const t0 = (route?.trip_short_name_0 || "").trim();
    const t1 = (route?.trip_short_name_1 || "").trim();
    if (apiTrainNumbers.has(t0) || apiTrainNumbers.has(t1)) {
      delete filteredViewMap[key];
    }
  });
}

// "icn": BoT uses "IC Notte 770"; our data uses "ICN 770" — compare bare numbers.
function dropBotRowsIcn(filteredViewMap, trains, idPrefix) {
  const bareNumber = (n) =>
    n.replace(/^IC\s+Notte\s+/i, "").replace(/\s*\([^)]*\)$/, "").trim();
  const apiTrainNumbers = new Set(
    Object.keys(trains).map((n) => n.replace(/^ICN\s+/i, "").trim()),
  );
  Object.keys(filteredViewMap).forEach((key) => {
    if (key.startsWith(idPrefix)) return;
    const route = filteredViewMap[key];
    const t0 = bareNumber((route?.trip_short_name_0 || "").toString());
    const t1 = bareNumber((route?.trip_short_name_1 || "").toString());
    if (apiTrainNumbers.has(t0) || apiTrainNumbers.has(t1)) {
      delete filteredViewMap[key];
    }
  });
}

const DEDUP_STRATEGIES = {
  exact: (viewMap, trains) => dropBotRowsExact(viewMap, trains),
  icn: (viewMap, trains, synthetic) =>
    dropBotRowsIcn(viewMap, trains, synthetic.idPrefix),
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Merge all sources into the legacy serving payload. Per-source behaviour
 * (id prefix, agency, station aliasing, BoT dedup) comes from the registry's
 * `synthetic` config — adding an operator is a registry entry, not code here.
 *
 * @param {object} inputs
 * @param {object|Array} inputs.stops    Raw Back-on-Track stops
 * @param {object} inputs.viewMap        Raw Back-on-Track view_ontd_map
 * @param {object} inputs.trips          Raw Back-on-Track trips
 * @param {object} [inputs.operatorTrains] Trains per source id, e.g.
 *   { nightjet: { "NJ 237": {polyline, stations}, ... }, chinese: {...}, ... }
 * @param {Array}  [inputs.registry]     Source registry (defaults to bundled)
 * @returns {{ stops: Array, viewMap: object, trips: object }}
 */
export function buildInitialData({
  stops,
  viewMap,
  trips,
  operatorTrains = {},
  registry = SOURCE_REGISTRY,
} = {}) {
  const filteredTrips = filterTrips(trips);
  const filteredViewMap = filterViewMap(viewMap, trips, filteredTrips);

  const trimmedStops = normalizeStops(stops);
  const stopNameSet = new Set(
    trimmedStops.map((s) => (s.stop_id || "").toLowerCase()),
  );

  for (const entry of registry) {
    const synthetic = entry?.synthetic;
    if (!synthetic || !entry.enabled) continue;
    const trains = operatorTrains[entry.id] ?? {};

    const dedup = DEDUP_STRATEGIES[synthetic.dedupStrategy];
    if (dedup) dedup(filteredViewMap, trains, synthetic);

    if (synthetic.resolveAliases) {
      injectNJStations(trimmedStops, stopNameSet, trains);
    } else {
      injectTrainStations(trimmedStops, stopNameSet, trains);
    }

    let trainList = Object.entries(trains).filter(withPolylineAndStations);
    if (synthetic.excludeBotMatched) {
      // Only add synthetic routes for trains BoT doesn't already cover
      // (computed after dedup, so surviving BoT rows win).
      const botMatched = new Set();
      Object.values(filteredViewMap).forEach((route) => {
        [route.trip_short_name_0, route.trip_short_name_1]
          .filter(Boolean)
          .forEach((n) => botMatched.add(n.trim()));
      });
      trainList = trainList.filter(([lineName]) => !botMatched.has(lineName));
    }

    appendSyntheticRoutes(filteredViewMap, trainList, {
      idPrefix: synthetic.idPrefix,
      agency:
        synthetic.agency?.from === "data"
          ? (data) => data.agency_id || synthetic.agency.fallback
          : () => synthetic.agency?.value,
      resolveName: synthetic.resolveAliases ? resolveCanonicalStationName : identity,
      withService: !!synthetic.withService,
    });
  }

  return {
    stops: trimmedStops,
    viewMap: filteredViewMap,
    trips: filteredTrips,
  };
}
