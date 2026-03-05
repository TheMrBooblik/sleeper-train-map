import { useEffect, useState, useCallback } from "react";
import { enrichStationsWithCoordinates } from "../../helpers/enrichStationsWithCoordinates";
import { stationCoordinates } from "../../data/stationCoordinates";
import { normalizeStationNameForLookup } from "./useCities";

// Module-level cache: shared across all component instances, 1 hour TTL
const CACHE_DURATION = 60 * 60 * 1000;
const cache = { data: null, timestamp: null };

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
 * Combined hook: fetches stops, viewMap, and trips in a single request.
 * Replaces useStops + useCities + useViewMap + useTrips with one CDN-cached call.
 */
export function useInitialData() {
  const [stops, setStops] = useState([]);
  const [filteredStops, setFilteredStops] = useState([]);
  const [cities, setCities] = useState({});
  const [viewMapData, setViewMapData] = useState({});
  const [trips, setTrips] = useState({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      // Use module-level cache if fresh
      const now = Date.now();
      if (
        cache.data &&
        cache.timestamp &&
        now - cache.timestamp < CACHE_DURATION
      ) {
        setStops(cache.data.stops);
        setFilteredStops(cache.data.stops);
        setCities(cache.data.cities);
        setViewMapData(cache.data.viewMapData);
        setTrips(cache.data.trips);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const res = await fetch("/api/initial-data");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Process stops: convert to array + enrich with coordinates (same as useStops)
        let stopsArray = Array.isArray(data.stops)
          ? data.stops
          : Object.values(data.stops || {});
        stopsArray = enrichStationsWithCoordinates(
          stopsArray,
          stationCoordinates,
        );

        // Derive cities from viewMap (same logic as useCities)
        const citiesMap = deriveCities(data.viewMap);

        // Store in module-level cache
        cache.data = {
          stops: stopsArray,
          cities: citiesMap,
          viewMapData: data.viewMap || {},
          trips: data.trips || {},
        };
        cache.timestamp = now;

        setStops(stopsArray);
        setFilteredStops(stopsArray);
        setCities(citiesMap);
        setViewMapData(data.viewMap || {});
        setTrips(data.trips || {});
      } catch (err) {
        console.error("[useInitialData] Error:", err);
        setStops([]);
        setFilteredStops([]);
        setCities({});
        setViewMapData({});
        setTrips({});
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, []);

  const refreshData = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/initial-data");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      let stopsArray = Array.isArray(data.stops)
        ? data.stops
        : Object.values(data.stops || {});
      stopsArray = enrichStationsWithCoordinates(
        stopsArray,
        stationCoordinates,
      );
      const citiesMap = deriveCities(data.viewMap);

      cache.data = {
        stops: stopsArray,
        cities: citiesMap,
        viewMapData: data.viewMap || {},
        trips: data.trips || {},
      };
      cache.timestamp = Date.now();

      setStops(stopsArray);
      setFilteredStops(stopsArray);
      setCities(citiesMap);
      setViewMapData(data.viewMap || {});
      setTrips(data.trips || {});
    } catch (err) {
      console.error("[useInitialData] Refresh error:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

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
