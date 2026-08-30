import { stopNameReplacements } from "../data/stationNameReplacements.js";

/** Coerce API lat/lon to a finite number, or null if unusable (avoids Leaflet crashes on bad strings). */
export function parseCoord(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

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

  // First pass: apply name replacements
  const stopsWithReplacements = stops.map((stop) => {
    // Check if we have custom coordinates for this station
    let stationName = stop.stop_id;

    // Apply station name replacements for stops data
    if (stationName && stopNameReplacements[stationName]) {
      stationName = stopNameReplacements[stationName];
    }

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
        stop_id: stationName, // Use replaced station name
        stop_lat: customCoords.lat,
        stop_lon: customCoords.lon,
        // Mark that we used custom coordinates
        coordinatesSource: "custom",
      };
    }

    // Otherwise, use coordinates from Open Night Train Database (if available)
    const dbLat = parseCoord(stop.stop_lat);
    const dbLon = parseCoord(stop.stop_lon);
    return {
      ...stop,
      stop_id: stationName, // Use replaced station name
      stop_lat: dbLat,
      stop_lon: dbLon,
      coordinatesSource:
        dbLat != null && dbLon != null ? "database" : "missing",
    };
  });

  // Second pass: deduplicate stations with the same name after replacements
  // If multiple stations have the same stop_id after replacement, keep only one
  const deduplicatedStops = [];
  const seenStations = new Map();

  stopsWithReplacements.forEach((stop) => {
    const stationName = stop.stop_id;

    if (!seenStations.has(stationName)) {
      // First occurrence - add it
      seenStations.set(stationName, stop);
      deduplicatedStops.push(stop);
    } else {
      // Duplicate found - prefer station with coordinates or custom coordinates
      const existingStop = seenStations.get(stationName);

      // Prefer station with custom coordinates
      if (
        stop.coordinatesSource === "custom" &&
        existingStop.coordinatesSource !== "custom"
      ) {
        // Replace existing with this one (has custom coordinates)
        const index = deduplicatedStops.indexOf(existingStop);
        if (index !== -1) {
          deduplicatedStops[index] = stop;
          seenStations.set(stationName, stop);
        }
      }
      // If both have same coordinate source, keep the first one
      // (or prefer one with coordinates over one without)
      else if (
        stop.stop_lat &&
        stop.stop_lon &&
        !existingStop.stop_lat &&
        !existingStop.stop_lon
      ) {
        // Replace existing with this one (has coordinates)
        const index = deduplicatedStops.indexOf(existingStop);
        if (index !== -1) {
          deduplicatedStops[index] = stop;
          seenStations.set(stationName, stop);
        }
      }
    }
  });

  return deduplicatedStops;
}
