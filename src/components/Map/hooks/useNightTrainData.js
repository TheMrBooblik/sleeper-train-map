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
 * Returns true if the station name matches the selected filter (same logic as in loadNightTrainsForStation).
 * Used so the progressive reveal loop can keep showing only routes for the selected station when user clicks during load.
 */
function overlayMatchesStation(name, filter, normalizeStationNameForLookup) {
  if (!name || !filter) return false;
  const { normalizedStationName, originalStationName } = filter;
  if (matchStationNames(name, normalizedStationName, normalizeStationNameForLookup)) return true;
  if (originalStationName && matchStationNames(name, originalStationName, normalizeStationNameForLookup)) return true;
  const a = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = String(normalizedStationName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a && b && (a.includes(b) || b.includes(a))) return true;
  if (originalStationName) {
    const c = String(originalStationName).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (a && c && (a.includes(c) || c.includes(a))) return true;
  }
  return false;
}

/** Filter overlay list to only routes that pass through the selected station. */
function filterOverlaysByStation(overlays, filter, normalizeStationNameForLookup) {
  if (!filter || !overlays?.length) return overlays;
  const seen = new Set();
  return overlays.filter((route) => {
    const name = normalizeLineName(route.lineName);
    if (seen.has(name)) return false;
    const passes = route.stations?.some((s) => overlayMatchesStation(s?.name, filter, normalizeStationNameForLookup));
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

    (async () => {
      try {
        // Fire prewarm requests in the background — do NOT await them.
        fetch("/api/nj-prewarm?max=30", { method: "GET" }).catch(() => {});
        fetch("/api/en-prewarm", { method: "GET" }).catch(() => {});

        // Fire ALL data fetches in parallel.
        // Previously nj-list waited for nj-all-stations to finish first;
        // now they run concurrently so NJ routes appear much faster.
        setLoadingProgressImmediate(30, "Loading NightJet routes...");
        const njListPromise = fetch(`/api/nj-list?date=${date}`);
        const enListPromise = fetch(`/api/en-list?date=${date}`);
        const njStationsPromise = fetch(`/api/nj-all-stations?date=${date}`);

        // --- Phase 1: Reveal NJ routes first ---
        // NightJet routes criss-cross Germany/Austria, filling the map quickly.
        // Don't wait for EN data — start showing NJ as soon as it arrives.
        const njRes = await njListPromise;
        let njItems = [];
        if (njRes.ok) {
          const data = await njRes.json();
          njItems = data?.items ?? [];
        }

        const njOverlayList = njItems.map((item, idx) =>
          buildRouteOverlay(item, idx, NJ_COLORS, "nightjet"),
        );

        // Progressive reveal: show one route at a time with a short delay.
        // 25ms (down from 60ms) keeps the animation smooth without feeling slow.
        const REVEAL_DELAY_MS = 25;
        let shown = 0;
        const njAccum = [];

        for (const overlay of njOverlayList) {
          njAccum.push(overlay);
          setAllNjRoutes([...njAccum]);
          // When user has selected a station, re-apply station filter so new routes
          // through the station appear, but never show unrelated routes.
          if (!filterStationRef.current) {
            setNjOverlays([...njAccum]);
          } else {
            setNjOverlays((prev) => {
              const filtered = filterOverlaysByStation(njAccum, filterStationRef.current, normalizeStationNameForLookup);
              return filtered.length > 0 ? filtered : prev;
            });
          }
          shown += 1;
          setLoadingProgressImmediate(
            30 + Math.round((shown / Math.max(njItems.length, 1)) * 40),
            `NightJet route ${shown} of ${njItems.length}…`,
          );
          await new Promise((r) => setTimeout(r, REVEAL_DELAY_MS));
        }

        // --- Phase 2: Reveal EN routes (fetch should already be done by now) ---
        setLoadingProgressImmediate(72, "Loading EuroNight routes...");
        const enRes = await enListPromise;
        let enItems = [];
        if (enRes.ok) {
          const data = await enRes.json();
          enItems = data?.items ?? [];
        }

        const totalRoutes = njItems.length + enItems.length;
        if (totalRoutes === 0) {
          setLoadingProgressImmediate(100, "Ready!");
          setNightTrainsReady(true);
          setIsMapInitialized?.(true);
          setShowTooltips?.(true);
          return;
        }

        const enOverlayList = enItems.map((item, idx) =>
          buildRouteOverlay(item, idx, EN_COLORS, "euronight"),
        );

        const enAccum = [];
        for (const overlay of enOverlayList) {
          enAccum.push(overlay);
          setAllEnRoutes([...enAccum]);
          if (!filterStationRef.current) {
            setEnOverlays([...enAccum]);
          } else {
            setEnOverlays((prev) => {
              const filtered = filterOverlaysByStation(enAccum, filterStationRef.current, normalizeStationNameForLookup);
              return filtered.length > 0 ? filtered : prev;
            });
          }
          shown += 1;
          setLoadingProgressImmediate(
            72 + Math.round(((shown - njItems.length) / Math.max(enItems.length, 1)) * 26),
            `EuroNight route ${shown - njItems.length} of ${enItems.length}…`,
          );
          await new Promise((r) => setTimeout(r, REVEAL_DELAY_MS));
        }

        // --- Phase 3: Merge station data ---
        // nj-all-stations provides extra station dots not on any loaded route.
        // Handle it whenever it finishes — doesn't block the map display.
        njStationsPromise
          .then(async (stationsRes) => {
            if (!stationsRes.ok) return;
            const stationsData = await stationsRes.json();
            if (!stationsData?.stations?.length) return;

            // Merge route stations with nj-all-stations for completeness
            const stationMapNj = new Map();
            njItems.forEach((route) => {
              route.stations?.forEach((station) => {
                const key = station.id || `${station.location?.latitude}-${station.location?.longitude}`;
                if (key && station.location?.latitude && station.location?.longitude && !stationMapNj.has(key)) {
                  stationMapNj.set(key, station);
                }
              });
            });
            stationsData.stations.forEach((s) => {
              const key = s.id || `${s.location?.latitude}-${s.location?.longitude}`;
              if (key) stationMapNj.set(key, s);
            });
            setAllNjStations(Array.from(stationMapNj.values()));
            setNjLoadingProgress({
              progress: 100,
              message: `Found ${stationsData.count} stations`,
              step: "complete",
            });
          })
          .catch(() => {});

        // EN station merge
        const stationMapEn = new Map();
        enItems.forEach((route) => {
          route.stations?.forEach((station) => {
            const key = `${station.location?.latitude}-${station.location?.longitude}`;
            if (!stationMapEn.has(key)) stationMapEn.set(key, station);
          });
        });
        setAllEnStations(Array.from(stationMapEn.values()));

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

        // Only the Chopin EuroNight (EN 443 / EN 442, Praha–Warszawa) is allowed from
        // Back-on-Track. All other EN and NightJet trains from Back-on-Track are skipped.
        const CHOPIN_PATTERN = /^\s*EN\s*44[23]\b/i;

        Object.entries(routes).forEach(([routeKey, route]) => {
          const routeId = route?.route_id ?? routeKey;
          const t0 = (route?.trip_short_name_0 || "").toString();
          const t1 = (route?.trip_short_name_1 || "").toString();
          const isNj = /^\s*NJ\s*\d+/.test(t0) || /^\s*NJ\s*\d+/.test(t1);
          const isEn = /^\s*EN\s*\d+/.test(t0) || /^\s*EN\s*\d+/.test(t1);

          // Skip all NightJet from Back-on-Track (official NightJet API is used instead)
          if (isNj) return;

          // For EuroNight: only allow the Chopin train (EN 443 / EN 442)
          if (isEn && !CHOPIN_PATTERN.test(t0) && !CHOPIN_PATTERN.test(t1)) return;

          const type = isEn ? "euronight" : null;
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
          setAllNjRoutes((prev) => [...prev, ...njFallback]);
          const filter = filterStationRef.current;
          if (filter) {
            setNjOverlays((prev) => {
              const full = [...prev, ...njFallback];
              return filterOverlaysByStation(full, filter, normalizeStationNameForLookup);
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
              return filterOverlaysByStation(full, filter, normalizeStationNameForLookup);
            });
          } else {
            setEnOverlays((prev) => [...prev, ...enFallback]);
          }
        }
      } catch (err) {
        console.error("[useNightTrainData] Back-on-Track fallback failed:", err);
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

      // Fallback for production: if no routes are found in memory (e.g. cold cache on Vercel),
      // fetch station-specific routes from the API in the background and merge them.
      if (njOverlaysNext.length === 0 && enOverlaysNext.length === 0) {
        (async () => {
          try {
            const date = formatDate(new Date());
            const njRouteKeys = new Set();
            const enRouteKeys = new Set();
            const njRoutes = [];
            const enRoutes = [];

            const [njRes, enRes] = await Promise.all([
              fetch(
                `/api/nj-list?date=${date}&stationName=${encodeURIComponent(
                  normalizedStationName,
                )}`,
              ),
              fetch(
                `/api/en-list?date=${date}&stationName=${encodeURIComponent(
                  normalizedStationName,
                )}`,
              ),
            ]);

            if (njRes.ok) {
              const data = await njRes.json();
              data?.items?.forEach((item) => {
                if (!njRouteKeys.has(item.key)) {
                  njRouteKeys.add(item.key);
                  njRoutes.push(item);
                }
              });
            }
            if (enRes.ok) {
              const data = await enRes.json();
              data?.items?.forEach((item) => {
                if (!enRouteKeys.has(item.key)) {
                  enRouteKeys.add(item.key);
                  enRoutes.push(item);
                }
              });
            }

            if (njRoutes.length === 0 && enRoutes.length === 0) {
              return;
            }

            // Merge newly fetched routes into the global route lists.
            setAllNjRoutes((prev) => [...prev, ...njRoutes]);
            setAllEnRoutes((prev) => [...prev, ...enRoutes]);

            // Recompute overlays and filtered stations with updated data.
            njOverlaysNext = filterRoutesForStation(
              [...allNjRoutesRef.current, ...njRoutes],
              "nightjet",
            );
            enOverlaysNext = filterRoutesForStation(
              [...allEnRoutesRef.current, ...enRoutes],
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
            }
          } catch (e) {
            console.error("Night trains fallback fetch error", e);
          }
        })();
      }
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
