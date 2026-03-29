"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import {
  getRouteStyleFromFrequency,
  checkEuropeanSleeper453,
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
  checkZemplinBratislavaHumenne,
  checkENHumennePraha,
  shouldHideRouteDueToFutureDate,
  getFutureRouteStartDate,
} from "../utils/routeStyleUtils";
import { buildRouteColorMap, NEUTRAL_FALLBACK_COLOR } from "../utils/operatorColors";
import { buildAllRoutesPaths } from "../utils/buildAllRoutesPaths";

// Number of leading coordinates to skip per OSM relation key.
// Some OSM relations have station approach segments at the start
// that cause visual backtracking on the map.
const OSM_TRIM_OFFSETS = {
  "18616102": 328,           // European Sleeper 453
};

function isInactiveRoute(route) {
  return (route?.is_active || "Y").toString().toUpperCase() === "N";
}

/**
 * Hook: computes Back-on-Track route paths (polylines) and fetches OSM relation data when needed.
 * Returns routePaths array and osmPolylines Map for European Sleeper 453 etc.
 * When selectedTrainRouteIds is set (e.g. after route polyline click), only those routes are shown (filter like NightJet).
 */
export function useRoutePaths({
  viewMapData,
  stops,
  cities,
  trips,
  selected,
  stopId,
  stopRouteIds,
  selectedTrainRouteIds,
  showRoutes,
  stationsToSkip,
  normalizeStationNameForLookup,
}) {
  const [osmPolylines, setOsmPolylines] = useState(new Map());
  const precomputedAllPathsRef = useRef(null);

  const routePaths = useMemo(() => {
    if (!viewMapData || !stops?.length) return [];

    const skipStationNames = new Set();
    stationsToSkip.forEach((name) => {
      skipStationNames.add(name);
      skipStationNames.add(normalizeStationNameForLookup(name));
    });
    const isStationSkipped = (name) => {
      if (!name) return false;
      return (
        skipStationNames.has(name) ||
        skipStationNames.has(normalizeStationNameForLookup(name))
      );
    };

    let routesToShow = [];
    // Include future routes in all modes — they render as ghost lines.
    // Route-click filter: show only the selected route(s), same behaviour as NightJet route click.
    if (selectedTrainRouteIds?.length > 0) {
      routesToShow = selectedTrainRouteIds;
    } else if (selected && stopRouteIds?.length > 0) {
      routesToShow = stopRouteIds;
    } else if (showRoutes && !selected) {
      const allRouteIds = new Set();
      Object.values(cities || {}).forEach((city) => {
        if (city?.stop_route_ids) {
          city.stop_route_ids.split(",").forEach((id) => {
            const rid = id.trim();
            if (rid) allRouteIds.add(rid);
          });
        }
      });
      Object.values(viewMapData).forEach((route) => {
        if (route?.route_id && !isInactiveRoute(route)) {
          allRouteIds.add(route.route_id.toString());
        }
      });
      routesToShow = Array.from(allRouteIds);
    } else {
      return [];
    }

    if (routesToShow.length === 0) return [];

    // Use precomputed "all routes" paths only when showing all routes (no station and no route filter).
    if (showRoutes && !selected && selectedTrainRouteIds?.length === 0 && precomputedAllPathsRef.current != null) {
      const basePaths = precomputedAllPathsRef.current;
      return basePaths.map((path) => {
        if (path.osmRelationId && osmPolylines.has(path.osmRelationId)) {
          let osmCoords = osmPolylines.get(path.osmRelationId);
          const trimStart = OSM_TRIM_OFFSETS[path.osmRelationId] || 0;
          if (trimStart > 0 && osmCoords?.length > trimStart) {
            osmCoords = osmCoords.slice(trimStart);
          }
          if (osmCoords?.length > 0) {
            return {
              ...path,
              positions: osmCoords,
              source: "osm",
            };
          }
        }
        return path;
      });
    }

    const routeMap = new Map();
    const stationKey = selectedTrainRouteIds?.length > 0
      ? "selected-route"
      : selected
        ? stopId || "none"
        : "all-routes";
    Object.values(viewMapData).forEach((route) => {
      if (route?.route_id && !isInactiveRoute(route)) {
        routeMap.set(route.route_id.toString(), route);
      }
    });

    const stationCoordsMap = new Map();
    const normalizedNameCache = new Map();
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    stops.forEach((stop) => {
      if (!stop.stop_id || !stop.stop_lat || !stop.stop_lon) return;
      const n = getCachedNormalizedName(stop.stop_id);
      if (!stationCoordsMap.has(n)) {
        stationCoordsMap.set(n, [stop.stop_lat, stop.stop_lon]);
      }
      if (!stationCoordsMap.has(stop.stop_id)) {
        stationCoordsMap.set(stop.stop_id, [stop.stop_lat, stop.stop_lon]);
      }
    });

    const findStationCoords = (stationName) => {
      if (!stationName) return null;
      const n = getCachedNormalizedName(stationName);
      return (
        stationCoordsMap.get(n) ||
        stationCoordsMap.get(stationName) ||
        null
      );
    };

    const buildPathForDirection = (origin, destination, viaStations) => {
      if (isStationSkipped(origin) || isStationSkipped(destination)) {
        return null;
      }
      const sequence = [];
      if (origin && !isStationSkipped(origin)) {
        const c = findStationCoords(origin);
        if (c) sequence.push(c);
      }
      if (viaStations) {
        viaStations
          .split(" - ")
          .map((s) => s.trim())
          .forEach((via) => {
            if (!isStationSkipped(via)) {
              const c = findStationCoords(via);
              if (c) sequence.push(c);
            }
          });
      }
      if (destination && !isStationSkipped(destination)) {
        const c = findStationCoords(destination);
        if (c) sequence.push(c);
      }
      return sequence.length >= 2 ? sequence : null;
    };

    // Build operator-based color map (brand colors with shade variation)
    const routeColorMap = buildRouteColorMap(routesToShow, routeMap);

    const paths = [];

    routesToShow.forEach((routeId) => {
      const route = routeMap.get(routeId);
      if (!route) return;

      const futureStartDate = getFutureRouteStartDate(routeId, trips);
      const isFuture = futureStartDate !== null;

      const routeColor = routeColorMap.get(routeId) || NEUTRAL_FALLBACK_COLOR;
      // Future routes: thin dashed ghost line so they're visible but clearly distinct
      const style = isFuture
        ? { weight: 1.5, dashArray: "4,8", opacity: 0.35 }
        : getRouteStyleFromFrequency(routeId, trips);
      const pathOptions = {
        color: routeColor,
        weight: style.weight,
        opacity: style.opacity ?? 0.92,
        dashArray: style.dashArray || undefined,
        lineCap: "round",
        lineJoin: "round",
      };

      // Determine OSM relation ID(s) for routes with accurate track geometry.
      // European Sleeper 453: single OSM relation.
      // RegioJet routes and Zemplín: pre-computed static polylines (avoids
      // double-track / scattered-approach issues in raw OSM relations).
      let osmRelationId = null;
      if (checkEuropeanSleeper453(route)) {
        osmRelationId = "18616102";
      } else if (checkRegioJetPrahaChop(route)) {
        osmRelationId = "static:rjChop";
      } else if (checkRegioJetPrahaPrzemysl(route)) {
        osmRelationId = "static:rj1038";
      } else if (checkZemplinBratislavaHumenne(route)) {
        osmRelationId = "static:zemplin";
      } else if (checkENHumennePraha(route)) {
        osmRelationId = "static:enHumenne";
      }

      const path0 = buildPathForDirection(
        route.origin_trip_0,
        route.destination_trip_0,
        route.via_0,
      );
      if (path0) {
        paths.push({
          positions: path0,
          routeId,
          key: `route-${stationKey}-${routeId}-0`,
          pathOptions,
          osmRelationId,
          isFuture,
          futureStartDate,
        });
      }

      if (route.origin_trip_1 && route.destination_trip_1) {
        const path1 = buildPathForDirection(
          route.origin_trip_1,
          route.destination_trip_1,
          route.via_1,
        );
        if (path1) {
          paths.push({
            positions: path1,
            routeId,
            key: `route-${stationKey}-${routeId}-1`,
            pathOptions,
            osmRelationId,
            isFuture,
            futureStartDate,
          });
        }
      }
    });

    // Cache "all routes" paths so next time "Show all routes" is toggled we use it instantly (only when not in route-filter mode).
    if (showRoutes && !selected && selectedTrainRouteIds?.length === 0 && paths.length > 0) {
      precomputedAllPathsRef.current = paths;
    }

    return paths.map((path) => {
      if (path.osmRelationId && osmPolylines.has(path.osmRelationId)) {
        let osmCoords = osmPolylines.get(path.osmRelationId);
        const trimStart = OSM_TRIM_OFFSETS[path.osmRelationId] || 0;
        if (trimStart > 0 && osmCoords?.length > trimStart) {
          osmCoords = osmCoords.slice(trimStart);
        }
        if (osmCoords?.length > 0) {
          return {
            ...path,
            positions: osmCoords,
            source: "osm",
          };
        }
      }
      return path;
    });
  }, [
    viewMapData,
    stops,
    cities,
    trips,
    selected,
    stopId,
    stopRouteIds,
    selectedTrainRouteIds,
    showRoutes,
    stationsToSkip,
    normalizeStationNameForLookup,
    osmPolylines,
  ]);

  // Fetch OSM relation polylines for routes that need them
  useEffect(() => {
    if (!viewMapData) return;
    const polylineKeysToFetch = new Set();
    Object.values(viewMapData).forEach((route) => {
      if (isInactiveRoute(route)) return;
      if (checkEuropeanSleeper453(route)) {
        polylineKeysToFetch.add("18616102");
      }
      if (checkRegioJetPrahaChop(route)) {
        polylineKeysToFetch.add("static:rjChop");
      }
      if (checkRegioJetPrahaPrzemysl(route)) {
        polylineKeysToFetch.add("static:rj1038");
      }
      if (checkZemplinBratislavaHumenne(route)) {
        polylineKeysToFetch.add("static:zemplin");
      }
      if (checkENHumennePraha(route)) {
        polylineKeysToFetch.add("static:enHumenne");
      }
    });
    polylineKeysToFetch.forEach(async (key) => {
      if (osmPolylines.has(key)) return;
      try {
        // Static polylines are stored as pre-computed JSON files in /data/
        const url = key.startsWith("static:")
          ? `/data/${key.replace("static:", "")}Polyline.json`
          : `/api/osm-relation?relationId=${key}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          // Static files are a plain coordinate array; API responses wrap in { coordinates }
          const coords = Array.isArray(data) ? data : data.coordinates;
          if (coords?.length > 0) {
            setOsmPolylines((prev) => {
              const next = new Map(prev);
              next.set(key, coords);
              return next;
            });
          }
        }
      } catch (error) {
        console.error(
          `[DynamicMap] Failed to fetch polyline ${key}:`,
          error,
        );
      }
    });
  }, [viewMapData, osmPolylines]);

  // Precompute "all routes" paths as soon as data is loaded so "Show all routes" is instant (like selected-station routes)
  useEffect(() => {
    if (!viewMapData || !stops?.length) return;
    precomputedAllPathsRef.current = null;
    // Run synchronously so cache is ready before user can toggle; loading overlay still visible so no perceived delay
    const paths = buildAllRoutesPaths({
      viewMapData,
      stops,
      cities,
      trips,
      stationsToSkip,
      normalizeStationNameForLookup,
    });
    if (paths.length > 0) {
      precomputedAllPathsRef.current = paths;
    }
  }, [
    viewMapData,
    stops,
    cities,
    trips,
    stationsToSkip,
    normalizeStationNameForLookup,
  ]);

  return { routePaths, osmPolylines };
}
