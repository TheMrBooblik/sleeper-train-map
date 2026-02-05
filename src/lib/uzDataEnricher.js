/**
 * UZ Data Enrichment Service
 * Uses manually curated UZ stop data to enhance Back-on-Track route data
 */

const fs = require('fs').promises;
const path = require('path');

const MANUAL_FILE = path.join(process.cwd(), 'data', 'uzManualStops.json');

/**
 * Load manual UZ data
 */
async function loadManualData() {
  console.log('[UZ Enricher] Loading manual data from:', MANUAL_FILE);
  try {
    const data = await fs.readFile(MANUAL_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    console.log('[UZ Enricher] ✓ Loaded manual UZ data with', Object.keys(parsed.routes || {}).length, 'routes');
    console.log('[UZ Enricher] Route IDs:', Object.keys(parsed.routes || {}));
    return parsed;
  } catch (error) {
    console.log('[UZ Enricher] ❌ Error loading manual data:', error.message);
    return null;
  }
}

/**
 * Enrich Back-on-Track stops data with manual UZ stops
 * This converts the stops object format to array format and adds manual stations
 */
async function enrichStopsData(backOnTrackStops) {
  console.log('[UZ Enricher] enrichStopsData called');
  const manualData = await loadManualData();
  
  if (!manualData || !manualData.routes) {
    console.log('[UZ Enricher] No manual data available for stops enrichment');
    return backOnTrackStops;
  }
  
  console.log('[UZ Enricher] Manual data loaded, proceeding with stops enrichment');
  const inputType = Array.isArray(backOnTrackStops) ? 'array' : 'object';
  console.log('[UZ Enricher] Input stops type:', inputType);
  
  // Convert stops object to array if needed
  let stopsArray = Array.isArray(backOnTrackStops) 
    ? backOnTrackStops 
    : Object.values(backOnTrackStops).filter(s => s && s.stop_id);
  
  // Create a Set of existing station names for quick lookup
  const existingStations = new Set(
    stopsArray.map(s => s.stop_id).filter(Boolean)
  );
  
  // Collect all manual stations from all routes
  const manualStations = [];
  console.log('Manual UZ routes:', Object.keys(manualData.routes));
  
  Object.entries(manualData.routes).forEach(([routeId, route]) => {
    if (!route.stops) return;
    
    console.log(`Processing route ${routeId}: ${route.stops.length} stops`);
    
    route.stops.forEach(stop => {
      const stationName = stop.name;
      
      // Only add if not already in Back-on-Track data
      if (!existingStations.has(stationName)) {
        console.log(`  Adding manual station: ${stationName}`);
        manualStations.push({
          stop_id: stationName,
          stop_name: stationName,
          stop_lat: null, // Will be filled from stationCoordinates.js
          stop_lon: null, // Will be filled from stationCoordinates.js
          coordinatesSource: 'manual',
          // These will be added by enrichStationsWithCoordinates
        });
        existingStations.add(stationName);
      } else {
        console.log(`  Station already exists: ${stationName}`);
      }
    });
  });
  
  if (manualStations.length > 0) {
    console.log(`✓ Adding ${manualStations.length} manual UZ stations`);
    stopsArray = [...stopsArray, ...manualStations];
  }
  
  return stopsArray;
}

/**
 * Enrich routes data with manual stop information
 * This adds intermediate stations to the via_0 field so they appear on the map
 */
async function enrichRoutesData(backOnTrackRoutes) {
  console.log('[UZ Enricher] enrichRoutesData called');
  console.log('[UZ Enricher] Number of routes in input:', Object.keys(backOnTrackRoutes || {}).length);
  
  const manualData = await loadManualData();
  
  if (!manualData || !manualData.routes) {
    console.log('[UZ Enricher] No manual data available for routes enrichment');
    return backOnTrackRoutes;
  }
  
  console.log('[UZ Enricher] Manual data loaded, proceeding with routes enrichment');
  
  const enrichedRoutes = { ...backOnTrackRoutes };
  
  // First, let's see what UZ routes exist in Back-on-Track
  const uzRoutes = Object.entries(enrichedRoutes).filter(([id, r]) => r && r.agency_id === 'UZ');
  console.log('[UZ Enricher] Found', uzRoutes.length, 'UZ routes in Back-on-Track');
  console.log('[UZ Enricher] UZ route IDs:', uzRoutes.map(([id]) => id).join(', '));
  
  // Check if route 140 exists
  if (enrichedRoutes['140']) {
    console.log('[UZ Enricher] Route 140 found in Back-on-Track:', enrichedRoutes['140']);
  } else {
    console.log('[UZ Enricher] ❌ Route 140 NOT found in Back-on-Track data!');
  }
  
  Object.keys(enrichedRoutes).forEach(routeId => {
    const route = enrichedRoutes[routeId];
    
    if (!route || !route.agency_id || route.agency_id !== 'UZ') {
      return;
    }
    
    const manualRoute = manualData.routes[routeId];
    
    if (manualRoute && manualRoute.stops) {
      // Extract intermediate stops (exclude first and last which are origin/destination)
      const intermediateStops = manualRoute.stops.slice(1, -1).map(s => s.name);
      // For return direction, reverse the order
      const intermediateStopsReversed = [...intermediateStops].reverse();
      
      console.log(`[UZ Enricher] Enriching route ${routeId} with ${intermediateStops.length} via stations:`, intermediateStops.join(', '));
      console.log(`[UZ Enricher] Original via_0:`, route.via_0 || 'none');
      console.log(`[UZ Enricher] Original via_1:`, route.via_1 || 'none');
      
      enrichedRoutes[routeId] = {
        ...route,
        // Add intermediate stops to via_0 field (direction 0: e.g., Kyiv → Kamianets-Podilskyi)
        via_0: intermediateStops.join(' - '),
        // Add intermediate stops to via_1 field in REVERSE order (direction 1: e.g., Kamianets-Podilskyi → Kyiv)
        via_1: intermediateStopsReversed.join(' - '),
        stop_count: manualRoute.stops.length,
        has_enhanced_data: true,
        data_source: 'manual',
      };
      
      console.log(`[UZ Enricher] New via_0 (→):`, enrichedRoutes[routeId].via_0);
      console.log(`[UZ Enricher] New via_1 (←):`, enrichedRoutes[routeId].via_1);
    } else {
      console.log(`[UZ Enricher] No manual data for UZ route ${routeId}`);
    }
  });
  
  console.log('[UZ Enricher] Enrichment complete, returning', Object.keys(enrichedRoutes).length, 'routes');
  
  return enrichedRoutes;
}

module.exports = {
  enrichStopsData,
  enrichRoutesData,
  loadManualData,
};
