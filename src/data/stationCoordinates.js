/**
 * Manually verified station coordinates that take priority over the
 * Open Night Train Database values (which are sometimes wrong).
 *
 * The data lives in data/overrides/station-coordinates.json so it can be
 * edited through the admin panel and committed as a structured override.
 * Format: { "Station Name": { lat: number, lon: number } }
 */
import stationCoordinates from "../../data/overrides/station-coordinates.json";

export { stationCoordinates };
