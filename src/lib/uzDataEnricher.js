/**
 * UZ Data Enrichment Service
 * Uses manually curated UZ stop data to enhance Back-on-Track route data
 */

const fs = require("fs").promises;
const path = require("path");

const MANUAL_FILE = path.join(process.cwd(), "data", "uzManualStops.json");

/**
 * Load manual UZ data
 */
async function loadManualData() {
  try {
    const data = await fs.readFile(MANUAL_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return parsed;
  } catch (error) {
    return null;
  }
}

/**
 * Enrich Back-on-Track stops data with manual UZ stops
 * This converts the stops object format to array format and adds manual stations
 */
async function enrichStopsData(backOnTrackStops) {
  const manualData = await loadManualData();

  if (!manualData || !manualData.routes) {
    return backOnTrackStops;
  }

  const inputType = Array.isArray(backOnTrackStops) ? "array" : "object";

  // Convert stops object to array if needed
  let stopsArray = Array.isArray(backOnTrackStops)
    ? backOnTrackStops
    : Object.values(backOnTrackStops).filter((s) => s && s.stop_id);

  // Create a Set of existing station names for quick lookup
  const existingStations = new Set(
    stopsArray.map((s) => s.stop_id).filter(Boolean),
  );

  // Collect all manual stations from all routes
  const manualStations = [];

  Object.entries(manualData.routes).forEach(([routeId, route]) => {
    if (!route.stops) return;

    route.stops.forEach((stop) => {
      const stationName = stop.name;

      // Only add if not already in Back-on-Track data
      if (!existingStations.has(stationName)) {
        manualStations.push({
          stop_id: stationName,
          stop_name: stationName,
          stop_lat: null, // Will be filled from stationCoordinates.js
          stop_lon: null, // Will be filled from stationCoordinates.js
          coordinatesSource: "manual",
          // These will be added by enrichStationsWithCoordinates
        });
        existingStations.add(stationName);
      }
    });
  });

  if (manualStations.length > 0) {
    stopsArray = [...stopsArray, ...manualStations];
  }

  return stopsArray;
}

/**
 * Enrich routes data with manual stop information
 * This adds intermediate stations to the via_0 field so they appear on the map
 */
async function enrichRoutesData(backOnTrackRoutes) {
  const manualData = await loadManualData();

  if (!manualData || !manualData.routes) {
    return backOnTrackRoutes;
  }

  const enrichedRoutes = { ...backOnTrackRoutes };

  // First, let's see what UZ routes exist in Back-on-Track
  const uzRoutes = Object.entries(enrichedRoutes).filter(
    ([id, r]) => r && r.agency_id === "UZ",
  );

  Object.keys(enrichedRoutes).forEach((routeId) => {
    const route = enrichedRoutes[routeId];

    if (!route || !route.agency_id || route.agency_id !== "UZ") {
      return;
    }

    const manualRoute = manualData.routes[routeId];

    if (manualRoute && manualRoute.stops) {
      // Extract intermediate stops (exclude first and last which are origin/destination)
      const intermediateStops = manualRoute.stops
        .slice(1, -1)
        .map((s) => s.name);
      // For return direction, reverse the order
      const intermediateStopsReversed = [...intermediateStops].reverse();

      enrichedRoutes[routeId] = {
        ...route,
        // Add intermediate stops to via_0 field (direction 0: e.g., Kyiv → Kamianets-Podilskyi)
        via_0: intermediateStops.join(" - "),
        // Add intermediate stops to via_1 field in REVERSE order (direction 1: e.g., Kamianets-Podilskyi → Kyiv)
        via_1: intermediateStopsReversed.join(" - "),
        stop_count: manualRoute.stops.length,
        has_enhanced_data: true,
        data_source: "manual",
      };
    }
  });

  return enrichedRoutes;
}

module.exports = {
  enrichStopsData,
  enrichRoutesData,
  loadManualData,
};
