// scripts/lib/plk.mjs
// Pure PLK Open Data transforms — no network, no filesystem. The adapter
// (scripts/adapters/pkp-plk.mjs) owns fetch + orchestration and re-exports
// these for the existing unit tests.
//
// PLK ships names + times but no coordinates. Every stop list therefore goes
// through makeStopResolver() so each name lands on a station the map's stop
// table already has (see scripts/lib/station-resolver.mjs).

import {
  normalizeCity,
  extractKeysFromTripLabel,
} from "../../src/lib/pkpTrainKeyExtract.js";
import { fmtHHMM, summariseDates } from "./pkp-calendar.mjs";
import { buildVia } from "../../src/lib/pkpGtfsMerge.js";
import {
  buildStationIndex,
  resolveStationList,
} from "./station-resolver.mjs";
import STATION_ALIASES from "../../data/overrides/station-aliases.json" with { type: "json" };

// ── Field access ─────────────────────────────────────────────────────────────
// Confirmed from live responses (2026-07). Extra fallback names are kept for the
// /shortened variants and future-proofing; the first present value wins.
const pick = (obj, ...keys) => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if (obj[k] != null) return obj[k];
  return undefined;
};
const asArray = (v) => (Array.isArray(v) ? v : []);
const num = (v) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// /data-version returns schedule + operations GUIDs; we gate only on the
// schedule one (operations churns constantly). Shape unconfirmed, so probe the
// likely names/nesting; null just means "always fetch" (correct, un-optimized).
function scheduleVersionOf(v) {
  if (!v || typeof v !== "object") return null;
  const direct = pick(
    v,
    "schedulesVersion",
    "scheduleDataVersion",
    "scheduleVersion",
    "schedule",
    "schedules",
    "scheduleGuid",
  );
  if (direct != null && typeof direct !== "object") return String(direct);
  const sched = v.schedule ?? v.schedules;
  if (sched && typeof sched === "object") {
    const g = pick(sched, "version", "guid", "dataVersion", "id");
    if (g != null) return String(g);
  }
  for (const key of ["versions", "data", "result"]) {
    if (v[key] && typeof v[key] === "object") {
      const nested = scheduleVersionOf(v[key]);
      if (nested) return nested;
    }
  }
  return null;
}

export const FIELDS = {
  scheduleVersion: (v) => scheduleVersionOf(v),
  schedulesList: (v) =>
    Array.isArray(v)
      ? v
      : asArray(pick(v, "routes", "schedules", "items", "data")),
  routeTrainNumber: (r) =>
    pick(r, "nationalNumber", "trainNumber", "number", "commercialNumber"),
  // An international train carries a Polish national number AND the commercial
  // EN/EC number the rest of Europe (and our trip labels) use — e.g. EN 443 is
  // national 45402. Reading both lets us match by number instead of relying on
  // the endpoint-city fallback.
  routeInternationalNumbers: (r) => [
    pick(r, "internationalArrivalNumber"),
    pick(r, "internationalDepartureNumber"),
  ],
  routeCarrier: (r) => pick(r, "carrierCode", "carrier"),
  routeStations: (r) => asArray(pick(r, "stations", "stops", "points")),
  routeOperatingDates: (r) => asArray(pick(r, "operatingDates")),
  stopStationId: (s) => pick(s, "stationId", "stationCode", "id"),
  stopName: (s) => pick(s, "stationName", "name"),
  stopArrival: (s) =>
    pick(s, "arrivalTime", "plannedArrival", "arrival", "plannedArrivalTime"),
  stopDeparture: (s) =>
    pick(
      s,
      "departureTime",
      "plannedDeparture",
      "departure",
      "plannedDepartureTime",
    ),
  stopOrder: (s) => pick(s, "orderNumber", "sequence", "order"),
  // The /schedules response embeds its own station dictionary. The shape is
  // documented only as "object", so accept the three plausible encodings:
  // an array of {id,name}, or an id-keyed map to either a name or a {name}.
  inlineStations: (v) => {
    const dict = v?.dictionaries?.stations;
    const out = {};
    if (Array.isArray(dict)) {
      for (const st of dict) {
        const id = FIELDS.stationId(st);
        if (id != null) out[String(id)] = { name: FIELDS.stationName(st) };
      }
    } else if (dict && typeof dict === "object") {
      for (const [id, val] of Object.entries(dict)) {
        out[id] = typeof val === "string" ? { name: val } : { name: FIELDS.stationName(val) };
      }
    }
    return out;
  },
  stationList: (v) =>
    Array.isArray(v) ? v : asArray(pick(v, "stations", "items", "data")),
  stationTotalPages: (v) => pick(v, "totalPages", "pages", "pageCount"),
  stationId: (st) => pick(st, "id", "stationId", "code"),
  stationName: (st) => pick(st, "name", "stationName"),
};

/**
 * Canonicalize a PLK station name to its Back-on-Track form via the shared
 * alias table (data/overrides/station-aliases.json). PLK returns names
 * ASCII-folded or in an alternate form ("Bohumin", "Graz Hauptbahnhof") that
 * won't match BoT's coordinate-bearing stops ("Bohumín", "Graz Hbf"); mapping
 * them lets the stations join the map dots + route line. Unmapped names pass
 * through unchanged (never mis-mapped).
 * @param {string} name
 * @returns {string}
 */
export function canonicalizeStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[String(name).toLowerCase().trim()] ?? name;
}

/**
 * Build the stop-list resolver used for every PLK station list.
 *
 * PLK gives names and times but no coordinates, so a PLK station only reaches
 * the map if it names a station the map's stop table already has. This maps
 * each name through the hand-maintained alias table, then through the folded
 * stop-table lookup (see scripts/lib/station-resolver.mjs), and stamps the
 * matched station's coordinates onto the stop. The result is a stop list whose
 * every name renders as a map dot and chains into the route line.
 *
 * @param {object[]|object} stops  the map's stop table (Back-on-Track stops)
 * @returns {(list: object[]) => object[]} maps a PLK stop list in place-order
 */
export function makeStopResolver(stops) {
  const index = buildStationIndex(stops);
  return (list) => {
    const names = asArray(list).map((s) => canonicalizeStationName(s?.name));
    const matches = resolveStationList(names, index);
    return asArray(list).map((s, i) => {
      const hit = matches[i];
      // Unmatched names keep their alias-canonicalized spelling; they simply
      // stay coordinate-less, exactly as before.
      return hit
        ? { ...s, name: hit.name, lat: hit.lat, lon: hit.lon }
        : { ...s, name: names[i] };
    });
  };
}

// ── Pure transforms (exported for tests) ─────────────────────────────────────

/**
 * Normalize a PLK route's stop array into the bundle's stop shape
 * ({ name, arr, dep, lat, lon }). Stops are ordered by `orderNumber`; the name
 * is resolved from the stations dictionary by `stationId`; times "HH:MM:SS" →
 * "HH:MM". PLK has no coordinates, so lat/lon start null and are backfilled from
 * GTFS by reconcileStopCoords.
 * @param {object[]} rawStops
 * @param {Record<string, {name?: string}>} stationsById
 * @returns {{name: string, arr: string|null, dep: string|null, lat: number|null, lon: number|null}[]}
 */
export function normalizeStops(rawStops, stationsById = {}) {
  const ordered = asArray(rawStops)
    .map((s) => ({ s, order: num(FIELDS.stopOrder(s)) ?? 0 }))
    .sort((a, b) => a.order - b.order);

  const out = [];
  for (const { s } of ordered) {
    const id = FIELDS.stopStationId(s);
    const station = id != null ? stationsById[String(id)] : null;
    const name = FIELDS.stopName(s) ?? station?.name;
    if (!name) continue;
    out.push({
      name: String(name).trim(),
      arr: fmtHHMM(FIELDS.stopArrival(s)),
      dep: fmtHHMM(FIELDS.stopDeparture(s)),
      lat: null,
      lon: null,
    });
  }
  return out;
}

/**
 * Every train number a candidate answers to (national + international), as
 * trimmed strings. Falls back to the single `number` so candidate lists cached
 * by an older run keep matching.
 * @param {{number?: string, numbers?: string[]}} candidate
 * @returns {string[]}
 */
export function candidateNumbers(candidate) {
  const all = candidate?.numbers ?? [candidate?.number];
  return [...new Set(all.map((n) => String(n ?? "").trim()).filter(Boolean))];
}

/** Order-independent: do two stop lists share the same endpoint cities? */
export function endpointsMatch(a, b) {
  if (!a?.length || !b?.length) return false;
  const a0 = normalizeCity(a[0]?.name);
  const a1 = normalizeCity(a[a.length - 1]?.name);
  const b0 = normalizeCity(b[0]?.name);
  const b1 = normalizeCity(b[b.length - 1]?.name);
  if (!a0 || !a1 || !b0 || !b1) return false;
  return (a0 === b0 && a1 === b1) || (a0 === b1 && a1 === b0);
}

/**
 * Is this operator one of the row's operators?
 *
 * A row's operator field holds a partnership as a slash list ("PKP/ČD",
 * "MÁV/PKP"), and a row replaced by an official source keeps Back-on-Track's
 * attribution in bot_agency_id. A substring test over both covers every
 * combination — including ones that do not exist yet — where PKP runs the
 * train or shares it with a partner.
 * @param {object} row  a view-map row
 * @param {string} operator  e.g. "PKP"
 */
export function isOperatedBy(row, operator) {
  const fields = `${row?.agency_id ?? ""}/${row?.bot_agency_id ?? ""}`;
  return fields.toUpperCase().includes(String(operator).toUpperCase());
}

/** Order-independent endpoint-city key for a stop list ("a|b", sorted). */
export function endpointKey(stops) {
  if (!stops || stops.length < 2) return "";
  const a = normalizeCity(stops[0]?.name);
  const b = normalizeCity(stops[stops.length - 1]?.name);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

/**
 * Fill missing PLK stop coordinates from the GTFS stop list (matched by city),
 * so compound-label stitching (which cuts polylines at junction coords) keeps
 * working after we swap in the richer PLK stops. Foreign stops absent from the
 * Polish GTFS keep null coords (they still render in the station-list text).
 */
export function reconcileStopCoords(plkStops, gtfsStops) {
  const gtfsByCity = new Map();
  for (const g of asArray(gtfsStops)) {
    const c = normalizeCity(g?.name);
    if (
      c &&
      !gtfsByCity.has(c) &&
      Number.isFinite(g?.lat) &&
      Number.isFinite(g?.lon)
    ) {
      gtfsByCity.set(c, { lat: g.lat, lon: g.lon });
    }
  }
  return plkStops.map((s) => {
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) return s;
    const fallback = gtfsByCity.get(normalizeCity(s.name));
    return fallback ? { ...s, lat: fallback.lat, lon: fallback.lon } : s;
  });
}

/**
 * Fold PLK stop lists into the GTFS bundle. For each `byTrainKey` entry (and its
 * `variants`), pick the PLK candidate that (a) matches the entry's corridor
 * endpoints and (b) is at least as detailed, preferring a same-`number`
 * candidate, then falling back to any endpoint match (international trains carry
 * a national number ≠ the commercial one). Replace `stops` (coords reconciled
 * from GTFS); geometry/calendar are untouched. Reused numbers can't
 * cross-contaminate — endpoint validation rejects wrong-corridor candidates.
 *
 * @param {Record<string, object>} byTrainKey
 * @param {{number?: string, stops: object[]}[]} candidates
 * @returns {{ byTrainKey: Record<string, object>, enrichedCount: number }}
 */
export function mergePlkIntoBundle(
  byTrainKey,
  candidates = [],
  resolveStops = (list) => list,
) {
  const list = asArray(candidates).filter((c) => c?.stops?.length >= 2);
  const byNumber = new Map();
  for (const c of list) {
    // Indexed under every number the train answers to, so a bundle key holding
    // the commercial number (443) finds a candidate filed under the national
    // one (45402) without falling back to endpoint matching.
    for (const n of candidateNumbers(c)) {
      if (!byNumber.has(n)) byNumber.set(n, []);
      byNumber.get(n).push(c);
    }
  }

  const bestMatch = (pool, existingStops) => {
    let best = null;
    for (const c of pool) {
      if (
        endpointsMatch(c.stops, existingStops) &&
        c.stops.length >= existingStops.length &&
        (!best || c.stops.length > best.stops.length)
      ) {
        best = c;
      }
    }
    return best;
  };

  const matchFor = (existingStops, key) => {
    if (!existingStops || existingStops.length < 2) return null;
    // Prefer a candidate carrying the same national number, then any candidate
    // whose endpoints match (covers international national-number mismatches).
    return (
      bestMatch(byNumber.get(key) ?? [], existingStops) ??
      bestMatch(list, existingStops)
    );
  };

  // Resolve PLK names onto the map's own stations (names + coordinates) so
  // international stops match coordinate-bearing stops. Matching itself is
  // city-level and unaffected.
  const canon = (stops) => resolveStops(stops);

  const out = {};
  let enrichedCount = 0;
  for (const [key, entry] of Object.entries(byTrainKey)) {
    const next = { ...entry };
    const m = matchFor(entry.stops, key);
    if (m) {
      next.stops = reconcileStopCoords(canon(m.stops), entry.stops);
      enrichedCount += 1;
    }
    if (Array.isArray(entry.variants)) {
      next.variants = entry.variants.map((v) => {
        const mv = matchFor(v.stops, key);
        if (mv) {
          enrichedCount += 1;
          return { ...v, stops: reconcileStopCoords(canon(mv.stops), v.stops) };
        }
        return v;
      });
    }
    out[key] = next;
  }
  return { byTrainKey: out, enrichedCount };
}

/**
 * Build PLK station-list enrichment for one Back-on-Track PKP row. Matches a PLK
 * candidate per direction by ORIENTED endpoints (first stop == origin, last ==
 * destination) so per-direction times are correct, preferring a same-number
 * candidate. Returns { pkp_schedule_0/1, pkp_valid_0/1, via_0/1 } to set — via_
 * drives the BoT-coordinate map dots + line (PLK has no geometry of its own).
 * Callers apply this to every PKP-operated row that is not Nightjet-covered.
 * @param {object} row  a Back-on-Track view-map row
 * @param {{number?: string, stops: object[], operatingDates?: string[]}[]} candidates
 * @returns {object|null} partial row fields, or null when nothing matched
 */
export function plkScheduleForRow(
  row,
  candidates,
  resolveStops = (list) => list,
) {
  const list = asArray(candidates).filter((c) => c?.stops?.length >= 2);
  if (!row || list.length === 0) return null;

  const out = {};
  let matched = false;
  for (const d of [0, 1]) {
    const o = normalizeCity(row[`origin_trip_${d}`]);
    const z = normalizeCity(row[`destination_trip_${d}`]);
    if (!o || !z) continue;
    const keys = new Set(extractKeysFromTripLabel(row[`trip_short_name_${d}`]));

    let best = null;
    let bestPreferred = false;
    for (const c of list) {
      // Oriented match keeps the arrival/departure times for THIS direction.
      if (normalizeCity(c.stops[0]?.name) !== o) continue;
      if (normalizeCity(c.stops[c.stops.length - 1]?.name) !== z) continue;
      const preferred = candidateNumbers(c).some((n) => keys.has(n));
      if (
        !best ||
        (preferred && !bestPreferred) ||
        (preferred === bestPreferred && c.stops.length > best.stops.length)
      ) {
        best = c;
        bestPreferred = preferred;
      }
    }
    if (!best) continue;

    // Resolve PLK names onto the map's own stations, which also supplies the
    // coordinates PLK lacks.
    const stops = resolveStops(best.stops);
    out[`pkp_schedule_${d}`] = stops.map((s) => ({
      name: s.name,
      arr: s.arr ?? null,
      dep: s.dep ?? null,
      lat: s.lat ?? null,
      lon: s.lon ?? null,
    }));
    // List the intermediate stations in via_${d}: deriveCities() links them to
    // this route → map dots, and buildAllRoutesPaths chains them into the line.
    // Both look the names up in the stop table, which is exactly what
    // resolveStops matched them against, so every station renders.
    const via = buildVia(
      stops,
      row[`origin_trip_${d}`],
      row[`destination_trip_${d}`],
    );
    if (via) out[`via_${d}`] = via;
    // Only attach a validity line when PLK gives a real multi-day span — the
    // single-day bulk pull would otherwise show a misleading one-date calendar.
    const cal = summariseDates(best.operatingDates);
    if (cal.validFrom && cal.validUntil && cal.validFrom !== cal.validUntil) {
      out[`pkp_valid_${d}`] = cal;
    }
    matched = true;
  }
  return matched ? out : null;
}

/** Does either direction of this row run as one of the given trains? */
export function coveredBy(row, trainNames) {
  if (!trainNames?.size) return false;
  return [row?.trip_short_name_0, row?.trip_short_name_1].some(
    (label) => label && trainNames.has(String(label).trim()),
  );
}

