/**
 * Builds the "all routes" path list for Back-on-Track (no OSM substitution).
 * Used for background precomputation so "Show all routes" is instant when toggled.
 */
import {
  getRouteStyleFromFrequency,
  checkEuropeanSleeper453,
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
  checkZemplinBratislavaHumenne,
  checkENHumennePraha,
  getFutureRouteStartDate,
} from "./routeStyleUtils";
import { buildRouteColorMap, NEUTRAL_FALLBACK_COLOR } from "./operatorColors";

export function buildAllRoutesPaths({
  viewMapData,
  stops,
  cities,
  trips,
  stationsToSkip,
  normalizeStationNameForLookup,
}) {
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
  // Include all routes — future ones get a ghost style and isFuture flag
  const routesToShow = Array.from(allRouteIds);
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
    if (isStationSkipped(origin) || isStationSkipped(destination)) return null;
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

  const stationKey = "all-routes";
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

    // Determine OSM relation ID(s) for routes with accurate track geometry
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
      route.via_0
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
        route.via_1
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

  return paths;
}
