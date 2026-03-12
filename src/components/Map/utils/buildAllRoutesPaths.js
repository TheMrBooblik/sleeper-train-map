/**
 * Builds the "all routes" path list for Back-on-Track (no OSM substitution).
 * Used for background precomputation so "Show all routes" is instant when toggled.
 */
import { ROUTE_COLORS } from "../constants";
import {
  getRouteStyleFromFrequency,
  checkEuropeanSleeper453,
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
  checkZemplinBratislavaHumenne,
  isRegioJetRoute,
  REGIOJET_COLOR,
  ZEMPLIN_COLOR,
  PKP_COLOR,
  checkPkpKarkonosze,
  checkPkpPodhalanin,
  checkPkpUrsa,
  checkPkpUznam,
  checkPkpKarpaty,
  checkPkpPirat,
  checkPkpWolin,
  checkPkpUstronie,
  getFutureRouteStartDate,
} from "./routeStyleUtils";
import {
  STATIC_PKP_ROUTE_IDS,
  STATIC_PKP_ROUTES,
} from "./staticPkpRoutes";

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
  // Include static PKP routes that are not in API (e.g. Ustronie) so they appear when showing all routes
  STATIC_PKP_ROUTE_IDS.forEach((id) => allRouteIds.add(id));
  // Include all routes — future ones get a ghost style and isFuture flag
  const routesToShow = Array.from(allRouteIds);
  if (routesToShow.length === 0) return [];

  const routeMap = new Map();
  Object.values(viewMapData).forEach((route) => {
    if (route?.route_id) {
      routeMap.set(route.route_id.toString(), route);
    }
  });
  // Add static PKP routes so they get a path and polyline (e.g. pkpUstronie from pkpUstroniePolyline.json)
  Object.entries(STATIC_PKP_ROUTES).forEach(([id, route]) => {
    routeMap.set(id, route);
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
    return stationCoordsMap.get(n) || stationCoordsMap.get(stationName) || null;
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

  const stationKey = "all-routes";
  const paths = [];

  routesToShow.forEach((routeId) => {
    const route = routeMap.get(routeId);
    if (!route) return;

    const futureStartDate = getFutureRouteStartDate(routeId, trips);
    const isFuture = futureStartDate !== null;

    const routeColor =
      ROUTE_COLORS[parseInt(routeId, 10) % ROUTE_COLORS.length];
    // Future routes: thin dashed ghost line so they're visible but clearly distinct
    const style = isFuture
      ? { weight: 1.5, dashArray: "4,8", opacity: 0.35 }
      : getRouteStyleFromFrequency(routeId, trips);
    const pathOptions = {
      color: routeColor,
      weight: style.weight,
      opacity: style.opacity ?? 0.8,
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
    } else if (checkPkpKarkonosze(route)) {
      osmRelationId = "static:pkpKarkonosze";
    } else if (checkPkpPodhalanin(route)) {
      osmRelationId = "static:pkpPodhalanin";
    } else if (checkPkpUrsa(route)) {
      osmRelationId = "static:pkpUrsa";
    } else if (checkPkpUznam(route)) {
      osmRelationId = "static:pkpUznam";
    } else if (checkPkpKarpaty(route)) {
      osmRelationId = "static:pkpKarpaty";
    } else if (checkPkpPirat(route)) {
      osmRelationId = "static:pkpPirat";
    } else if (checkPkpWolin(route)) {
      osmRelationId = "static:pkpWolin";
    } else if (checkPkpUstronie(route)) {
      osmRelationId = "static:pkpUstronie";
    }

    // RegioJet routes use their brand color instead of the default palette
    if (isRegioJetRoute(route)) {
      pathOptions.color = REGIOJET_COLOR;
    }
    // Zemplín route uses red
    if (checkZemplinBratislavaHumenne(route)) {
      pathOptions.color = ZEMPLIN_COLOR;
    }
    // PKP Poland routes use navy blue (IC/TLK branding)
    if (
      checkPkpKarkonosze(route) ||
      checkPkpPodhalanin(route) ||
      checkPkpUrsa(route) ||
      checkPkpUznam(route) ||
      checkPkpKarpaty(route) ||
      checkPkpPirat(route) ||
      checkPkpWolin(route) ||
      checkPkpUstronie(route)
    ) {
      pathOptions.color = PKP_COLOR;
    }

    const path0 = buildPathForDirection(
      route.origin_trip_0,
      route.destination_trip_0,
      route.via_0,
    );
    const path0ToUse = path0 ?? route.fallbackPositions ?? null;
    if (path0ToUse && path0ToUse.length >= 2) {
      paths.push({
        positions: path0ToUse,
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
      const path1ToUse = path1 ?? route.fallbackPositions ?? null;
      if (path1ToUse && path1ToUse.length >= 2) {
        paths.push({
          positions: path1ToUse,
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
