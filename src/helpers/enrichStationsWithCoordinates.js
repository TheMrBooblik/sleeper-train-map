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

    // Try exact match first
    let customCoords = customCoordinates[stationName];

    // If no exact match, try variations for Rome/Roma stations
    // This handles variations like "Roma Termini" vs "Rome Termini"
    if (!customCoords && stationName) {
      // Try replacing Roma with Rome
      if (stationName.includes("Roma")) {
        const romeVariant = stationName.replace(/Roma/g, "Rome");
        customCoords = customCoordinates[romeVariant];
      }

      // Try replacing Rome with Roma
      if (!customCoords && stationName.includes("Rome")) {
        const romaVariant = stationName.replace(/Rome/g, "Roma");
        customCoords = customCoordinates[romaVariant];
      }

      // Try case-insensitive search
      if (!customCoords) {
        const lowerName = stationName.toLowerCase();
        const matchingKey = Object.keys(customCoordinates).find(
          (key) => key.toLowerCase() === lowerName,
        );
        if (matchingKey) {
          customCoords = customCoordinates[matchingKey];
        }
      }

      // For Rome stations, try partial matching by station type
      // This handles cases where the name format differs (e.g., "Roma Termini" vs "Termini Roma")
      if (
        !customCoords &&
        (stationName.includes("Roma") || stationName.includes("Rome"))
      ) {
        const stationTypes = ["Termini", "Tiburtina", "Ostiense", "Trastevere"];
        for (const stationType of stationTypes) {
          if (stationName.includes(stationType)) {
            // Try both "Roma" and "Rome" variants
            const romaKey = `Roma ${stationType}`;
            const romeKey = `Rome ${stationType}`;
            customCoords =
              customCoordinates[romaKey] || customCoordinates[romeKey];
            if (customCoords) break;
          }
        }
      }
    }

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
