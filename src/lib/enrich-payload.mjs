/**
 * The client-side half of the data pipeline, as a pure function.
 *
 * `/api/initial-data` serves the review-gated merge, but it is not yet what the
 * map renders: coordinates from the station-coordinates override, terminus
 * rewrites, the PKP and RegioJet GTFS merges and the city index are all applied
 * *after* the fetch. That work used to live inside `useInitialData`, duplicated
 * verbatim between its initial load and its refresh path, which meant nothing
 * outside React could reproduce what the map actually shows.
 *
 * The mobile payload builder (`scripts/build-mobile-payload.mjs`) has to
 * reproduce it exactly — a second implementation would drift — so it lives here
 * instead: no React, no `fetch`, no browser globals, just blobs in and the
 * finished `{ stops, cities, viewMapData, trips }` out. `useInitialData` calls
 * it too, so there is one implementation and the web is its own regression test.
 *
 * Raw node can import this (see tests/verify-mobile-payload.mjs).
 */
import { enrichStationsWithCoordinates } from "../helpers/enrichStationsWithCoordinates.js";
import { stationCoordinates } from "../data/stationCoordinates.js";
import { normalizeStationNameForLookup } from "../hooks/requests/useCities.js";
import { attachPkpGtfsPolylinesToViewMap } from "./pkpGtfsMerge.js";
import { attachRjGtfsToViewMap } from "./rjGtfsMerge.js";
import {
  applyReplacementsToRouteData,
  applyReplacementsToTrips,
} from "../data/stationNameReplacements.js";

/**
 * Derive the city → route index from viewMap data.
 *
 * Two passes, and the order matters: an endpoint outranks a via-stop, so a
 * station that is both (Berlin Hbf terminates some trains and is passed by
 * others) stays a main station. The second pass therefore only ever *adds* the
 * via flag, and only when the first pass did not already claim the name.
 */
export function deriveCities(mapData) {
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
 * Turn the raw `/api/initial-data` payload plus the three static GTFS blobs into
 * what the map consumes.
 *
 * Every GTFS input is optional and every merge is individually recoverable: a
 * missing or malformed bundle costs that operator's geometry, never the map. The
 * caller decides how to report it — pass `onWarn` to log.
 *
 * @param {object}   args
 * @param {object}   args.data           `{ stops, viewMap, trips }` from the API
 * @param {object}  [args.pkpBundle]     public/data/gtfs/pkpTrainShapes.json
 * @param {object}  [args.rjChopData]    public/data/gtfs/rjChopTimetable.json
 * @param {object}  [args.rjPremyslData] public/data/gtfs/rjPremyslTimetable.json
 * @param {Function}[args.onWarn]        (message, error) => void
 * @returns {{stops: Array, cities: object, viewMapData: object, trips: object}}
 */
export function enrichInitialData({
  data,
  pkpBundle = null,
  rjChopData = null,
  rjPremyslData = null,
  onWarn = () => {},
}) {
  let viewMapRaw = data?.viewMap || {};

  if (pkpBundle) {
    try {
      viewMapRaw = attachPkpGtfsPolylinesToViewMap(viewMapRaw, pkpBundle);
    } catch (e) {
      onWarn("PKP GTFS bundle merge failed", e);
    }
  }

  let stopsArray = Array.isArray(data?.stops)
    ? data.stops
    : Object.values(data?.stops || {});
  stopsArray = enrichStationsWithCoordinates(stopsArray, stationCoordinates);

  // Merge RJ GTFS into viewMap: enriches via lists and adds missing stop records.
  if (rjChopData && rjPremyslData) {
    try {
      const existingIds = new Set(
        stopsArray.map((s) => (s.stop_id || "").toLowerCase()),
      );
      const { viewMap: rjViewMap, extraStops } = attachRjGtfsToViewMap(
        viewMapRaw,
        rjChopData,
        rjPremyslData,
        existingIds,
      );
      viewMapRaw = rjViewMap;
      stopsArray = [...stopsArray, ...extraStops];
    } catch (e) {
      onWarn("RJ GTFS merge failed", e);
    }
  }

  // BoT sometimes names the wrong terminus (Leo Express Frankfurt Flughafen vs
  // Süd). Rewrite before cities and booking see the names.
  viewMapRaw = applyReplacementsToRouteData(viewMapRaw);
  const tripsRaw = applyReplacementsToTrips(data?.trips || {}, viewMapRaw);

  return {
    stops: stopsArray,
    cities: deriveCities(viewMapRaw),
    viewMapData: viewMapRaw,
    trips: tripsRaw,
  };
}
