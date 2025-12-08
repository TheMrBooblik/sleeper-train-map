import { useEffect, useState } from "react";
import { VIEW_CITIES, VIEW_MAP } from "../../constants/backOnTrack";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Function to normalize station names to handle inconsistencies between stops and routes data
// Export this function so it can be used in other components
export const normalizeStationNameForLookup = (stationName) => {
  if (!stationName) return stationName;

  // Step 1: Remove French bilingual parts (e.g., " / Anvers-Central", " / Bruxelles-Midi", " / Luik-*")
  let normalized = stationName
    .replace(/\s*\/\s*Anvers-[^/]+$/g, "") // Remove French Antwerp names
    .replace(/\s*\/\s*Bruxelles-[^/]+$/g, "") // Remove French Brussels names
    .replace(/\s*\/\s*Luik-[^/]+$/g, ""); // Remove Dutch Liège names (Luik = Liège in Dutch)

  // Step 2: Replace hyphens with spaces for Belgian stations
  normalized = normalized
    .replace(/Bruxelles-Midi/g, "Bruxelles Midi")
    .replace(/Bruxelles-Nord/g, "Bruxelles Nord")
    .replace(/Bruxelles-Ouest/g, "Bruxelles Ouest")
    .replace(/Bruxelles-Central/g, "Bruxelles Central")
    .replace(/Bruxelles-Chapelle/g, "Bruxelles Chapelle")
    .replace(/Bruxelles-Congrès/g, "Bruxelles Congrès")
    .replace(/Bruxelles-Luxembourg/g, "Bruxelles Luxembourg")
    .replace(/Bruxelles-Schuman/g, "Bruxelles Schuman")
    .replace(/Antwerpen-Berchem/g, "Antwerpen Berchem")
    .replace(/Antwerpen-Centraal/g, "Antwerpen Centraal")
    .replace(/Antwerpen-D.S./g, "Antwerpen D.S.")
    .replace(/Antwerpen-Damiaan/g, "Antwerpen Damiaan")
    .replace(/Antwerpen-Kiel/g, "Antwerpen Kiel")
    .replace(/Antwerpen-Luchtbal/g, "Antwerpen Luchtbal")
    .replace(/Antwerpen-Noord/g, "Antwerpen Noord")
    .replace(/Antwerpen-Noorderdokken/g, "Antwerpen Noorderdokken")
    .replace(/Antwerpen-Oost/g, "Antwerpen Oost")
    .replace(/Antwerpen-Schijnpoort/g, "Antwerpen Schijnpoort")
    .replace(/Antwerpen-Waaslandhaven/g, "Antwerpen Waaslandhaven")
    .replace(/Antwerpen-Zuid/g, "Antwerpen Zuid")
    .replace(/Liège-Guillemins/g, "Liège Guillemins")
    .replace(/Liège-Carré/g, "Liège Carré")
    .replace(/Liège-Palais/g, "Liège Palais")
    .replace(/Liège-Jonfosse/g, "Liège Jonfosse")
    .replace(/Liège-Longdoz/g, "Liège Longdoz")
    .replace(/Liège-Saint-Lambert/g, "Liège Saint Lambert");

  return normalized;
};

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

          // Debug: Count Brussels stations in route data
          let brusselsInRoutes = 0;

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
                  // Normalize station name to match stops data format
                  const normalizedStation =
                    normalizeStationNameForLookup(station);

                  // Debug: Count Brussels stations
                  if (
                    station.includes("Bruxelles") ||
                    station.includes("Brussels")
                  ) {
                    brusselsInRoutes++;
                  }

                  if (!cityRouteMap[normalizedStation]) {
                    cityRouteMap[normalizedStation] = {
                      stop_id: normalizedStation,
                      stop_route_ids: routeId,
                      isMainStation: true,
                      isViaStation: false, // Explicitly set to false
                    };
                  } else {
                    cityRouteMap[normalizedStation].stop_route_ids +=
                      `,${routeId}`;
                    cityRouteMap[normalizedStation].isMainStation = true;
                    cityRouteMap[normalizedStation].isViaStation = false; // Override any via station flag
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
                    // Normalize station name to match stops data format
                    const normalizedViaStation =
                      normalizeStationNameForLookup(viaStation);
                    if (!cityRouteMap[normalizedViaStation]) {
                      // Only create new via station if it doesn't exist
                      cityRouteMap[normalizedViaStation] = {
                        stop_id: normalizedViaStation,
                        stop_route_ids: routeId,
                        isViaStation: true,
                        isMainStation: false,
                      };
                    } else {
                      // Add route to existing station
                      cityRouteMap[normalizedViaStation].stop_route_ids +=
                        `,${routeId}`;
                      // Only set as via station if it's not already a main station
                      if (!cityRouteMap[normalizedViaStation].isMainStation) {
                        cityRouteMap[normalizedViaStation].isViaStation = true;
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
                    // Normalize station name to match stops data format
                    const normalizedViaStation =
                      normalizeStationNameForLookup(viaStation);
                    if (!cityRouteMap[normalizedViaStation]) {
                      // Only create new via station if it doesn't exist
                      cityRouteMap[normalizedViaStation] = {
                        stop_id: normalizedViaStation,
                        stop_route_ids: routeId,
                        isViaStation: true,
                        isMainStation: false,
                      };
                    } else {
                      // Add route to existing station
                      cityRouteMap[normalizedViaStation].stop_route_ids +=
                        `,${routeId}`;
                      // Only set as via station if it's not already a main station
                      if (!cityRouteMap[normalizedViaStation].isMainStation) {
                        cityRouteMap[normalizedViaStation].isViaStation = true;
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
