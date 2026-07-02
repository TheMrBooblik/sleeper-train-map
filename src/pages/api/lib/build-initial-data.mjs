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
// Per-route from-prices, curated through the review queue (price.update
// proposals). Stamped onto viewMap rows + trips; getOperatorPricing() picks
// the route-level record up before falling back to operator defaults.
import ROUTE_PRICES from "../../../../data/canonical/prices.json" with { type: "json" };
// Operator pricing defaults — provides the fixed/dynamic `type` half of the
// stamped record so the existing badge keeps rendering.
import OPERATOR_PRICING from "../../../../data/overrides/operator-pricing.json" with { type: "json" };
// TEMPORARY route previews: hand-authored future re-routings we want to show
// ahead of Back-on-Track publishing them (e.g. the 14-Dec European Sleeper
// 456/457 path). Each entry injects a synthetic viewMap row + trips and can
// retire the route it supersedes once its date arrives. Delete the file entry
// (and this import stays harmless with an empty array) once BoT carries it.
import FUTURE_PREVIEWS from "../../../../data/overrides/future-route-previews.json" with { type: "json" };

const identity = (name) => name;

// Inject hand-authored future route variants and, once their start date has
// arrived, hide the route they replace. The injected trips carry a
// "From YYYY-MM-DD" irregularity, so the existing client-side future-ghost
// logic fades them until the date and turns them solid afterwards — no
// render-layer changes needed. This runs AFTER the review gate so previews are
// never withheld.
function applyFutureRoutePreviews(viewMap, trips, stops, now, previews) {
  for (const preview of previews ?? []) {
    if (!preview?.id || !preview.row) continue;
    // Add the variant row + its trips (keyed so they never collide with BoT).
    viewMap[preview.id] = { ...preview.row };
    for (const [tripKey, trip] of Object.entries(preview.trips ?? {})) {
      trips[tripKey] = { ...trip };
    }
    // Hand-authored stops for via points the dataset lacks (e.g. Dutch Breda),
    // so the new calling points still render as markers. Skip names already
    // present to avoid duplicates.
    for (const stop of preview.extraStops ?? []) {
      if (!stop?.stop_id) continue;
      const exists = stops.some((s) => s.stop_id === stop.stop_id);
      if (!exists) stops.push({ ...stop });
    }
    // Informational "about this route" link, shown in the detail panel. Stamp it
    // onto both the new variant and the route it replaces (same service), so the
    // existing via-Liège line gets the link too.
    if (preview.infoUrl) {
      viewMap[preview.id].info_url = preview.infoUrl;
      const superseded = viewMap[preview.supersedesRouteId];
      if (superseded) superseded.info_url = preview.infoUrl;
    }
    // Once the new routing is live, retire the routing it replaces so the same
    // train never shows two physical paths at once.
    const startsAt = preview.activeFrom ? Date.parse(preview.activeFrom) : NaN;
    if (
      preview.supersedesRouteId &&
      Number.isFinite(startsAt) &&
      now.getTime() >= startsAt
    ) {
      const superseded = viewMap[preview.supersedesRouteId];
      if (superseded) superseded.is_active = "N";
    }
  }
}

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
// `gate` (optional) records every injected candidate and can veto unapproved
// ones — the review-queue gate for brand-new station markers.
function injectNJStations(trimmedStops, stopNameSet, njTrains, gate) {
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
    gate?.record(canonicalName);
    if (gate && !gate.isAllowed(canonicalName)) return;
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
function injectTrainStations(trimmedStops, stopNameSet, trains, gate) {
  Object.values(trains).forEach((train) => {
    (train.stations ?? []).forEach((s) => {
      if (
        !s?.name ||
        !Number.isFinite(s?.location?.latitude) ||
        !Number.isFinite(s?.location?.longitude)
      ) return;
      if (stopNameSet.has(s.name.toLowerCase())) return;
      gate?.record(s.name);
      if (gate && !gate.isAllowed(s.name)) return;
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

// Disambiguate colliding station names within one source's trains (e.g. the US
// "Vancouver, WA" vs Canada's "Vancouver"). Applied before station injection and
// route building so the injected marker and the route's derived
// origin/destination/via all use the same (renamed) name. Geometry is untouched.
function applyStationRenames(trains, renames) {
  const keys = renames && typeof renames === "object" ? Object.keys(renames) : [];
  if (keys.length === 0) return trains;
  const lower = new Map(keys.map((k) => [k.toLowerCase(), renames[k]]));
  const out = {};
  for (const [key, train] of Object.entries(trains)) {
    const stations = Array.isArray(train?.stations) ? train.stations : null;
    if (!stations) { out[key] = train; continue; }
    let changed = false;
    const renamed = stations.map((s) => {
      const to = s?.name ? lower.get(String(s.name).toLowerCase()) : null;
      if (to && to !== s.name) { changed = true; return { ...s, name: to }; }
      return s;
    });
    out[key] = changed ? { ...train, stations: renamed } : train;
  }
  return out;
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
 * @param {object} [inputs.seenIndex]    Approval index (data/canonical/state/
 *   seen.json). When provided, routes/stations not approved yet are withheld
 *   from the payload — the "verify before it goes live" gate. When null
 *   (default), everything flows: callers that can't load the index (or
 *   pre-gate callers like the parity test) must never blank the map.
 * @param {object} [inputs.stats]        Optional out-param; filled with
 *   { injectedStations: string[], stationSources: {name: sourceId},
 *   gatedRouteKeys: string[] } for the nightly classifier.
 * @returns {{ stops: Array, viewMap: object, trips: object }}
 */
export function buildInitialData({
  stops,
  viewMap,
  trips,
  operatorTrains = {},
  registry = SOURCE_REGISTRY,
  seenIndex = null,
  routePrices = ROUTE_PRICES,
  futurePreviews = FUTURE_PREVIEWS,
  now = new Date(),
  stats = null,
} = {}) {
  const filteredTrips = filterTrips(trips);
  const filteredViewMap = filterViewMap(viewMap, trips, filteredTrips);

  const trimmedStops = normalizeStops(stops);
  const stopNameSet = new Set(
    trimmedStops.map((s) => (s.stop_id || "").toLowerCase()),
  );

  // Station gate: records every injected candidate (for the classifier) and
  // withholds markers for stations the admin hasn't approved yet.
  const injectedStations = [];
  const stationSources = {};
  const injectedSeen = new Set();
  const gate = {
    record(name, sourceId) {
      if (!injectedSeen.has(name)) {
        injectedSeen.add(name);
        injectedStations.push(name);
        if (sourceId) stationSources[name] = sourceId;
      }
    },
    isAllowed(name) {
      if (!seenIndex) return true;
      return seenIndex.injectedStations?.[name]?.approved === true;
    },
  };

  for (const entry of registry) {
    const synthetic = entry?.synthetic;
    if (!synthetic || !entry.enabled) continue;
    let trains = operatorTrains[entry.id] ?? {};
    if (synthetic.stationRenames) {
      trains = applyStationRenames(trains, synthetic.stationRenames);
    }

    const dedup = DEDUP_STRATEGIES[synthetic.dedupStrategy];
    if (dedup) dedup(filteredViewMap, trains, synthetic);

    // Source attribution for the classifier's trusted-station auto-approval.
    const gateForEntry = {
      record: (name) => gate.record(name, entry.id),
      isAllowed: (name) => gate.isAllowed(name),
    };
    if (synthetic.resolveAliases) {
      injectNJStations(trimmedStops, stopNameSet, trains, gateForEntry);
    } else {
      injectTrainStations(trimmedStops, stopNameSet, trains, gateForEntry);
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

  // Review gate: withhold routes the admin hasn't approved. Keys absent from
  // the index are new tonight (the classifier runs after this and files a
  // proposal) — default-deny so nothing unreviewed reaches the map.
  const gatedRouteKeys = [];
  if (seenIndex) {
    for (const key of Object.keys(filteredViewMap)) {
      if (seenIndex.routes?.[key]?.approved !== true) {
        gatedRouteKeys.push(key);
        delete filteredViewMap[key];
      }
    }
  }

  // Per-route from-prices (review-queue curated): stamp onto the route row and
  // its trips so getOperatorPricing(routeOrTrip) resolves them route-first.
  for (const [key, price] of Object.entries(routePrices ?? {})) {
    const row = filteredViewMap[key];
    if (!row || !Number.isFinite(price?.fromPrice)) continue;
    const operatorDefault = OPERATOR_PRICING[(row.agency_id || "").trim()] ?? null;
    const pricing = {
      type: operatorDefault?.type ?? null,
      currency: price.currency ?? operatorDefault?.currency ?? "EUR",
      fromPrice: price.fromPrice,
      source: price.source ?? null,
    };
    row.pricing = pricing;
    for (const [tripKey, trip] of Object.entries(filteredTrips)) {
      if (String(trip.route_id) === String(key)) {
        // Copy — trips without a via pass through filterTrips unchanged, and
        // mutating those would leak into the caller's raw input.
        filteredTrips[tripKey] = { ...trip, pricing };
      }
    }
  }

  if (stats) {
    stats.injectedStations = injectedStations;
    stats.stationSources = stationSources;
    stats.gatedRouteKeys = gatedRouteKeys;
  }

  // Temporary hand-authored future re-routings (see import note). After the
  // gate so they always render; date-driven fade/activate is handled client-side.
  applyFutureRoutePreviews(
    filteredViewMap,
    filteredTrips,
    trimmedStops,
    now,
    futurePreviews,
  );

  return {
    stops: trimmedStops,
    viewMap: filteredViewMap,
    trips: filteredTrips,
  };
}

/**
 * Remove admin-disabled routes from an already-built payload. Applied at
 * /api/initial-data serve time (against both the published fast path and the
 * fallback merge) so toggling a route off/on in the admin Routes tab takes
 * effect on the next redeploy and is fully reversible — the published artifact
 * still carries every row, this just withholds the disabled ones per request.
 *
 * @param {{stops:Array, viewMap:object, trips:object}} payload
 * @param {string[]} disabledRouteIds  route_id keys to withhold
 * @returns {{stops:Array, viewMap:object, trips:object}} a new payload
 */
export function stripDisabledRoutes(payload, disabledRouteIds) {
  const disabled = new Set((disabledRouteIds ?? []).map(String));
  if (disabled.size === 0 || !payload) return payload;

  const viewMap = {};
  for (const [key, row] of Object.entries(payload.viewMap ?? {})) {
    if (!disabled.has(String(key))) viewMap[key] = row;
  }

  const trips = {};
  for (const [tripKey, trip] of Object.entries(payload.trips ?? {})) {
    if (!disabled.has(String(trip?.route_id))) trips[tripKey] = trip;
  }

  return { ...payload, viewMap, trips };
}
