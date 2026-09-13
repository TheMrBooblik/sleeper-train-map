/**
 * Groups overlapping city markers for the map.
 * When isGrouped is true, stations in the same city (e.g. "Amsterdam Centraal", "Amsterdam Sloterdijk")
 * are combined into one marker anchored on the city's principal station.
 */
import { distanceKm } from "./returnGeometryBranches.js";

/**
 * Names that say "this is the city's main station" in the languages the dataset
 * actually contains. Direction words — Nord, Süd, Est, West, Ost — are
 * deliberately absent: they say where a station points, not what rank it holds,
 * and including "nord" picks Bruxelles Nord over Midi and Paris Gare du Nord
 * over Austerlitz.
 */
const PRINCIPAL_STATION_NAME =
  /(\bhbf\b|hauptbahnhof|\bhl\.\s?n\.|hlavní nádraží|\bhl\.\s?st\.|centrale\b|centraal\b|\bcentral\b|centralna\b|\bgł(ówny)?\.?\b|\btermini\b|sentralstasjon)/i;

/**
 * Which station a grouped marker sits on.
 *
 * The marker used to sit at the AVERAGE of its members, and an average is never
 * a place. With one station in the bucket that costs nothing; the moment a
 * second arrives the dot slides into the countryside between them. Oslo is the
 * case that showed it: the Entur enrichment put "Oslo Airport Gardermoen" into a
 * via list, so the bucket went from one station to two and the Oslo dot moved
 * 18.6 km out of Oslo, onto no station at all.
 *
 * So anchor it on a real station instead — and on the RIGHT one, which needs
 * more than "the first non-via member" (that picks Frankfurt's airport and
 * Berlin Gesundbrunnen) and more than "the most routes" (that picks München Ost
 * over Hbf, and Venezia Mestre over Santa Lucia). Three rules, in order:
 *
 *   1. a name that declares itself principal — Hbf, hl.n., Centrale, Główny,
 *      Termini — and among several, the one serving most routes;
 *   2. else the busiest station the city's trains START or END at, which is what
 *      fixes Oslo (Oslo S is an endpoint, Gardermoen is via-only) and is the
 *      right answer wherever a city has no "Hauptbahnhof" by name: İstanbul
 *      Halkalı and Shanghai Songjiang really are where those trains call;
 *   3. else the busiest station in the bucket.
 *
 * Every anchor is somewhere a train actually stops, which is the property the
 * average could never have.
 *
 * @param {Array} stations one proximity cluster
 * @param {object} cities  deriveCities output (route ids + isViaStation)
 * @param {(name: string) => string} normalizeForLookup
 * @returns {object} the station the marker takes its position and identity from
 */
export function pickAnchorStation(stations, cities, normalizeForLookup) {
  const infoFor = (station) =>
    cities[normalizeForLookup(station.stop_id)] || cities[station.stop_id] || {};
  const routeCount = (station) =>
    String(infoFor(station).stop_route_ids || "").split(",").filter(Boolean).length;
  // Ties break on the earlier member so the anchor cannot flip between renders.
  const busiest = (list) =>
    list.reduce((best, s) => (routeCount(s) > routeCount(best) ? s : best), list[0]);

  const named = stations.filter((s) => PRINCIPAL_STATION_NAME.test(s.stop_id ?? ""));
  if (named.length) return busiest(named);

  const endpoints = stations.filter((s) => infoFor(s).isViaStation === false);
  if (endpoints.length) return busiest(endpoints);

  return busiest(stations);
}

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
        // Identity and position both come from the anchor, so the dot sits on
        // the station whose name it carries. The old ladder preferred a member
        // with a custom coordinate and otherwise averaged; the anchor's own
        // coordinate already is that custom value where one exists, since
        // enrichStationsWithCoordinates applied it upstream.
        const anchor = pickAnchorStation(
          stations,
          cities,
          normalizeStationNameForLookup,
        );

        groupedMarkers.push({
          ...anchor,
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
