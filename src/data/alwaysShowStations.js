/**
 * Stations that stay visible when the map is zoomed out (grid thinning skips
 * them) so major cities don't disappear.
 *
 * The list lives in data/overrides/always-show-stations.json so it can be
 * edited through the admin panel and committed as a structured override.
 * Name matching is normalized later with normalizeStationNameForLookup().
 */
import alwaysShowStations from "../../data/overrides/always-show-stations.json";

export { alwaysShowStations };
