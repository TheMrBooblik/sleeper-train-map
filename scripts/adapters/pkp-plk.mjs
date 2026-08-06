// scripts/adapters/pkp-plk.mjs
// Official PLK "Otwarte Dane Kolejowe" (Open Railway Data) API adapter.
// https://pdp-api.plk-sa.pl/api-documentation — the infrastructure manager's
// authoritative planned schedule. Its stations dictionary and per-train stop
// lists reach across the border (Berlin/Praha/Wien confirmed), so it carries the
// international station names GTFS's Polish feed lacks. Base URL
// https://pdp-api.plk-sa.pl/api/v1, auth via the X-API-Key header (PLK_API_KEY).
//
// SUPPLEMENT strategy: PLK has no coordinates and no track geometry — just names
// + times per stop (station referenced by id → resolved via the dictionary). So
// we keep the GTFS/OSM polylines and only fold PLK's richer stop lists into the
// existing public/data/gtfs/pkpTrainShapes.json `byTrainKey` bundle (coords
// reconciled from GTFS by city; missing foreign coords stay null — fine for the
// station-list text). Every consumer (attachPkpGtfsPolylinesToViewMap, the
// gtfsBundle enrichment, pkpEntryForRoute) keeps working: the bundle shape is
// preserved. The GTFS parser regenerates the file every run, so we re-apply the
// fold every run, but only hit the network when /data-version changed.
//
// Fetch: one bulk `/schedules?carriersInclude=IC` pull returns every IC train
// (nationalNumber + stations[]) in a single response; we filter to our scoped
// night-train set in memory. Matching GTFS↔PLK is by number OR endpoint cities
// (international trains often carry a Polish national number ≠ the commercial
// EC/EN number, so endpoint match is the fallback).
//
// Field
// reads are centralized in FIELDS. The adapter never throws: any failure leaves
// the bundle as GTFS-only.

import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import {
  normalizeCity,
  extractKeysFromTripLabel,
  pkpEntryForRoute,
} from "../../src/lib/pkpTrainKeyExtract.js";
import { fmtHHMM, summariseDates } from "../lib/pkp-calendar.mjs";
import { buildVia } from "../../src/lib/pkpGtfsMerge.js";
import STATION_ALIASES from "../../data/overrides/station-aliases.json" with { type: "json" };

const BASE_URL = "https://pdp-api.plk-sa.pl/api/v1";
const SHAPES_REL = "public/data/gtfs/pkpTrainShapes.json";

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
  canonicalize = (s) => s,
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

  // Canonicalize PLK names to BoT form so international stops match BoT
  // coordinate-bearing stations (matching itself is city-level and unaffected).
  const canon = (stops) =>
    stops.map((s) => (s?.name ? { ...s, name: canonicalize(s.name) } : s));

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
 * Callers apply this only to rows the GTFS bundle can't resolve.
 * @param {object} row  a Back-on-Track view-map row
 * @param {{number?: string, stops: object[], operatingDates?: string[]}[]} candidates
 * @returns {object|null} partial row fields, or null when nothing matched
 */
export function plkScheduleForRow(row, candidates, canonicalize = (s) => s) {
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

    // Canonicalize PLK names to Back-on-Track form (data/overrides/station-
    // aliases.json) so the stations match BoT coordinate-bearing stops.
    const stops = best.stops.map((s) => ({ ...s, name: canonicalize(s.name) }));
    out[`pkp_schedule_${d}`] = stops.map((s) => ({
      name: s.name,
      arr: s.arr ?? null,
      dep: s.dep ?? null,
      lat: null,
      lon: null,
    }));
    // List the intermediate stations in via_${d}: deriveCities() links them to
    // this route → map dots, and buildAllRoutesPaths chains them into the line —
    // both resolved from Back-on-Track station coordinates (PLK has none). Names
    // BoT doesn't know simply don't render, which is harmless.
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

// Stamp official_sources like enrich-view-map.mjs so the classifier auto-approves.
function stampOfficialSource(route, sourceId) {
  const existing = Array.isArray(route.official_sources)
    ? route.official_sources
    : [];
  route.official_sources = [...new Set([...existing, sourceId])].sort();
}

// ── I/O + network ────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

/** ISO date `days` after `from` (the API accepts a window of up to 31 days). */
function datePlus(from, days) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function readScrapedData(rootDir, relPath) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(rootDir, relPath), "utf8"))?.data ??
      null
    );
  } catch {
    return null;
  }
}

async function getJson(url, apiKey, budget) {
  if (budget.used >= budget.max) return { ok: false, status: 0, capped: true };
  budget.used += 1;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { "X-API-Key": apiKey, accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
  const hourly = Number(res.headers.get("x-ratelimit-hourly-remaining"));
  if (Number.isFinite(hourly)) budget.rateRemaining = hourly;
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json().catch(() => null);
  return { ok: true, status: res.status, json };
}

/** Dictionary id → { name } for every station (paginated, budget-capped). */
async function loadStationNames({ apiKey, budget, params, log }) {
  const stationsById = {};
  const pageSize = params.stationsPageSize ?? 5000;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    if (
      budget.used >= budget.max ||
      budget.rateRemaining <= (params.rateFloor ?? 10)
    )
      break;
    const resp = await getJson(
      `${BASE_URL}/dictionaries/stations?page=${page}&pageSize=${pageSize}`,
      apiKey,
      budget,
    );
    if (!resp.ok) {
      log(`stations page ${page} → ${resp.status || resp.error}`);
      break;
    }
    for (const st of FIELDS.stationList(resp.json)) {
      const id = FIELDS.stationId(st);
      if (id != null)
        stationsById[String(id)] = { name: FIELDS.stationName(st) };
    }
    totalPages = Number(FIELDS.stationTotalPages(resp.json)) || 1;
  }
  return stationsById;
}

/**
 * One bulk `/schedules?carriersInclude=IC` pull → the candidate list, filtered
 * to routes whose number OR endpoint-city pair is in our scoped night-train set.
 * @returns {{number: string, stops: object[]}[] | null}
 */
async function fetchScoped({
  apiKey,
  budget,
  scopedNumbers,
  scopedEpKeys,
  params,
  log,
}) {
  const dateFrom = params.date || today();
  // A single-day pull only sees trains running today, so a night train that
  // runs three times a week is invisible on the other four. Cover a window
  // instead (the API allows up to 31 days) — still one request.
  const dateTo =
    params.dateTo || datePlus(dateFrom, Math.min(params.dayWindow ?? 7, 30));
  const carrier = params.carriersInclude || "IC";
  const resp = await getJson(
    `${BASE_URL}/schedules?carriersInclude=${encodeURIComponent(carrier)}` +
      `&dateFrom=${dateFrom}&dateTo=${dateTo}&fullRoute=true`,
    apiKey,
    budget,
  );
  if (!resp.ok) {
    log(`schedules → ${resp.status || resp.error}`);
    return null;
  }
  const routes = FIELDS.schedulesList(resp.json);
  if (routes.length === 0) {
    log("schedules: empty response");
    return [];
  }

  // The response ships the station dictionary inline (dictionaries=true is the
  // API default), so the paginated /dictionaries/stations call is only needed
  // when that is missing — one fewer request on a normal night.
  const inline = FIELDS.inlineStations(resp.json);
  const stationsById = Object.keys(inline).length
    ? inline
    : await loadStationNames({ apiKey, budget, params, log });
  log(`stations: ${Object.keys(stationsById).length} names`);

  const candidates = [];
  for (const r of routes) {
    const stations = FIELDS.routeStations(r);
    if (stations.length < 2) continue;
    const stops = normalizeStops(stations, stationsById);
    if (stops.length < 2) continue;
    const number = String(FIELDS.routeTrainNumber(r) ?? "").trim();
    const numbers = candidateNumbers({
      numbers: [number, ...FIELDS.routeInternationalNumbers(r)],
    });
    if (
      numbers.some((n) => scopedNumbers.has(n)) ||
      scopedEpKeys.has(endpointKey(stops))
    ) {
      candidates.push({
        number,
        numbers,
        stops,
        operatingDates: FIELDS.routeOperatingDates(r),
      });
    }
  }
  log(
    `bulk ${dateFrom}..${dateTo}: ${routes.length} ${carrier} route(s) → ${candidates.length} scoped candidate(s)`,
  );
  return candidates;
}

/** Merge candidate lists, keyed by number#endpoints; later lists win (fresher). */
function dedupCandidates(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const c of asArray(list)) {
      if (!c?.stops?.length) continue;
      map.set(`${c.number ?? ""}#${endpointKey(c.stops)}`, c);
    }
  }
  return [...map.values()];
}

/** Registry adapter entrypoint. */
export async function run(entry, ctx) {
  const log = (m) => console.log(`[pkp-plk] ${m}`);
  const apiKey = process.env.PLK_API_KEY;
  if (!apiKey) {
    log("PLK_API_KEY not set — skipping (bundle left as GTFS-only)");
    return;
  }

  const rootDir = ctx.rootDir;
  const shapesPath = path.join(rootDir, SHAPES_REL);
  let shapes;
  try {
    shapes = JSON.parse(fs.readFileSync(shapesPath, "utf8"));
  } catch {
    log("pkpTrainShapes.json missing — nothing to enrich");
    return;
  }
  const byTrainKey = shapes?.byTrainKey;
  if (!byTrainKey || Object.keys(byTrainKey).length === 0) {
    log("empty GTFS bundle — skip");
    return;
  }

  const scopedNumbers = new Set(Object.keys(byTrainKey));
  const scopedEpKeys = new Set();
  for (const e of Object.values(byTrainKey)) {
    for (const s of [e.stops, ...(e.variants ?? []).map((v) => v.stops)]) {
      const k = endpointKey(s);
      if (k) scopedEpKeys.add(k);
    }
  }

  const params = entry.params || {};
  // Widen scope to Back-on-Track PKP rows so GTFS-less through-car routes (e.g.
  // Warszawa–Rijeka) keep a candidate from the bulk pull.
  const viewMap = ctx.shared?.viewMap ?? null;
  const vmAgencyIds = params.viewMapAgencyIds ?? ["PKP", "PKP/ČD", "MÁV/PKP"];
  const isPkpRow = (r) =>
    vmAgencyIds.includes((r?.agency_id ?? "").toString().trim());
  if (viewMap) {
    for (const route of Object.values(viewMap)) {
      if (!isPkpRow(route)) continue;
      for (const d of [0, 1]) {
        for (const k of extractKeysFromTripLabel(route[`trip_short_name_${d}`]))
          scopedNumbers.add(k);
        const ep = endpointKey([
          { name: route[`origin_trip_${d}`] },
          { name: route[`destination_trip_${d}`] },
        ]);
        if (ep) scopedEpKeys.add(ep);
      }
    }
  }
  const budget = {
    used: 0,
    max: params.maxRequestsPerRun ?? 80,
    rateRemaining: Infinity,
  };
  const prev = readScrapedData(rootDir, `public/data/scraped/${entry.output}`);

  // 1) data-version gate (1 request) — skip the fetch when nothing changed.
  const dv = await getJson(`${BASE_URL}/data-version`, apiKey, budget);
  const currentVersion = dv.ok
    ? (FIELDS.scheduleVersion(dv.json) ?? null)
    : null;

  let candidates = Array.isArray(prev?.candidates) ? prev.candidates : [];
  let dataVersion = prev?.dataVersion ?? null;

  const unchanged =
    currentVersion &&
    dataVersion &&
    currentVersion === dataVersion &&
    candidates.length > 0;

  if (unchanged) {
    log(
      `data unchanged (${currentVersion}) — re-applying ${candidates.length} cached candidate(s), 0 further requests`,
    );
  } else {
    const fetched = await fetchScoped({
      apiKey,
      budget,
      scopedNumbers,
      scopedEpKeys,
      params,
      log,
    });
    if (fetched && fetched.length) {
      candidates = dedupCandidates(candidates, fetched); // fresher fetch wins; keeps trains not running today
      dataVersion = currentVersion ?? dataVersion;
    } else if (candidates.length) {
      log("fetch produced nothing — re-applying cached candidates");
    } else {
      log("no PLK data available — leaving bundle as GTFS-only");
      return;
    }
  }

  // 2) Fold PLK stops into the freshly-regenerated GTFS bundle (supplement).
  const { byTrainKey: merged, enrichedCount } = mergePlkIntoBundle(
    byTrainKey,
    candidates,
    canonicalizeStationName,
  );
  shapes.byTrainKey = merged;
  shapes.plkEnrichedAt = new Date().toISOString();
  shapes.plkDataVersion = dataVersion ?? null;
  fs.writeFileSync(shapesPath, JSON.stringify(shapes) + "\n", "utf8");
  log(
    `enriched ${enrichedCount}/${Object.keys(merged).length} bundle entries from PLK (${budget.used} request(s))`,
  );

  // 2b) Enrich GTFS-less PKP rows in the Back-on-Track view map (through-car
  // routes like Warszawa–Rijeka the Polish GTFS doesn't carry): set the detail-
  // panel station list (pkp_schedule_*) plus via_* (map dots + line) from PLK,
  // station names canonicalized to BoT form; geometry stays BoT/GTFS-derived.
  if (viewMap && candidates.length) {
    let vmEnriched = 0;
    for (const route of Object.values(viewMap)) {
      if (!isPkpRow(route)) continue;
      // Skip rows the GTFS bundle already resolves — the fold + client attach
      // own those (and provide the geometry-aligned schedule).
      const g0 = pkpEntryForRoute(
        route.trip_short_name_0,
        byTrainKey,
        route.origin_trip_0,
        route.destination_trip_0,
      );
      const g1 = pkpEntryForRoute(
        route.trip_short_name_1,
        byTrainKey,
        route.origin_trip_1,
        route.destination_trip_1,
      );
      if (g0 || g1) continue;
      const fields = plkScheduleForRow(
        route,
        candidates,
        canonicalizeStationName,
      );
      if (fields) {
        Object.assign(route, fields);
        stampOfficialSource(route, entry.id);
        vmEnriched += 1;
      }
    }
    log(`view-map: enriched ${vmEnriched} GTFS-less PKP row(s) from PLK`);
  }

  // 3) Provenance + cache for the next run's data-version gate.
  ctx.write(entry.output, {
    dataVersion: dataVersion ?? null,
    fetchedAt: new Date().toISOString(),
    requests: budget.used,
    enrichedCount,
    candidates,
  });
}
