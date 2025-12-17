/**
 * Enriches station data with coordinates
 *
 * Priority order:
 * 1. Our custom stationCoordinates database (most reliable)
 * 2. Open Night Train Database coordinates (fallback)
 *
 * @param {Array} stops - Array of station objects from Open Night Train Database
 * @param {Object} customCoordinates - Object with custom coordinates { "Station Name": { lat, lon } }
 * @returns {Array} - Array of stations with enriched coordinates
 */
export function enrichStationsWithCoordinates(stops, customCoordinates) {
  if (!stops || !Array.isArray(stops)) {
    return [];
  }

  return stops.map((stop) => {
    // Check if we have custom coordinates for this station
    const stationName = stop.stop_id;
    const customCoords = customCoordinates[stationName];

    // If custom coordinates exist, use them (they take priority)
    if (customCoords && customCoords.lat && customCoords.lon) {
      return {
        ...stop,
        stop_lat: customCoords.lat,
        stop_lon: customCoords.lon,
        // Mark that we used custom coordinates
        coordinatesSource: "custom",
      };
    }

    // Otherwise, use coordinates from Open Night Train Database (if available)
    // The stop object should already have stop_lat and stop_lon from the database
    return {
      ...stop,
      // Keep original coordinates from database, or mark as missing
      coordinatesSource:
        stop.stop_lat && stop.stop_lon ? "database" : "missing",
    };
  });
}
