"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import polyline from "@mapbox/polyline";
import { NJ_COLORS, EN_COLORS } from "../constants";
import { matchStationNames } from "../utils/stationNameUtils";

/**
 * Formats date as YYYY-MM-DD for API calls.
 */
function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// --- localStorage cache for NJ/EN route items ---
// Keyed by date so stale data is automatically replaced.
const CACHE_KEY = "nighttrain-routes";

/** Read cached NJ/EN items from localStorage. Returns null on miss or error. */
function readRouteCache(date) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (cached?.date !== date) return null;
    if (!cached.njItems?.length && !cached.enItems?.length) return null;
    return cached;
  } catch {
    return null;
  }
}

/** Write NJ/EN items to localStorage cache. Silently ignores quota errors. */
function writeRouteCache(date, njItems, enItems) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ date, njItems, enItems, cachedAt: Date.now() }),
    );
  } catch {
    // localStorage full or unavailable — not critical
  }
}

/**
 * Decodes polyline and returns coords array; falls back to item.coords on error.
 */
function decodeCoords(item, label) {
  let coords = item.coords;
  if (item.polyline) {
    try {
      coords = polyline.decode(item.polyline);
    } catch (e) {
      console.error(`Failed to decode ${label} polyline:`, e);
    }
  }
  return coords;
}

/**
 * Builds a route overlay object for NightJet or EuroNight.
 */
function buildRouteOverlay(item, idx, colors, type) {
  return {
    key: item.key,
    lineName: item.lineName,
    coords: decodeCoords(item, type === "nightjet" ? "Nightjet" : "EuroNight"),
    stations: item.stations,
    color: colors[idx % colors.length],
    type,
  };
}

/** Normalize line name for comparison (e.g. "NJ 123" vs "NJ123"). */
function normalizeLineName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Returns true if the station name matches the selected filter (same logic as in loadNightTrainsForStation).
 * Used so the progressive reveal loop can keep showing only routes for the selected station when user clicks during load.
 */
function overlayMatchesStation(name, filter, normalizeStationNameForLookup) {
  if (!name || !filter) return false;
  const { normalizedStationName, originalStationName } = filter;
  if (
    matchStationNames(
      name,
      normalizedStationName,
      normalizeStationNameForLookup,
    )
  )
    return true;
  if (
    originalStationName &&
    matchStationNames(name, originalStationName, normalizeStationNameForLookup)
  )
    return true;
  const a = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const b = String(normalizedStationName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (a && b && (a.includes(b) || b.includes(a))) return true;
  if (originalStationName) {
    const c = String(originalStationName)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (a && c && (a.includes(c) || c.includes(a))) return true;
  }
  return false;
}

/** Filter overlay list to only routes that pass through the selected station. */
function filterOverlaysByStation(
  overlays,
  filter,
  normalizeStationNameForLookup,
) {
  if (!filter || !overlays?.length) return overlays;
  const seen = new Set();
  return overlays.filter((route) => {
    const name = normalizeLineName(route.lineName);
    if (seen.has(name)) return false;
    const passes = route.stations?.some((s) =>
      overlayMatchesStation(s?.name, filter, normalizeStationNameForLookup),
    );
    if (!passes) return false;
    seen.add(name);
    return true;
  });
}

/**
 * Build overlay from Back-on-Track route + stops. Used when official NJ/EN API is missing a train.
 * Uses normalizeStationNameForLookup so station names match the rest of the app (e.g. "Bruxelles Midi / Brussel Zuid" → "Bruxelles Midi").
 * Returns null if we cannot resolve enough stations to draw a path.
 */
function buildOverlayFromBackOnTrackRoute(
  route,
  routeId,
  trips,
  stops,
  type,
  colorIndex,
  colors,
  normalizeStationNameForLookup,
) {
  if (!stops?.length || !route) return null;

  const normLookup =
    typeof normalizeStationNameForLookup === "function"
      ? normalizeStationNameForLookup
      : (s) => s;

  // Build station name -> coords lookup from stops. Index by stop_id, stop_name, and normalized forms
  // so we match Back-on-Track names like "Bruxelles Midi / Brussel Zuid" via normalizeStationNameForLookup.
  const coordsByKey = new Map();
  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  stops.forEach((stop) => {
    if (stop.stop_lat == null || stop.stop_lon == null) return;
    const key = [stop.stop_lat, stop.stop_lon];
    const ids = [
      stop.stop_id,
      stop.stop_name,
      normalize(stop.stop_id),
      stop.stop_name && normalize(stop.stop_name),
      normLookup(stop.stop_id),
      stop.stop_name && normLookup(stop.stop_name),
    ].filter(Boolean);
    ids.forEach((id) => {
      if (!coordsByKey.has(id)) coordsByKey.set(id, key);
    });
  });
  const findCoords = (name) => {
    if (!name) return null;
    const n = name.trim();
    return (
      coordsByKey.get(n) ||
      coordsByKey.get(normalize(n)) ||
      coordsByKey.get(normLookup(n)) ||
      null
    );
  };

  // Get line name from first trip for this route
  const trip = Object.values(trips || {}).find(
    (t) => String(t?.route_id) === String(routeId),
  );
  const lineName = (
    trip?.trip_short_name ||
    trip?.route_short_name ||
    routeId ||
    "?"
  )
    .toString()
    .trim();
  if (!lineName) return null;

  // Build station sequence: try direction 0 first (origin_trip_0, via_0, destination_trip_0),
  // then direction 1 if direction 0 yields fewer than 2 points (e.g. different station names resolve)
  const buildSequence = (origin, dest, viaStr) => {
    const viaList = (viaStr || "").toString().trim()
      ? (viaStr || "")
          .split(" - ")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return [origin, ...viaList, dest].filter(Boolean);
  };
  let names = buildSequence(
    (route.origin_trip_0 || "").toString().trim(),
    (route.destination_trip_0 || "").toString().trim(),
    route.via_0,
  );
  let coords = [];
  let stations = [];
  for (const n of names) {
    const c = findCoords(n);
    if (c) {
      coords.push(c);
      stations.push({ name: n, location: { latitude: c[0], longitude: c[1] } });
    }
  }
  if (coords.length < 2 && route.origin_trip_1 && route.destination_trip_1) {
    names = buildSequence(
      (route.origin_trip_1 || "").toString().trim(),
      (route.destination_trip_1 || "").toString().trim(),
      route.via_1,
    );
    coords = [];
    stations = [];
    for (const n of names) {
      const c = findCoords(n);
      if (c) {
        coords.push(c);
        stations.push({
          name: n,
          location: { latitude: c[0], longitude: c[1] },
        });
      }
    }
  }
  if (coords.length < 2) return null;

  return {
    key: `backontrack-${routeId}-${lineName.replace(/\s+/g, "")}`,
    lineName,
    coords,
    stations,
    color: colors[colorIndex % colors.length],
    type,
    source: "backontrack",
  };
}

/**
 * Hook: NightJet and EuroNight state, initial loading, and loadNightTrainsForStation.
 * Runs loading once on mount; progress/ready callbacks are passed in.
 * Optional `stops`: when provided, missing NJ/EN routes are filled from Back-on-Track as fallback.
 */
export function useNightTrainData({
  setLoadingProgressImmediate,
  setIsMapInitialized,
  setShowTooltips,
  normalizeStationNameForLookup,
  setFilteredStops,
  stops = [],
}) {
  const [njOverlays, setNjOverlays] = useState([]);
  const [enOverlays, setEnOverlays] = useState([]);
  const [allNjStations, setAllNjStations] = useState([]);
  const [allEnStations, setAllEnStations] = useState([]);
  const [filteredNjStations, setFilteredNjStations] = useState([]);
  const [filteredEnStations, setFilteredEnStations] = useState([]);
  const [allNjRoutes, setAllNjRoutes] = useState([]);
  const [allEnRoutes, setAllEnRoutes] = useState([]);
  const [njLoadingProgress, setNjLoadingProgress] = useState({
    progress: 0,
    message: "",
    step: "",
  });
  const [nightTrainsReady, setNightTrainsReady] = useState(false);
  const loadStartedRef = useRef(false);
  const njOverlaysRef = useRef([]);
  const enOverlaysRef = useRef([]);
  const allNjRoutesRef = useRef([]);
  const allEnRoutesRef = useRef([]);
  /** When user clicks a station during loading, we keep showing only routes for that station instead of all. */
  const filterStationRef = useRef(null);
  njOverlaysRef.current = njOverlays;
  enOverlaysRef.current = enOverlays;
  allNjRoutesRef.current = allNjRoutes;
  allEnRoutesRef.current = allEnRoutes;

  // One-time initial load of NightJet + EuroNight data
  useEffect(() => {
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;
    const date = formatDate(new Date());

    /** Apply fetched NJ/EN items: build overlays, merge stations, mark ready. */
    const applyItems = (njItems, enItems) => {
      const njOverlayList = njItems.map((item, idx) =>
        buildRouteOverlay(item, idx, NJ_COLORS, "nightjet"),
      );
      const enOverlayList = enItems.map((item, idx) =>
        buildRouteOverlay(item, idx, EN_COLORS, "euronight"),
      );

      setAllNjRoutes(njOverlayList);
      setAllEnRoutes(enOverlayList);
      if (!filterStationRef.current) {
        setNjOverlays(njOverlayList);
        setEnOverlays(enOverlayList);
      }

      // EN station merge
      const stationMapEn = new Map();
      enItems.forEach((route) => {
        route.stations?.forEach((station) => {
          const key = `${station.location?.latitude}-${station.location?.longitude}`;
          if (!stationMapEn.has(key)) stationMapEn.set(key, station);
        });
      });
      setAllEnStations(Array.from(stationMapEn.values()));
    };

    // NightJet API is disabled for now.
    // We keep the "fetchFromApi" shape so the rest of the hook stays small,
    // but we never call /api/nj-* or /api/en-* (which would hit the upstream).
    const fetchFromApi = async () => {
      return { njItems: [], enItems: [] };
    };

    (async () => {
      try {
        // --- Check localStorage cache first ---
        // On repeat visits (same day), routes appear instantly with no loading.
        const cached = readRouteCache(date);

        if (cached) {
          // Cache hit — show all routes at once, no progressive reveal needed.
          setLoadingProgressImmediate(90, "Restoring cached routes...");
          applyItems(cached.njItems, cached.enItems);
          setLoadingProgressImmediate(100, "Ready!");
          setNightTrainsReady(true);
          setIsMapInitialized?.(true);
          setShowTooltips?.(true);
          return;
        }

        // --- Cache miss: fetch NJ/EN data and apply all at once ---
        // Back-on-Track initial-data already shows NJ/EN routes as placeholders,
        // so no progressive reveal needed — just replace when official data arrives.
        setLoadingProgressImmediate(35, "Loading NightJet & EuroNight routes...");
        // NightJet API disabled. The hook's Back-on-Track merge effect below
        // populates the night overlays.

        setLoadingProgressImmediate(100, "Ready!");
        setNightTrainsReady(true);
        setIsMapInitialized?.(true);
        setShowTooltips?.(true);
      } catch (err) {
        console.error("[DEBUG] Error loading night train data:", err);
        setNightTrainsReady(true);
        setIsMapInitialized?.(true);
        setShowTooltips?.(true);
      }
    })();
  }, [setLoadingProgressImmediate, setIsMapInitialized, setShowTooltips]);

  // Fallback: when official NJ/EN data is missing some trains, add them from Back-on-Track
  const backOnTrackMergeDoneRef = useRef(false);
  useEffect(() => {
    if (!nightTrainsReady || !stops?.length) return;
    // Only run merge once we have both night trains and stops; do not mark done until merge completes
    // so that if this ran with empty stops first, we retry when stops load
    if (backOnTrackMergeDoneRef.current) return;
    backOnTrackMergeDoneRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/night-trains-backontrack");
        if (!res.ok) {
          backOnTrackMergeDoneRef.current = false;
          return;
        }
        const { routes, trips } = await res.json();
        if (!routes || Object.keys(routes).length === 0) {
          return;
        }

        const existingNjNames = new Set(
          njOverlaysRef.current.map((o) => normalizeLineName(o.lineName)),
        );
        const existingEnNames = new Set(
          enOverlaysRef.current.map((o) => normalizeLineName(o.lineName)),
        );

        let njFallback = [];
        let enFallback = [];
        let njIdx = existingNjNames.size;
        let enIdx = existingEnNames.size;

        // Use all NJ and EN trains from Back-on-Track as fallback.
        // The official NightJet nj-booking-ocp API was decommissioned (March 2026),
        // so Back-on-Track is now the primary data source for NJ/EN routes.
        // Trains already loaded from the official API (if it comes back) are
        // deduplicated via existingNjNames / existingEnNames.
        Object.entries(routes).forEach(([routeKey, route]) => {
          const routeId = route?.route_id ?? routeKey;
          const t0 = (route?.trip_short_name_0 || "").toString();
          const t1 = (route?.trip_short_name_1 || "").toString();
          const isNj = /^\s*NJ\s*\d+/.test(t0) || /^\s*NJ\s*\d+/.test(t1);
          const isEn = /^\s*EN\s*\d+/.test(t0) || /^\s*EN\s*\d+/.test(t1);

          if (!isNj && !isEn) return;

          const type = isNj ? "nightjet" : "euronight";

          const overlay = buildOverlayFromBackOnTrackRoute(
            route,
            routeId,
            trips,
            stops,
            type,
            type === "nightjet" ? njIdx : enIdx,
            type === "nightjet" ? NJ_COLORS : EN_COLORS,
            normalizeStationNameForLookup,
          );
          if (!overlay) return;

          const name = normalizeLineName(overlay.lineName);
          if (type === "nightjet" && !existingNjNames.has(name)) {
            existingNjNames.add(name);
            njFallback.push(overlay);
            njIdx += 1;
          } else if (type === "euronight" && !existingEnNames.has(name)) {
            existingEnNames.add(name);
            enFallback.push(overlay);
            enIdx += 1;
          }
        });

        if (njFallback.length > 0) {
          setAllNjRoutes((prev) => [...prev, ...njFallback]);
          const filter = filterStationRef.current;
          if (filter) {
            setNjOverlays((prev) => {
              const full = [...prev, ...njFallback];
              return filterOverlaysByStation(
                full,
                filter,
                normalizeStationNameForLookup,
              );
            });
          } else {
            setNjOverlays((prev) => [...prev, ...njFallback]);
          }
        }
        if (enFallback.length > 0) {
          setAllEnRoutes((prev) => [...prev, ...enFallback]);
          const filter = filterStationRef.current;
          if (filter) {
            setEnOverlays((prev) => {
              const full = [...prev, ...enFallback];
              return filterOverlaysByStation(
                full,
                filter,
                normalizeStationNameForLookup,
              );
            });
          } else {
            setEnOverlays((prev) => [...prev, ...enFallback]);
          }
        }
      } catch (err) {
        console.error(
          "[useNightTrainData] Back-on-Track fallback failed:",
          err,
        );
        backOnTrackMergeDoneRef.current = false;
      }
    })();
  }, [nightTrainsReady, stops, normalizeStationNameForLookup]);

  const loadNightTrainsForStation = useCallback(
    (normalizedStationName, originalStationName = null) => {
      // Remember filter so the progressive reveal loop (if still running) only shows routes for this station.
      // Clear filter when no station (e.g. parent wants to show all routes again).
      filterStationRef.current =
        normalizedStationName != null && normalizedStationName !== ""
          ? { normalizedStationName, originalStationName }
          : null;

      const matchesStation = (name) => {
        if (!name) return false;
        if (
          matchStationNames(
            name,
            normalizedStationName,
            normalizeStationNameForLookup,
          )
        )
          return true;
        if (
          originalStationName &&
          matchStationNames(
            name,
            originalStationName,
            normalizeStationNameForLookup,
          )
        )
          return true;
        const a = name.toLowerCase().replace(/[^a-z0-9]/g, "");
        const b = normalizedStationName.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (a.includes(b) || b.includes(a)) return true;
        if (originalStationName) {
          const c = originalStationName.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (a.includes(c) || c.includes(a)) return true;
        }
        return false;
      };

      const filterRoutesForStation = (routes, type) => {
        const seen = new Set();
        const result = [];
        routes.forEach((route) => {
          const name = normalizeLineName(route.lineName);
          if (seen.has(name)) return;
          const passes = route.stations?.some((s) => matchesStation(s?.name));
          if (!passes) return;
          seen.add(name);
          result.push(
            route.coords && route.stations
              ? route
              : buildRouteOverlay(
                  route,
                  result.length,
                  type === "nightjet" ? NJ_COLORS : EN_COLORS,
                  type,
                ),
          );
        });
        return result;
      };

      let njOverlaysNext = filterRoutesForStation(
        allNjRoutesRef.current,
        "nightjet",
      );
      let enOverlaysNext = filterRoutesForStation(
        allEnRoutesRef.current,
        "euronight",
      );

      setNjOverlays(njOverlaysNext);
      setEnOverlays(enOverlaysNext);

      if (njOverlaysNext.length > 0) {
        const njStationMap = new Map();
        njOverlaysNext.forEach((overlay) => {
          const idx = overlay.stations?.findIndex((s) =>
            matchesStation(s.name),
          );
          if (idx !== -1 && overlay.stations) {
            overlay.stations.forEach((station) => {
              const key = `${station.location?.latitude}-${station.location?.longitude}`;
              if (!njStationMap.has(key)) njStationMap.set(key, station);
            });
          }
        });
        setFilteredNjStations(Array.from(njStationMap.values()));
      } else {
        setFilteredNjStations([]);
      }

      if (enOverlaysNext.length > 0) {
        const enStationMap = new Map();
        enOverlaysNext.forEach((overlay) => {
          const idx = overlay.stations?.findIndex((s) =>
            matchesStation(s.name),
          );
          if (idx !== -1 && overlay.stations) {
            overlay.stations.forEach((station) => {
              const key = `${station.location?.latitude}-${station.location?.longitude}`;
              if (!enStationMap.has(key)) enStationMap.set(key, station);
            });
          }
        });
        setFilteredEnStations(Array.from(enStationMap.values()));
      } else {
        setFilteredEnStations([]);
      }

      // NightJet API disabled for now, so we do not fetch station-specific
      // routes from /api/nj-list or /api/en-list here.
    },
    [normalizeStationNameForLookup],
  );

  return {
    njOverlays,
    setNjOverlays,
    enOverlays,
    setEnOverlays,
    allNjStations,
    allEnStations,
    filteredNjStations,
    setFilteredNjStations,
    filteredEnStations,
    setFilteredEnStations,
    allNjRoutes,
    setAllNjRoutes,
    allEnRoutes,
    setAllEnRoutes,
    njLoadingProgress,
    nightTrainsReady,
    loadNightTrainsForStation,
  };
}
