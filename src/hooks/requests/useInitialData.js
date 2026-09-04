import { useEffect, useState, useCallback, useRef } from "react";
import { enrichStationsWithCoordinates } from "../../helpers/enrichStationsWithCoordinates";
import { stationCoordinates } from "../../data/stationCoordinates";
import { normalizeStationNameForLookup } from "./useCities";
import { attachPkpGtfsPolylinesToViewMap } from "../../lib/pkpGtfsMerge";
import { hydratePkpBundle } from "../../lib/pkpTrainKeyExtract";
import { attachRjGtfsToViewMap } from "../../lib/rjGtfsMerge";
import { mergeRouteGeometry } from "../../pages/api/lib/payload-projection.mjs";
import {
  applyReplacementsToRouteData,
  applyReplacementsToTrips,
} from "../../data/stationNameReplacements";

// Module-level cache: shared across all component instances, 1 hour TTL.
// `inFlight` holds the promises rather than only their results, so a second
// mount joins the request already running instead of starting its own — React
// 18 strict mode mounts every component twice, which was costing a duplicate
// copy of the whole payload on every page load.
const CACHE_DURATION = 60 * 60 * 1000;
const cache = { data: null, timestamp: null, inFlight: { core: null, enrichments: null } };

/** Run `fn`, sharing one in-flight promise per slot across concurrent callers. */
function once(slot, fn) {
  if (!cache.inFlight[slot]) {
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        // Only clear our own slot: a refresh may have replaced it meanwhile.
        if (cache.inFlight[slot] === promise) cache.inFlight[slot] = null;
      });
    cache.inFlight[slot] = promise;
  }
  return cache.inFlight[slot];
}

/**
 * Derive city-to-route mapping from viewMap data.
 * Same logic as useCities but without a separate fetch.
 */
function deriveCities(mapData) {
  const cityRouteMap = {};
  if (!mapData) return cityRouteMap;

  // First pass: origins and destinations are main stations
  Object.values(mapData).forEach((route) => {
    if (!route?.route_id) return;
    const routeId = route.route_id.toString();

    [
      route.origin_trip_0,
      route.destination_trip_0,
      route.origin_trip_1,
      route.destination_trip_1,
    ]
      .filter(Boolean)
      .forEach((station) => {
        const normalized = normalizeStationNameForLookup(station);
        if (!cityRouteMap[normalized]) {
          cityRouteMap[normalized] = {
            stop_id: normalized,
            stop_route_ids: routeId,
            isMainStation: true,
            isViaStation: false,
          };
        } else {
          cityRouteMap[normalized].stop_route_ids += `,${routeId}`;
          cityRouteMap[normalized].isMainStation = true;
          cityRouteMap[normalized].isViaStation = false;
        }
      });
  });

  // Second pass: via stations (only if not already a main station)
  Object.values(mapData).forEach((route) => {
    if (!route?.route_id) return;
    const routeId = route.route_id.toString();

    [route.via_0, route.via_1].forEach((viaStr) => {
      if (!viaStr) return;
      viaStr
        .split(" - ")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((viaStation) => {
          const normalized = normalizeStationNameForLookup(viaStation);
          if (!cityRouteMap[normalized]) {
            cityRouteMap[normalized] = {
              stop_id: normalized,
              stop_route_ids: routeId,
              isViaStation: true,
              isMainStation: false,
            };
          } else {
            cityRouteMap[normalized].stop_route_ids += `,${routeId}`;
            if (!cityRouteMap[normalized].isMainStation) {
              cityRouteMap[normalized].isViaStation = true;
            }
          }
        });
    });
  });

  return cityRouteMap;
}

/**
 * The one request the map cannot paint without: stations, route rows and trips.
 * Route geometry and the GTFS bundles are deliberately NOT part of it — see
 * fetchEnrichments().
 */
async function fetchCore() {
  const res = await fetch("/api/initial-data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetch and parse a JSON asset, or null — enrichments must never be fatal. */
async function fetchOptionalJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[useInitialData] ${url} unavailable:`, e);
    return null;
  }
}

/**
 * Everything the map can improve itself with *after* it is already on screen:
 * the encoded route polylines (~1.05 MB, and showRoutes starts false anyway)
 * plus the PKP and RegioJet GTFS bundles. Fetched as one background stage so a
 * visitor on a slow connection sees stations in one round trip instead of
 * waiting on ~2.5 MB of everything.
 */
async function fetchEnrichments() {
  const [geometry, pkpBundle, rjChop, rjPremysl] = await Promise.all([
    fetchOptionalJson("/api/route-geometry"),
    fetchOptionalJson("/data/gtfs/pkpTrainShapes.json"),
    fetchOptionalJson("/data/gtfs/rjChopTimetable.json"),
    fetchOptionalJson("/data/gtfs/rjPremyslTimetable.json"),
  ]);
  return { geometry, pkpBundle, rjChop, rjPremysl };
}

/**
 * Build the hook's state from the core payload and whatever enrichments have
 * arrived. Pure and total: called once with `{}` for the first paint, then
 * again with the background stage's results.
 *
 * @param {{stops?: object[]|object, viewMap?: object, trips?: object}} core
 * @param {{geometry?: object, pkpBundle?: object, rjChop?: object, rjPremysl?: object}} enrichments
 */
function assemble(core, enrichments = {}) {
  const { geometry, pkpBundle, rjChop, rjPremysl } = enrichments;

  let viewMapRaw = core.viewMap || {};

  // Geometry first: the PKP merge reads and overwrites polyline fields.
  if (geometry) viewMapRaw = mergeRouteGeometry(viewMapRaw, geometry);

  if (pkpBundle) {
    try {
      viewMapRaw = attachPkpGtfsPolylinesToViewMap(
        viewMapRaw,
        hydratePkpBundle(pkpBundle),
      );
    } catch (e) {
      console.warn("[useInitialData] PKP GTFS merge failed:", e);
    }
  }

  // Process stops: convert to array + enrich with coordinates (same as useStops)
  let stopsArray = Array.isArray(core.stops)
    ? core.stops
    : Object.values(core.stops || {});
  stopsArray = enrichStationsWithCoordinates(stopsArray, stationCoordinates);

  // Merge RJ GTFS into viewMap: enriches via lists and adds missing stop records.
  if (rjChop && rjPremysl) {
    try {
      const existingIds = new Set(
        stopsArray.map((s) => (s.stop_id || "").toLowerCase()),
      );
      const { viewMap: rjViewMap, extraStops } = attachRjGtfsToViewMap(
        viewMapRaw,
        rjChop,
        rjPremysl,
        existingIds,
      );
      viewMapRaw = rjViewMap;
      stopsArray = [...stopsArray, ...extraStops];
    } catch (e) {
      console.warn("[useInitialData] RJ GTFS merge failed:", e);
    }
  }

  // BoT sometimes names the wrong terminus (Leo Express Frankfurt
  // Flughafen vs Süd). Rewrite before cities and booking see the names.
  viewMapRaw = applyReplacementsToRouteData(viewMapRaw);
  const tripsRaw = applyReplacementsToTrips(core.trips || {}, viewMapRaw);

  return {
    stops: stopsArray,
    cities: deriveCities(viewMapRaw),
    viewMapData: viewMapRaw,
    trips: tripsRaw,
  };
}

/**
 * Combined hook: one request paints the map, a second background stage upgrades
 * it with route geometry and the GTFS bundles.
 * Replaces useStops + useCities + useViewMap + useTrips.
 */
export function useInitialData() {
  const [stops, setStops] = useState([]);
  const [filteredStops, setFilteredStops] = useState([]);
  const [cities, setCities] = useState({});
  const [viewMapData, setViewMapData] = useState({});
  const [trips, setTrips] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  // Guards the background stage against a unmount mid-flight (React 18 strict
  // mode runs the effect twice) and against a refresh overtaking it.
  const generationRef = useRef(0);

  const apply = useCallback((assembled) => {
    setStops(assembled.stops);
    setFilteredStops(assembled.stops);
    setCities(assembled.cities);
    setViewMapData(assembled.viewMapData);
    setTrips(assembled.trips);
  }, []);

  const load = useCallback(
    async ({ useCache }) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const isCurrent = () => generationRef.current === generation;

      const now = Date.now();
      if (
        useCache &&
        cache.data &&
        cache.timestamp &&
        now - cache.timestamp < CACHE_DURATION
      ) {
        apply(cache.data.assembled);
        setIsLoading(false);
        // A cached core with no enrichments yet means an earlier visit was cut
        // short; finish the background stage rather than leaving it unpainted.
        if (cache.data.enriched) return;
      } else {
        setIsLoading(true);
        try {
          const core = await once("core", fetchCore);
          if (!isCurrent()) return;
          const assembled = assemble(core);
          cache.data = { core, assembled, enriched: false };
          cache.timestamp = now;
          apply(assembled);
        } catch (err) {
          console.error("[useInitialData] Error:", err);
          if (!isCurrent()) return;
          setStops([]);
          setFilteredStops([]);
          setCities({});
          setViewMapData({});
          setTrips({});
          setIsLoading(false);
          return;
        }
        // The map is usable from here on; the rest only makes it better.
        setIsLoading(false);
      }

      const enrichments = await once("enrichments", fetchEnrichments);
      if (!isCurrent() || !cache.data) return;
      const assembled = assemble(cache.data.core, enrichments);
      cache.data = { ...cache.data, assembled, enriched: true };
      apply(assembled);
    },
    [apply],
  );

  useEffect(() => {
    load({ useCache: true });
  }, [load]);

  const refreshData = useCallback(async () => {
    cache.data = null;
    cache.timestamp = null;
    // Drop any shared promise so a refresh really re-fetches rather than
    // resolving to the response the previous load is already waiting on.
    cache.inFlight = { core: null, enrichments: null };
    await load({ useCache: false });
  }, [load]);

  return {
    stops,
    filteredStops,
    setFilteredStops,
    cities,
    viewMapData,
    trips,
    isLoading,
    refreshData,
  };
}
