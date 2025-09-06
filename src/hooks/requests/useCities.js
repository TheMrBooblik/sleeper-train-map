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
          const res = await fetch(`/api/trains?type=${VIEW_MAP}`);
          const mapData = await res.json();

          // Generate city-to-route mapping
          const cityRouteMap = {};

          if (mapData) {
            Object.values(mapData).forEach((route) => {
              if (route && route.route_id) {
                const routeId = route.route_id.toString();

                // Add origin city
                if (route.origin_trip_0) {
                  if (!cityRouteMap[route.origin_trip_0]) {
                    cityRouteMap[route.origin_trip_0] = {
                      stop_id: route.origin_trip_0,
                      stop_route_ids: routeId,
                    };
                  } else {
                    cityRouteMap[route.origin_trip_0].stop_route_ids +=
                      `,${routeId}`;
                  }
                }

                // Add destination city
                if (route.destination_trip_0) {
                  if (!cityRouteMap[route.destination_trip_0]) {
                    cityRouteMap[route.destination_trip_0] = {
                      stop_id: route.destination_trip_0,
                      stop_route_ids: routeId,
                    };
                  } else {
                    cityRouteMap[route.destination_trip_0].stop_route_ids +=
                      `,${routeId}`;
                  }
                }

                // Add origin city for return trip
                if (route.origin_trip_1) {
                  if (!cityRouteMap[route.origin_trip_1]) {
                    cityRouteMap[route.origin_trip_1] = {
                      stop_id: route.origin_trip_1,
                      stop_route_ids: routeId,
                    };
                  } else {
                    cityRouteMap[route.origin_trip_1].stop_route_ids +=
                      `,${routeId}`;
                  }
                }

                // Add destination city for return trip
                if (route.destination_trip_1) {
                  if (!cityRouteMap[route.destination_trip_1]) {
                    cityRouteMap[route.destination_trip_1] = {
                      stop_id: route.destination_trip_1,
                      stop_route_ids: routeId,
                    };
                  } else {
                    cityRouteMap[route.destination_trip_1].stop_route_ids +=
                      `,${routeId}`;
                  }
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
      // Since view_ontd_cities is corrupted, generate city-to-route mapping from view_ontd_map
      const res = await fetch(`/api/trains?type=${VIEW_MAP}`);
      const mapData = await res.json();

      // Generate city-to-route mapping
      const cityRouteMap = {};

      if (mapData) {
        Object.values(mapData).forEach((route) => {
          if (route && route.route_id) {
            const routeId = route.route_id.toString();

            // Add origin city
            if (route.origin_trip_0) {
              if (!cityRouteMap[route.origin_trip_0]) {
                cityRouteMap[route.origin_trip_0] = {
                  stop_id: route.origin_trip_0,
                  stop_route_ids: routeId,
                };
              } else {
                cityRouteMap[route.origin_trip_0].stop_route_ids +=
                  `,${routeId}`;
              }
            }

            // Add destination city
            if (route.destination_trip_0) {
              if (!cityRouteMap[route.destination_trip_0]) {
                cityRouteMap[route.destination_trip_0] = {
                  stop_id: route.destination_trip_0,
                  stop_route_ids: routeId,
                };
              } else {
                cityRouteMap[route.destination_trip_0].stop_route_ids +=
                  `,${routeId}`;
              }
            }

            // Add origin city for return trip
            if (route.origin_trip_1) {
              if (!cityRouteMap[route.origin_trip_1]) {
                cityRouteMap[route.origin_trip_1] = {
                  stop_id: route.origin_trip_1,
                  stop_route_ids: routeId,
                };
              } else {
                cityRouteMap[route.origin_trip_1].stop_route_ids +=
                  `,${routeId}`;
              }
            }

            // Add destination city for return trip
            if (route.destination_trip_1) {
              if (!cityRouteMap[route.destination_trip_1]) {
                cityRouteMap[route.destination_trip_1] = {
                  stop_id: route.destination_trip_1,
                  stop_route_ids: routeId,
                };
              } else {
                cityRouteMap[route.destination_trip_1].stop_route_ids +=
                  `,${routeId}`;
              }
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
