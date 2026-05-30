/**
 * Stations that should be hidden from the map.
 *
 * The list lives in data/overrides/stations-to-skip.json so it can be edited
 * through the admin panel and committed as a structured override.
 * Names must match exactly as they appear in the API data.
 */
import stationsToSkip from "../../data/overrides/stations-to-skip.json";

export { stationsToSkip };
