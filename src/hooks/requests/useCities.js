// The normalizer itself moved to src/lib/stationKey.mjs so raw-node scripts and
// tests can import it (see that file's header). Re-exported here because it is
// imported from this path across the map components and helpers.
export { normalizeStationNameForLookup } from "../../lib/stationKey.mjs";
