"use client";

import { useMemo, useState, useEffect } from "react";
import { ROUTE_COLORS } from "../constants";
import {
  getRouteStyleFromFrequency,
  checkEuropeanSleeper453,
  shouldHideRouteDueToFutureDate,
} from "../utils/routeStyleUtils";

/**
 * Hook: computes Back-on-Track route paths (polylines) and fetches OSM relation data when needed.
 * Returns routePaths array and osmPolylines Map for European Sleeper 453 etc.
 */
export function useRoutePaths({
  viewMapData,
  stops,
  cities,
  trips,
  selected,
  stopId,
  stopRouteIds,
  showRoutes,
  stationsToSkip,
  normalizeStationNameForLookup,
}) {
  const [osmPolylines, setOsmPolylines] = useState(new Map());

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
    if (selected && stopRouteIds?.length > 0) {
      routesToShow = stopRouteIds.filter(
        (routeId) => !shouldHideRouteDueToFutureDate(routeId, trips),
      );
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
        if (route?.route_id) allRouteIds.add(route.route_id.toString());
      });
      routesToShow = Array.from(allRouteIds).filter(
        (routeId) => !shouldHideRouteDueToFutureDate(routeId, trips),
      );
    } else {
      return [];
    }

    if (routesToShow.length === 0) return [];

    const routeMap = new Map();
    Object.values(viewMapData).forEach((route) => {
      if (route?.route_id) {
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

    const stationKey = selected ? stopId || "none" : "all-routes";
    const paths = [];

    routesToShow.forEach((routeId) => {
      const route = routeMap.get(routeId);
      if (!route) return;

      const routeColor = ROUTE_COLORS[parseInt(routeId, 10) % ROUTE_COLORS.length];
      const style = getRouteStyleFromFrequency(routeId, trips);
      const pathOptions = {
        color: routeColor,
        weight: style.weight,
        opacity: style.opacity ?? 0.8,
        dashArray: style.dashArray || undefined,
        lineCap: "round",
        lineJoin: "round",
      };

      const useOsm = checkEuropeanSleeper453(route);
      const osmRelationId = useOsm ? "18616102" : null;

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
          });
        }
      }
    });

    return paths.map((path) => {
      if (path.osmRelationId && osmPolylines.has(path.osmRelationId)) {
        let osmCoords = osmPolylines.get(path.osmRelationId);
        if (osmCoords?.length > 328) {
          osmCoords = osmCoords.slice(328);
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
    showRoutes,
    stationsToSkip,
    normalizeStationNameForLookup,
    osmPolylines,
  ]);

  // Fetch OSM relation polylines for routes that need them (e.g. European Sleeper 453)
  useEffect(() => {
    if (!viewMapData) return;
    const relationIdsToFetch = new Set();
    Object.values(viewMapData).forEach((route) => {
      if (checkEuropeanSleeper453(route)) {
        relationIdsToFetch.add("18616102");
      }
    });
    relationIdsToFetch.forEach(async (relationId) => {
      if (osmPolylines.has(relationId)) return;
      try {
        const res = await fetch(`/api/osm-relation?relationId=${relationId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.coordinates?.length > 0) {
            setOsmPolylines((prev) => {
              const next = new Map(prev);
              next.set(relationId, data.coordinates);
              return next;
            });
          }
        }
      } catch (error) {
        console.error(
          `[DynamicMap] Failed to fetch OSM relation ${relationId}:`,
          error,
        );
      }
    });
  }, [viewMapData, osmPolylines]);

  return { routePaths, osmPolylines };
}
