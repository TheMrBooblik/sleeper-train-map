/**
 * Station name aliases (NightJet German names → canonical Back-on-Track names).
 *
 * The implementation lives in the shared, node-runnable primitives module
 * (src/pages/api/lib/primitives.mjs) so the live API routes and the build-time
 * canonicalize script share one definition. Re-exported here to preserve the
 * existing import path.
 */
export {
  STATION_ALIASES,
  resolveCanonicalStationName,
} from "../pages/api/lib/primitives.mjs";
