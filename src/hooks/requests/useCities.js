import { useMemo } from "react";

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

/**
 * Build a city-to-route mapping from raw view_ontd_map data.
 * Extracted as a pure function so it can be used with useMemo.
 */
function buildCityRouteMap(mapData) {
  if (!mapData) return {};

  const cityRouteMap = {};

  // First pass: Process ALL routes to identify main stations (origins and destinations)
  Object.values(mapData).forEach((route) => {
    if (route && route.route_id) {
      const routeId = route.route_id.toString();

      const mainStations = [
        route.origin_trip_0,
        route.destination_trip_0,
        route.origin_trip_1,
        route.destination_trip_1,
      ].filter(Boolean);

      mainStations.forEach((station) => {
        // Normalize station name to match stops data format
        const normalizedStation = normalizeStationNameForLookup(station);

        if (!cityRouteMap[normalizedStation]) {
          cityRouteMap[normalizedStation] = {
            stop_id: normalizedStation,
            stop_route_ids: routeId,
            isMainStation: true,
            isViaStation: false,
          };
        } else {
          cityRouteMap[normalizedStation].stop_route_ids += `,${routeId}`;
          cityRouteMap[normalizedStation].isMainStation = true;
          cityRouteMap[normalizedStation].isViaStation = false;
        }
      });
    }
  });

  // Second pass: Process via stations (only for stations that aren't already main stations)
  Object.values(mapData).forEach((route) => {
    if (route && route.route_id) {
      const routeId = route.route_id.toString();

      // Process via_0 and via_1 intermediate stations
      [route.via_0, route.via_1].forEach((viaString) => {
        if (!viaString) return;
        const viaStations = viaString
          .split(" - ")
          .filter((station) => station.trim());

        viaStations.forEach((viaStation) => {
          const normalizedViaStation =
            normalizeStationNameForLookup(viaStation);
          if (!cityRouteMap[normalizedViaStation]) {
            cityRouteMap[normalizedViaStation] = {
              stop_id: normalizedViaStation,
              stop_route_ids: routeId,
              isViaStation: true,
              isMainStation: false,
            };
          } else {
            cityRouteMap[normalizedViaStation].stop_route_ids += `,${routeId}`;
            // Only set as via station if it's not already a main station
            if (!cityRouteMap[normalizedViaStation].isMainStation) {
              cityRouteMap[normalizedViaStation].isViaStation = true;
            }
          }
        });
      });
    }
  });

  return cityRouteMap;
}

/**
 * Derives city-to-route mapping from viewMapData (provided by useViewMap).
 * No longer fetches independently — avoids a duplicate request for view_ontd_map.
 *
 * @param {Object} viewMapData - Raw view_ontd_map data from useViewMap()
 */
export function useCities(viewMapData) {
  // Derive city mapping from viewMapData using useMemo to avoid recomputation
  const cities = useMemo(() => buildCityRouteMap(viewMapData), [viewMapData]);

  // Loading is true when viewMapData hasn't arrived yet
  const isLoading = !viewMapData || Object.keys(viewMapData).length === 0;

  return {
    cities,
    isLoading,
  };
}
