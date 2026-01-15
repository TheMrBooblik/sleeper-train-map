/**
 * Station name replacements for routes
 *
 * This file contains mappings to replace incorrect station names in route data
 * Format: { "old name": "new name" }
 *
 * These replacements are applied to route data (viewMap) to fix incorrect station names
 */

/**
 * Station name replacements with route restrictions
 * Format: { "old name": { newName: "new name", routeIds: [142, 143] } }
 * If routeIds array is empty or not specified, replacement applies to all routes
 */
export const stationNameReplacements = {
  // BDŽ 2636 Dobrich-Sofia: Replace Baqël with Oborishte (only for route_id 142)
  Baqël: {
    newName: "Oborishte",
    routeIds: [142], // Only apply to route_id 142
  },
};

/**
 * Station name replacements for stops data (applies to all stations, not route-specific)
 * Format: { "old name": "new name" }
 * These replacements are applied to stops data to fix incorrect station names
 */
export const stopNameReplacements = {
  // Replace Baqël with Oborishte in stops data
  Baqël: "Oborishte",
};

/**
 * Check if replacement should be applied based on agency_id
 * @param {string} stationName - Station name to check
 * @param {string} agencyId - Agency ID from route
 * @returns {string|null} - New station name if replacement should be applied, null otherwise
 */
function shouldReplaceStation(stationName, agencyId) {
  const replacement = stationNameReplacements[stationName];
  if (!replacement) return null;

  // If replacement is a string (old format), apply it
  if (typeof replacement === "string") {
    return replacement;
  }

  // If replacement is an object with agencies restriction
  if (replacement.agencies && Array.isArray(replacement.agencies)) {
    // If agencies array is empty, apply to all
    if (replacement.agencies.length === 0) {
      return replacement.newName;
    }
    // Check if agency_id matches
    if (agencyId && replacement.agencies.includes(agencyId)) {
      return replacement.newName;
    }
    // Agency doesn't match, don't replace
    return null;
  }

  // If no agencies restriction, apply to all
  return replacement.newName || replacement;
}

/**
 * Apply station name replacements to a route object
 * @param {Object} route - Route object from Open Night Train Database
 * @returns {Object} - Route object with replaced station names
 */
export function applyStationNameReplacements(route) {
  if (!route || typeof route !== "object") {
    return route;
  }

  // Get route_id from route
  const routeId = route.route_id || route.routeId || null;

  // Create a copy to avoid mutating the original
  const replacedRoute = { ...route };

  // List of fields that may contain station names
  const stationFields = [
    "origin_trip_0",
    "destination_trip_0",
    "origin_trip_1",
    "destination_trip_1",
    "via_0",
    "via_1",
  ];

  // Apply replacements to each field
  stationFields.forEach((field) => {
    if (replacedRoute[field]) {
      let value = replacedRoute[field];

      // Handle string values (single station name or multiple stations separated by " - ")
      if (typeof value === "string") {
        // Check if this exact station name needs replacement
        const exactReplacement = shouldReplaceStation(value, routeId);
        if (exactReplacement) {
          replacedRoute[field] = exactReplacement;
        } else {
          // Check if station name appears in a string (e.g., "Station1 - Station2")
          // Split by " - " to handle multiple stations
          const stations = value.split(" - ");
          const replacedStations = stations.map((station) => {
            const trimmedStation = station.trim();
            // Check if this exact station name needs replacement
            const replacement = shouldReplaceStation(trimmedStation, routeId);
            if (replacement) {
              return replacement;
            }
            // Otherwise keep original
            return station;
          });
          replacedRoute[field] = replacedStations.join(" - ");
        }
      }
    }
  });

  return replacedRoute;
}

/**
 * Apply station name replacements to route data object
 * @param {Object} routeData - Route data object (viewMap) from Open Night Train Database
 * @returns {Object} - Route data object with replaced station names
 */
export function applyReplacementsToRouteData(routeData) {
  if (!routeData || typeof routeData !== "object") {
    return routeData;
  }

  // If it's an array, process each route
  if (Array.isArray(routeData)) {
    return routeData.map(applyStationNameReplacements);
  }

  // If it's an object with routes, process each route
  const processedData = {};
  Object.keys(routeData).forEach((key) => {
    const route = routeData[key];
    processedData[key] = applyStationNameReplacements(route);
  });

  return processedData;
}
