/**
 * Groups overlapping city markers for the map.
 * When isGrouped is true, stations in the same city (e.g. "Amsterdam Centraal", "Amsterdam Sloterdijk")
 * are combined into one marker with averaged/prioritized coordinates.
 */
import { distanceKm } from "./returnGeometryBranches.js";

/**
 * A city name is not a location. normalizeStationNameForDisplay matches on
 * substrings, so "Florence Amtrak Station" (South Carolina) lands in the same
 * bucket as Firenze Castello and Firenze Campo Marte — and because the grouped
 * marker sits at the AVERAGE of its members, that one station dragged the
 * Florence dot to [40.6, -19.1], the middle of the Atlantic. So a name bucket is
 * split into proximity clusters first and each cluster gets its own marker.
 */
const CLUSTER_RADIUS_KM = 60;

/**
 * Single-link clustering: two stations join the same cluster when they are
 * within CLUSTER_RADIUS_KM of each other, transitively. Cities sprawl (Berlin
 * Spandau to Berlin Ostbahnhof is ~20 km, Paris to Cormeilles-en-Parisis ~18),
 * so the radius is generous — it is meant to catch continents apart, not to
 * second-guess which stations belong to a city.
 *
 * @param {Array} stations - stops carrying stop_lat / stop_lon
 * @returns {Array[]} one array of stations per cluster
 */
function clusterByProximity(stations) {
  if (stations.length < 2) return [stations];

  const parent = stations.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      const d = distanceKm(
        stations[i].stop_lat,
        stations[i].stop_lon,
        stations[j].stop_lat,
        stations[j].stop_lon,
      );
      if (d <= CLUSTER_RADIUS_KM) parent[find(i)] = find(j);
    }
  }

  const byRoot = new Map();
  stations.forEach((station, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(station);
  });
  return [...byRoot.values()];
}

/**
 * @param {Array} stops - List of stop objects with stop_id, stop_lat, stop_lon
 * @param {Object} cities - City/station info keyed by normalized name (from useCities)
 * @param {boolean} isGrouped - Whether to group by city
 * @param {function(string): string} normalizeStationName - Display normalization (e.g. "Amsterdam")
 * @param {function(string): string} normalizeStationNameForLookup - Lookup key normalization
 * @returns {Array} List of stop objects, possibly grouped (with displayName, isGrouped, groupedStations, etc.)
 */
export function groupCityMarkers(
  stops,
  cities,
  isGrouped,
  normalizeStationName,
  normalizeStationNameForLookup,
) {
  if (!stops || !stops.length) return [];

  if (!isGrouped) {
    return stops.map((stop) => ({
      ...stop,
      originalName: stop.stop_id,
      normalizedName: stop.stop_id,
      displayName: stop.stop_id,
      isGrouped: false,
    }));
  }

  const cityGroups = {};

  stops.forEach((stop) => {
    if (!stop?.stop_id || !stop?.stop_lat || !stop?.stop_lon) return;

    const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
    const cityInfo = cities[normalizedStopId] || cities[stop.stop_id];
    if (!cityInfo?.stop_route_ids) return;

    const normalizedCityName = normalizeStationName(stop.stop_id);

    if (!cityGroups[normalizedCityName]) {
      cityGroups[normalizedCityName] = [];
    }
    cityGroups[normalizedCityName].push({
      ...stop,
      originalName: stop.stop_id,
      normalizedName: normalizedCityName,
    });
  });

  const groupedMarkers = [];

  Object.entries(cityGroups).forEach(([cityName, allStations]) => {
    for (const stations of clusterByProximity(allStations)) {
      if (stations.length === 1) {
        groupedMarkers.push({
          ...stations[0],
          displayName: cityName,
          isGrouped: false,
        });
      } else {
        const mainStation =
          stations.find((station) => {
            const normalizedId = normalizeStationNameForLookup(station.stop_id);
            const cityInfo = cities[normalizedId] || cities[station.stop_id];
            return cityInfo && !cityInfo.isViaStation;
          }) || stations[0];

        let finalLat, finalLon;
        if (mainStation.coordinatesSource === "custom") {
          finalLat = mainStation.stop_lat;
          finalLon = mainStation.stop_lon;
        } else {
          const withCustom = stations.filter(
            (s) => s.coordinatesSource === "custom",
          );
          if (withCustom.length > 0) {
            finalLat =
              withCustom.reduce((sum, s) => sum + s.stop_lat, 0) /
              withCustom.length;
            finalLon =
              withCustom.reduce((sum, s) => sum + s.stop_lon, 0) /
              withCustom.length;
          } else {
            finalLat =
              stations.reduce((sum, s) => sum + s.stop_lat, 0) /
              stations.length;
            finalLon =
              stations.reduce((sum, s) => sum + s.stop_lon, 0) /
              stations.length;
          }
        }

        groupedMarkers.push({
          ...mainStation,
          stop_lat: finalLat,
          stop_lon: finalLon,
          groupedStations: stations,
          isGrouped: true,
          groupSize: stations.length,
          displayName: cityName,
        });
      }
    }
  });

  return groupedMarkers;
}
