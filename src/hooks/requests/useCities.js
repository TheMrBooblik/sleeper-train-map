import { useEffect, useState } from "react";
import { VIEW_CITIES, VIEW_MAP } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Cache structure
const citiesCache = {
  data: null,
  timestamp: null,
};

export function useCities() {
  const [cities, setCities] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchCities = async () => {
      // Clear cache first to ensure fresh data with new logic
      const cacheKey = `${VIEW_MAP}_cities`;
      localStorage.removeItem(cacheKey);

      // Check if we need to fetch new data
      const currentTime = new Date().getTime();
      const shouldFetchData =
        !citiesCache.data ||
        !citiesCache.timestamp ||
        currentTime - citiesCache.timestamp > CACHE_DURATION;

      if (shouldFetchData) {
        setIsLoading(true);
        try {
          // Since view_ontd_cities is corrupted, generate city-to-route mapping from view_ontd_map
          const res = await fetch(
            `/api/trains?type=${VIEW_MAP}&t=${Date.now()}`,
          );

          if (!res.ok) {
            throw new Error(
              `Failed to fetch map data: ${res.status} ${res.statusText}`,
            );
          }

          const mapData = await res.json();

          // Generate city-to-route mapping
          const cityRouteMap = {};

          if (mapData) {
            // First pass: Process ALL routes to identify main stations
            Object.values(mapData).forEach((route) => {
              if (route && route.route_id) {
                const routeId = route.route_id.toString();

                // Add all main stations (origins and destinations)
                const mainStations = [
                  route.origin_trip_0,
                  route.destination_trip_0,
                  route.origin_trip_1,
                  route.destination_trip_1,
                ].filter(Boolean);

                mainStations.forEach((station) => {
                  if (!cityRouteMap[station]) {
                    cityRouteMap[station] = {
                      stop_id: station,
                      stop_route_ids: routeId,
                      isMainStation: true,
                      isViaStation: false, // Explicitly set to false
                    };
                  } else {
                    cityRouteMap[station].stop_route_ids += `,${routeId}`;
                    cityRouteMap[station].isMainStation = true;
                    cityRouteMap[station].isViaStation = false; // Override any via station flag
                  }
                });
              }
            });

            // Second pass: Process via stations (only for stations that aren't main stations)
            Object.values(mapData).forEach((route) => {
              if (route && route.route_id) {
                const routeId = route.route_id.toString();

                // Add intermediate stations from via_0
                if (route.via_0) {
                  const viaStations = route.via_0
                    .split(" - ")
                    .filter((station) => station.trim());
                  viaStations.forEach((viaStation) => {
                    if (!cityRouteMap[viaStation]) {
                      // Only create new via station if it doesn't exist
                      cityRouteMap[viaStation] = {
                        stop_id: viaStation,
                        stop_route_ids: routeId,
                        isViaStation: true,
                        isMainStation: false,
                      };
                    } else {
                      // Add route to existing station
                      cityRouteMap[viaStation].stop_route_ids += `,${routeId}`;
                      // Only set as via station if it's not already a main station
                      if (!cityRouteMap[viaStation].isMainStation) {
                        cityRouteMap[viaStation].isViaStation = true;
                      }
                    }
                  });
                }

                // Add intermediate stations from via_1
                if (route.via_1) {
                  const viaStations = route.via_1
                    .split(" - ")
                    .filter((station) => station.trim());
                  viaStations.forEach((viaStation) => {
                    if (!cityRouteMap[viaStation]) {
                      // Only create new via station if it doesn't exist
                      cityRouteMap[viaStation] = {
                        stop_id: viaStation,
                        stop_route_ids: routeId,
                        isViaStation: true,
                        isMainStation: false,
                      };
                    } else {
                      // Add route to existing station
                      cityRouteMap[viaStation].stop_route_ids += `,${routeId}`;
                      // Only set as via station if it's not already a main station
                      if (!cityRouteMap[viaStation].isMainStation) {
                        cityRouteMap[viaStation].isViaStation = true;
                      }
                    }
                  });
                }
              }
            });
          }

          // Update the cache
          citiesCache.data = cityRouteMap;
          citiesCache.timestamp = currentTime;

          // Update the state
          setCities(cityRouteMap);
        } catch (error) {
          console.error("Error fetching cities:", error);
          setCities({});
        } finally {
          setIsLoading(false);
        }
      } else {
        // Use cached data
        setCities(citiesCache.data || {});
      }
    };

    fetchCities();
  }, []);

  // Function to force refresh data
  const refreshCities = async () => {
    setIsLoading(true);
    try {
      // Clear cache first to ensure fresh data
      const cacheKey = `${VIEW_MAP}_cities`;
      localStorage.removeItem(cacheKey);

      // Since view_ontd_cities is corrupted, generate city-to-route mapping from view_ontd_map
      const res = await fetch(`/api/trains?type=${VIEW_MAP}&t=${Date.now()}`);

      if (!res.ok) {
        throw new Error(
          `Failed to fetch map data: ${res.status} ${res.statusText}`,
        );
      }

      const mapData = await res.json();

      // Generate city-to-route mapping
      const cityRouteMap = {};

      if (mapData) {
        // First pass: Process ALL routes to identify main stations
        Object.values(mapData).forEach((route) => {
          if (route && route.route_id) {
            const routeId = route.route_id.toString();

            // Add all main stations (origins and destinations)
            const mainStations = [
              route.origin_trip_0,
              route.destination_trip_0,
              route.origin_trip_1,
              route.destination_trip_1,
            ].filter(Boolean);

            mainStations.forEach((station) => {
              if (!cityRouteMap[station]) {
                cityRouteMap[station] = {
                  stop_id: station,
                  stop_route_ids: routeId,
                  isMainStation: true,
                  isViaStation: false, // Explicitly set to false
                };
              } else {
                cityRouteMap[station].stop_route_ids += `,${routeId}`;
                cityRouteMap[station].isMainStation = true;
                cityRouteMap[station].isViaStation = false; // Override any via station flag
              }
            });
          }
        });

        // Second pass: Process via stations (only for stations that aren't main stations)
        Object.values(mapData).forEach((route) => {
          if (route && route.route_id) {
            const routeId = route.route_id.toString();

            // Add intermediate stations from via_0
            if (route.via_0) {
              const viaStations = route.via_0
                .split(" - ")
                .filter((station) => station.trim());
              viaStations.forEach((viaStation) => {
                if (!cityRouteMap[viaStation]) {
                  // Only create new via station if it doesn't exist
                  cityRouteMap[viaStation] = {
                    stop_id: viaStation,
                    stop_route_ids: routeId,
                    isViaStation: true,
                    isMainStation: false,
                  };
                } else {
                  // Add route to existing station
                  cityRouteMap[viaStation].stop_route_ids += `,${routeId}`;
                  // Only set as via station if it's not already a main station
                  if (!cityRouteMap[viaStation].isMainStation) {
                    cityRouteMap[viaStation].isViaStation = true;
                  }
                }
              });
            }

            // Add intermediate stations from via_1
            if (route.via_1) {
              const viaStations = route.via_1
                .split(" - ")
                .filter((station) => station.trim());
              viaStations.forEach((viaStation) => {
                if (!cityRouteMap[viaStation]) {
                  // Only create new via station if it doesn't exist
                  cityRouteMap[viaStation] = {
                    stop_id: viaStation,
                    stop_route_ids: routeId,
                    isViaStation: true,
                    isMainStation: false,
                  };
                } else {
                  // Add route to existing station
                  cityRouteMap[viaStation].stop_route_ids += `,${routeId}`;
                  // Only set as via station if it's not already a main station
                  if (!cityRouteMap[viaStation].isMainStation) {
                    cityRouteMap[viaStation].isViaStation = true;
                  }
                }
              });
            }
          }
        });
      }

      // Update the cache
      citiesCache.data = cityRouteMap;
      citiesCache.timestamp = new Date().getTime();

      // Update the state
      setCities(cityRouteMap);
    } catch (error) {
      console.error("Error refreshing cities:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    cities,
    setCities,
    isLoading,
    refreshCities,
    lastUpdated: citiesCache.timestamp ? new Date(citiesCache.timestamp) : null,
  };
}
