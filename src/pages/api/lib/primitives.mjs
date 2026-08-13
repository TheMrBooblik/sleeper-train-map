// lib/primitives.mjs
// Pure, dependency-free helpers shared by the live API routes and the
// build-time canonicalize script. ESM (.mjs) so raw `node` can import it
// without transpilation; `.mjs` is not in Next's default pageExtensions, so
// this file is never exposed as an API route.
//
// Single source of truth — the legacy locations re-export from here:
//   src/lib/trainOperatorsFilter.js  → isTrain4you, TRAIN4YOU_AGENCY_ID
//   src/data/stationAliases.js       → STATION_ALIASES, resolveCanonicalStationName
//   src/pages/api/trains.js          → route-id / view-map activity helpers

// ─── Active-record filter ──────────────────────────────────────────────────

export function isActiveRecord(record) {
  return (record?.is_active || "Y").toString().toUpperCase() !== "N";
}

// ─── Agency scoping for bare train numbers ──────────────────────────────────

// Bare train numbers are only unique within an operator: Back-on-Track carries
// a CFM/CFR 401 (Prietenia) and an SJN 475 (Trondheim–Bodø) alongside European
// Sleeper's ES 401 and ES 475. A source that matches BoT rows by bare number
// must therefore be able to say which operators' rows can legitimately match,
// or an unrelated namesake silently swallows its train.
//
// An empty/absent list means "any row", which is the historical behaviour and
// stays correct for sources whose keys are already operator-prefixed ("NJ 403").
export function inAgencyScope(route, agencyIds) {
  if (!Array.isArray(agencyIds) || agencyIds.length === 0) return true;
  return agencyIds.includes((route?.agency_id ?? "").toString().trim());
}

// ─── Train4you (Urlaubs-Express / UEX) detection ────────────────────────────

export const TRAIN4YOU_AGENCY_ID = "UEX";

const TRAIN4YOU_PATTERNS = [
  /train\s*4\s*you/i,
  /train4you/i,
  /vertriebs\s*gmbh/i,
  /t4y\s*\d*/i,
  /^\s*T4Y\s+/i,
];

export function isTrain4you(item = {}, tripName = "") {
  const agencyId = (item?.agency_id || "").toString().trim();
  if (agencyId === TRAIN4YOU_AGENCY_ID) {
    return true;
  }

  const name =
    tripName || item?.trip_short_name || item?.route_short_name || "";
  const operator = (item?.operator || "").toString();
  const combined = `${name} ${operator}`.toLowerCase();
  return TRAIN4YOU_PATTERNS.some(
    (re) => re.test(combined) || re.test(name) || re.test(operator),
  );
}

// ─── Station name aliases (NightJet German names → canonical BoT names) ──────
// Data lives in data/overrides/station-aliases.json (editable through the admin
// panel). Keys are lowercase alias names; values are canonical BoT names.
//
// Imported via ESM JSON import attribute so the bundler inlines the file into
// the lambda — avoids the Vercel "ENOENT" trap where data/ is outside public/
// and isn't traced into the function bundle. Works equally in raw Node 20.6+
// (used by scripts/canonicalize.mjs).
import STATION_ALIASES from "../../../../data/overrides/station-aliases.json" with { type: "json" };

export { STATION_ALIASES };

export function resolveCanonicalStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[name.toLowerCase().trim()] ?? name;
}

// ─── view_ontd_map row activity (trips.json is authoritative per service) ────

export function routeIdsReferencedInTrips(trips) {
  const ids = new Set();
  for (const t of Object.values(trips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

export function routeIdsFromFilteredTrips(filteredTrips) {
  const ids = new Set();
  for (const t of Object.values(filteredTrips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

export function keepViewMapRowForTripActivity(
  routeRowAllowed,
  routeId,
  referencedIds,
  visibleIds,
) {
  if (!routeRowAllowed) return false;
  if (routeId == null) return true;
  const rid = String(routeId);
  if (!referencedIds.has(rid)) return true;
  return visibleIds.has(rid);
}
