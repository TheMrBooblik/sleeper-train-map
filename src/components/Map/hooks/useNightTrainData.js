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
 * Build overlay from Back-on-Track route + stops. Used when official NJ/EN API is missing a train.
 * Uses normalizeStationNameForLookup so station names match the rest of the app (e.g. "Bruxelles Midi / Brussel Zuid" → "Bruxelles Midi").
 * Returns null if we cannot resolve enough stations to draw a path.
 */
function buildOverlayFromBackOnTrackRoute(route, routeId, trips, stops, type, colorIndex, colors, normalizeStationNameForLookup) {
  if (!stops?.length || !route) return null;

  const normLookup = typeof normalizeStationNameForLookup === "function" ? normalizeStationNameForLookup : (s) => s;

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
  const lineName = (trip?.trip_short_name || trip?.route_short_name || routeId || "?").toString().trim();
  if (!lineName) return null;

  // Build station sequence: try direction 0 first (origin_trip_0, via_0, destination_trip_0),
  // then direction 1 if direction 0 yields fewer than 2 points (e.g. different station names resolve)
  const buildSequence = (origin, dest, viaStr) => {
    const viaList = (viaStr || "").toString().trim() ? (viaStr || "").split(" - ").map((s) => s.trim()).filter(Boolean) : [];
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
        stations.push({ name: n, location: { latitude: c[0], longitude: c[1] } });
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
  njOverlaysRef.current = njOverlays;
  enOverlaysRef.current = enOverlays;
  allNjRoutesRef.current = allNjRoutes;
  allEnRoutesRef.current = allEnRoutes;

  // One-time initial load of NightJet + EuroNight data
  useEffect(() => {
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;
    const date = formatDate(new Date());

    (async () => {
      try {
        setLoadingProgressImmediate(35, "Prewarming NightJet & EuroNight...");
        await Promise.all([
          fetch("/api/nj-prewarm?max=30", { method: "GET" }),
          fetch("/api/en-prewarm", { method: "GET" }),
        ]);

        setLoadingProgressImmediate(45, "Loading NightJet stations...");
        let njStationsFromApi = [];
        const progressInterval = setInterval(async () => {
          try {
            const progressRes = await fetch(
              `/api/nj-all-stations?progress=true&date=${date}`,
            );
            if (progressRes.ok) {
              const progress = await progressRes.json();
              setNjLoadingProgress(progress);
              const p = progress?.progress;
              if (typeof p === "number") {
                setLoadingProgressImmediate(45 + (p / 100) * 30, progress?.message);
              }
            }
          } catch (err) {
            console.error("[DEBUG] Failed to fetch progress:", err);
          }
        }, 800);

        try {
          const njStationsRes = await fetch(
            `/api/nj-all-stations?date=${date}&_t=${Date.now()}`,
            { cache: "no-store" },
          );
          clearInterval(progressInterval);

          if (njStationsRes.ok) {
            const stationsData = await njStationsRes.json();
            if (stationsData?.stations?.length) {
              njStationsFromApi = stationsData.stations;
              setAllNjStations(stationsData.stations);
              setLoadingProgressImmediate(75, `NightJet: ${stationsData.count} stations`);
              setNjLoadingProgress({
                progress: 100,
                message: `Found ${stationsData.count} stations`,
                step: "complete",
              });
            } else {
              setNjLoadingProgress({
                progress: 0,
                message: "No stations found",
                step: "complete",
              });
            }
          } else {
            setNjLoadingProgress({
              progress: 0,
              message: "Failed to load stations",
              step: "error",
            });
          }
        } catch (err) {
          clearInterval(progressInterval);
          setNjLoadingProgress({
            progress: 0,
            message: `Error: ${err.message}`,
            step: "error",
          });
        }

        setLoadingProgressImmediate(80, "Loading NightJet routes...");
        const njRes = await fetch(`/api/nj-list?date=${date}`);
        if (njRes.ok) {
          const data = await njRes.json();
          if (data?.items?.length) {
            const routes = data.items.map((item, idx) =>
              buildRouteOverlay(item, idx, NJ_COLORS, "nightjet"),
            );
            setAllNjRoutes(routes);
            setNjOverlays(routes);
            const stationMap = new Map();
            njStationsFromApi.forEach((s) => {
              const key = s.id || `${s.location?.latitude}-${s.location?.longitude}`;
              if (key) stationMap.set(key, s);
            });
            data.items.forEach((route) => {
              route.stations?.forEach((station) => {
                const key =
                  station.id ||
                  `${station.location?.latitude}-${station.location?.longitude}`;
                if (key && station.location?.latitude && station.location?.longitude && !stationMap.has(key)) {
                  stationMap.set(key, station);
                }
              });
            });
            const merged = Array.from(stationMap.values());
            if (merged.length > njStationsFromApi.length) setAllNjStations(merged);
          }
        }

        setLoadingProgressImmediate(90, "Loading EuroNight routes...");
        const enRes = await fetch(`/api/en-list?date=${date}`);
        if (enRes.ok) {
          const data = await enRes.json();
          if (data?.items?.length) {
            const routes = data.items.map((item, idx) =>
              buildRouteOverlay(item, idx, EN_COLORS, "euronight"),
            );
            setAllEnRoutes(routes);
            setEnOverlays(routes);
            const stationMap = new Map();
            data.items.forEach((route) => {
              route.stations?.forEach((station) => {
                const key = `${station.location?.latitude}-${station.location?.longitude}`;
                if (!stationMap.has(key)) stationMap.set(key, station);
              });
            });
            setAllEnStations(Array.from(stationMap.values()));
          }
        }

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
  }, [
    setLoadingProgressImmediate,
    setIsMapInitialized,
    setShowTooltips,
  ]);

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

        Object.entries(routes).forEach(([routeKey, route]) => {
          const routeId = route?.route_id ?? routeKey;
          const t0 = (route?.trip_short_name_0 || "").toString();
          const t1 = (route?.trip_short_name_1 || "").toString();
          const isNj = /^\s*NJ\s*\d+/.test(t0) || /^\s*NJ\s*\d+/.test(t1);
          const isEn = /^\s*EN\s*\d+/.test(t0) || /^\s*EN\s*\d+/.test(t1);
          const type = isNj ? "nightjet" : isEn ? "euronight" : null;
          if (!type) return;

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
          setNjOverlays((prev) => [...prev, ...njFallback]);
          setAllNjRoutes((prev) => [...prev, ...njFallback]);
        }
        if (enFallback.length > 0) {
          setEnOverlays((prev) => [...prev, ...enFallback]);
          setAllEnRoutes((prev) => [...prev, ...enFallback]);
        }
      } catch (err) {
        console.error("[useNightTrainData] Back-on-Track fallback failed:", err);
        backOnTrackMergeDoneRef.current = false;
      }
    })();
  }, [nightTrainsReady, stops, normalizeStationNameForLookup]);

  const loadNightTrainsForStation = useCallback(
    async (normalizedStationName, originalStationName = null) => {
      try {
        const date = formatDate(new Date());
        const njRouteKeys = new Set();
        const enRouteKeys = new Set();
        const njRoutes = [];
        const enRoutes = [];

        const [njRes1, enRes1] = await Promise.all([
          fetch(
            `/api/nj-list?date=${date}&stationName=${encodeURIComponent(normalizedStationName)}`,
          ),
          fetch(
            `/api/en-list?date=${date}&stationName=${encodeURIComponent(normalizedStationName)}`,
          ),
        ]);

        if (njRes1.ok) {
          const data = await njRes1.json();
          data?.items?.forEach((item) => {
            if (!njRouteKeys.has(item.key)) {
              njRouteKeys.add(item.key);
              njRoutes.push(item);
            }
          });
        }
        if (enRes1.ok) {
          const data = await enRes1.json();
          data?.items?.forEach((item) => {
            if (!enRouteKeys.has(item.key)) {
              enRouteKeys.add(item.key);
              enRoutes.push(item);
            }
          });
        }

        if (
          originalStationName &&
          originalStationName !== normalizedStationName
        ) {
          const [njRes2, enRes2] = await Promise.all([
            fetch(
              `/api/nj-list?date=${date}&stationName=${encodeURIComponent(originalStationName)}`,
            ),
            fetch(
              `/api/en-list?date=${date}&stationName=${encodeURIComponent(originalStationName)}`,
            ),
          ]);
          if (njRes2.ok) {
            const data = await njRes2.json();
            data?.items?.forEach((item) => {
              if (!njRouteKeys.has(item.key)) {
                njRouteKeys.add(item.key);
                njRoutes.push(item);
              }
            });
          }
          if (enRes2.ok) {
            const data = await enRes2.json();
            data?.items?.forEach((item) => {
              if (!enRouteKeys.has(item.key)) {
                enRouteKeys.add(item.key);
                enRoutes.push(item);
              }
            });
          }
        }

        // Fallback: fetch all and filter client-side
        if (njRoutes.length === 0 && enRoutes.length === 0) {
          const routePassesThrough = (route, _name) => {
            if (!route?.stations?.length) return false;
            return route.stations.some((station) => {
              const name = station?.name || "";
              if (matchStationNames(name, normalizedStationName, normalizeStationNameForLookup))
                return true;
              if (
                originalStationName &&
                matchStationNames(name, originalStationName, normalizeStationNameForLookup)
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
            });
          };

          const [njResAll, enResAll] = await Promise.all([
            fetch(`/api/nj-list?date=${date}`),
            fetch(`/api/en-list?date=${date}`),
          ]);
          if (njResAll.ok) {
            const data = await njResAll.json();
            data?.items?.forEach((item) => {
              if (routePassesThrough(item) && !njRouteKeys.has(item.key)) {
                njRouteKeys.add(item.key);
                njRoutes.push(item);
              }
            });
          }
          if (enResAll.ok) {
            const data = await enResAll.json();
            data?.items?.forEach((item) => {
              if (routePassesThrough(item) && !enRouteKeys.has(item.key)) {
                enRouteKeys.add(item.key);
                enRoutes.push(item);
              }
            });
          }
        }

        const matchesStation = (name) => {
          if (!name) return false;
          if (matchStationNames(name, normalizedStationName, normalizeStationNameForLookup))
            return true;
          if (
            originalStationName &&
            matchStationNames(name, originalStationName, normalizeStationNameForLookup)
          )
            return true;
          return false;
        };

        let njOverlaysNext = njRoutes.map((item, idx) =>
          buildRouteOverlay(item, idx, NJ_COLORS, "nightjet"),
        );
        let enOverlaysNext = enRoutes.map((item, idx) =>
          buildRouteOverlay(item, idx, EN_COLORS, "euronight"),
        );

        // Include Back-on-Track fallback routes that pass through this station
        // (they exist in allNjRoutes/allEnRoutes but are not returned by the API for this station)
        const njNames = new Set(njOverlaysNext.map((o) => normalizeLineName(o.lineName)));
        const enNames = new Set(enOverlaysNext.map((o) => normalizeLineName(o.lineName)));
        allNjRoutesRef.current.forEach((overlay) => {
          if (njNames.has(normalizeLineName(overlay.lineName))) return;
          const passes = overlay.stations?.some((s) => matchesStation(s?.name));
          if (passes) {
            njNames.add(normalizeLineName(overlay.lineName));
            njOverlaysNext = [...njOverlaysNext, overlay];
          }
        });
        allEnRoutesRef.current.forEach((overlay) => {
          if (enNames.has(normalizeLineName(overlay.lineName))) return;
          const passes = overlay.stations?.some((s) => matchesStation(s?.name));
          if (passes) {
            enNames.add(normalizeLineName(overlay.lineName));
            enOverlaysNext = [...enOverlaysNext, overlay];
          }
        });

        setNjOverlays(njOverlaysNext);
        setEnOverlays(enOverlaysNext);

        if (njOverlaysNext.length > 0) {
          const njStationMap = new Map();
          njOverlaysNext.forEach((overlay) => {
            const idx = overlay.stations?.findIndex((s) => matchesStation(s.name));
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
            const idx = overlay.stations?.findIndex((s) => matchesStation(s.name));
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
      } catch (e) {
        console.error("Night trains fetch error", e);
        setNjOverlays([]);
        setEnOverlays([]);
      }
    },
    [normalizeStationNameForLookup, setFilteredStops],
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
