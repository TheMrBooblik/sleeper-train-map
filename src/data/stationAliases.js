/**
 * Station name aliases (NightJet German names → canonical Back-on-Track names).
 *
 * The data lives in data/overrides/station-aliases.json (editable through the
 * admin panel). This module imports the JSON directly so webpack can bundle it
 * for client-side code. The server-only primitives.mjs reads the same file
 * with fs for Node/build-time use.
 */
import STATION_ALIASES from "../../data/overrides/station-aliases.json";

export { STATION_ALIASES };

/** Resolve a station name to its canonical Back-on-Track form. */
export function resolveCanonicalStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[name.toLowerCase().trim()] ?? name;
}
