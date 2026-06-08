/**
 * Builds the "all routes" path list for Back-on-Track (no OSM substitution).
 * Used for background precomputation so "Show all routes" is instant when toggled.
 */
import {
  getRouteStyleFromFrequency,
  checkEuropeanSleeper453,
  checkPrahaWarszawaChopin,
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
  checkZemplinBratislavaHumenne,
  isRegioJetRoute,
  REGIOJET_COLOR,
  ZEMPLIN_COLOR,
  PKP_COLOR,
  PKP_BUS_COLOR,
  isPkpAgencyRoute,
  checkENHumennePraha,
  checkPrzemyslSwinoujscie,
  checkWarszawaBudapestRoute,
  getFutureRouteStartDate,
  isRouteOutsideServiceIdSeason,
} from "./routeStyleUtils";
import { buildRouteColorMap, NEUTRAL_FALLBACK_COLOR } from "./operatorColors";
import { parseCoord } from "../../../helpers/enrichStationsWithCoordinates";
import polyline from "@mapbox/polyline";

function isInactiveRoute(route) {
  return (route?.is_active || "Y").toString().toUpperCase() === "N";
}

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
    if (route?.route_id && !isInactiveRoute(route)) {
      allRouteIds.add(route.route_id.toString());
    }
  });
  // Include all routes — future ones get a ghost style and isFuture flag
  const routesToShow = Array.from(allRouteIds);
  if (routesToShow.length === 0) return [];

  const routeMap = new Map();
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
    if (!stop.stop_id) return;
    // Must reject non-numeric coords (API junk strings are truthy and break Leaflet LatLng).
    const lat = parseCoord(stop.stop_lat);
    const lon = parseCoord(stop.stop_lon);
    if (lat == null || lon == null) return;
    const n = getCachedNormalizedName(stop.stop_id);
    // Prefer stops whose stop_id exactly equals the normalized key so that a
    // canonical stop (e.g. "Katowice", Poland) is not shadowed by an earlier
    // stop that merely normalises to the same key (e.g. "Katovice", Czech village).
    if (!stationCoordsMap.has(n) || stop.stop_id === n) {
      stationCoordsMap.set(n, [lat, lon]);
    }
    if (!stationCoordsMap.has(stop.stop_id)) {
      stationCoordsMap.set(stop.stop_id, [lat, lon]);
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

  // Build operator-based color map (brand colors with shade variation)
  const routeColorMap = buildRouteColorMap(routesToShow, routeMap);

  const stationKey = "all-routes";
  const paths = [];

  routesToShow.forEach((routeId) => {
    const route = routeMap.get(routeId);
    if (!route) return;

    if (isRouteOutsideServiceIdSeason(routeId, trips)) {
      return;
    }

    const futureStartDate = getFutureRouteStartDate(routeId, trips);
    const isFuture = futureStartDate !== null;

    const routeColor = routeColorMap.get(routeId) || NEUTRAL_FALLBACK_COLOR;
    const style = getRouteStyleFromFrequency(routeId, trips);
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
    } else if (checkPrahaWarszawaChopin(route)) {
      osmRelationId = "8737075";
    } else if (checkRegioJetPrahaChop(route)) {
      osmRelationId = "static:rjChop";
    } else if (checkRegioJetPrahaPrzemysl(route)) {
      osmRelationId = "static:rj1038";
    } else if (checkZemplinBratislavaHumenne(route)) {
      osmRelationId = "static:zemplin";
    } else if (checkENHumennePraha(route)) {
      osmRelationId = "static:enHumenne";
    } else if (checkPrzemyslSwinoujscie(route)) {
      osmRelationId = "static:przemyslSwinoujscie";
    } else if (checkWarszawaBudapestRoute(route)) {
      osmRelationId = "3779843";
    }

    // RegioJet routes use their brand color instead of the default palette
    if (isRegioJetRoute(route)) {
      pathOptions.color = REGIOJET_COLOR;
    }
    // Zemplín route uses red
    if (checkZemplinBratislavaHumenne(route)) {
      pathOptions.color = ZEMPLIN_COLOR;
    }
    if (isPkpAgencyRoute(route)) {
      pathOptions.color = PKP_COLOR;
    }

    // Official NJ/EN polyline takes precedence over station-name-based coords
    if (route.nj_polyline) {
      paths.push({
        positions: polyline.decode(route.nj_polyline),
        routeId,
        key: `route-${stationKey}-${routeId}-0`,
        pathOptions,
        osmRelationId: null,
        isFuture,
        futureStartDate,
        source: "nightjet",
      });
    } else {
      const gtfs0 =
        route.pkp_gtfs_positions_0?.length >= 2
          ? route.pkp_gtfs_positions_0
          : null;
      const path0 = buildPathForDirection(
        route.origin_trip_0,
        route.destination_trip_0,
        route.via_0,
      );
      const path0ToUse = gtfs0 ?? path0 ?? route.fallbackPositions ?? null;

      const railSegs0 = route.pkp_rail_segments_0;
      const segsToRender0 =
        railSegs0?.length >= 1 ? railSegs0 : path0ToUse ? [path0ToUse] : [];
      segsToRender0.forEach((seg, i) => {
        if (!seg || seg.length < 2) return;
        paths.push({
          positions: seg,
          routeId,
          key: `route-${stationKey}-${routeId}-0-rail-${i}`,
          pathOptions,
          osmRelationId: gtfs0 ? null : osmRelationId,
          isFuture,
          futureStartDate,
        });
      });

      const busPathOptions = {
        color: PKP_BUS_COLOR,
        weight: 3,
        opacity: 0.85,
        dashArray: "8 6",
        lineCap: "round",
        lineJoin: "round",
      };
      (route.pkp_bus_segments_0 || []).forEach((seg, i) => {
        const segPos = seg?.positions ?? seg;
        if (!segPos || segPos.length < 2) return;
        paths.push({
          positions: segPos,
          routeId,
          key: `route-${stationKey}-${routeId}-0-bus-${i}`,
          pathOptions: busPathOptions,
          osmRelationId: null,
          isFuture,
          futureStartDate,
          isBusConnector: true,
          busFrom: seg?.from ?? null,
          busTo: seg?.to ?? null,
        });
      });

      if (route.origin_trip_1 && route.destination_trip_1) {
        const gtfs1 =
          route.pkp_gtfs_positions_1?.length >= 2
            ? route.pkp_gtfs_positions_1
            : null;
        const path1 = buildPathForDirection(
          route.origin_trip_1,
          route.destination_trip_1,
          route.via_1,
        );
        const path1ToUse = gtfs1 ?? path1 ?? route.fallbackPositions ?? null;

        const railSegs1 = route.pkp_rail_segments_1;
        const segsToRender1 =
          railSegs1?.length >= 1 ? railSegs1 : path1ToUse ? [path1ToUse] : [];
        segsToRender1.forEach((seg, i) => {
          if (!seg || seg.length < 2) return;
          paths.push({
            positions: seg,
            routeId,
            key: `route-${stationKey}-${routeId}-1-rail-${i}`,
            pathOptions,
            osmRelationId: gtfs1 ? null : osmRelationId,
            isFuture,
            futureStartDate,
          });
        });

        (route.pkp_bus_segments_1 || []).forEach((seg, i) => {
          const segPos = seg?.positions ?? seg;
          if (!segPos || segPos.length < 2) return;
          paths.push({
            positions: segPos,
            routeId,
            key: `route-${stationKey}-${routeId}-1-bus-${i}`,
            pathOptions: busPathOptions,
            osmRelationId: null,
            isFuture,
            futureStartDate,
            isBusConnector: true,
            busFrom: seg?.from ?? null,
            busTo: seg?.to ?? null,
          });
        });
      }
    }
  });

  return paths;
}
