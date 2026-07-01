// scripts/adapters/pkp-plk.mjs
// Official PLK "Otwarte Dane Kolejowe" (Open Railway Data) API adapter.
// https://pdp-api.plk-sa.pl/api-documentation — the infrastructure manager's
// authoritative planned schedule, which carries every station a train calls at
// on Polish track (incl. the international EN/EC sections we want richer data
// for). Base URL https://pdp-api.plk-sa.pl/api/v1, auth via X-API-Key.
//
// SUPPLEMENT strategy (see the migration plan): PLK does NOT ship track geometry,
// so we keep the GTFS/OSM polylines and only fold PLK's richer per-train stop
// lists (names + times + station coordinates) into the existing
// public/data/gtfs/pkpTrainShapes.json `byTrainKey` bundle. Every downstream
// consumer (attachPkpGtfsPolylinesToViewMap, the gtfsBundle enrichment,
// pkpEntryForRoute) keeps working unchanged because the bundle shape is
// preserved. The GTFS parser regenerates that file every run, so we re-apply the
// fold every run — but only hit the network when /data-version changed.
//
// This entry ships DISABLED in the registry until the exact response field names
// are confirmed from the first live CI run (the no-auth /fields/schedules
// dictionary documents them). All field reads are centralized in FIELDS below so
// finalizing is a one-place change. The adapter never throws: any failure leaves
// the bundle as GTFS-only.

import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout, pMapLimit } from "../lib/scrape-helpers.mjs";
import { normalizeCity } from "../../src/lib/pkpTrainKeyExtract.js";
import { fmtHHMM } from "../lib/pkp-calendar.mjs";

const BASE_URL = "https://pdp-api.plk-sa.pl/api/v1";
const SHAPES_REL = "public/data/gtfs/pkpTrainShapes.json";
const STATIONS_CACHE_REL = "public/data/scraped/pkp-plk-stations.json";

// ── Field access ─────────────────────────────────────────────────────────────
// The API also exposes /shortened endpoints (scheduleId → sid, …). Response
// bodies aren't visible from the dev sandbox (host is egress-blocked), so each
// logical field lists the plausible full + shortened names; the first present
// wins. Confirm/trim these from the first live response or /fields/schedules.
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

export const FIELDS = {
  scheduleVersion: (v) =>
    pick(v, "schedule", "scheduleDataVersion", "scheduleVersion", "schedules"),
  routeList: (v) =>
    Array.isArray(v) ? v : asArray(pick(v, "routes", "items", "data")),
  routeScheduleId: (r) => pick(r, "scheduleId", "sid"),
  routeOrderId: (r) => pick(r, "orderId", "oid"),
  routeTrainNumber: (r) =>
    pick(r, "trainNumber", "trainNo", "number", "commercialNumber", "nr"),
  routeCarrier: (r) => pick(r, "carrier", "carrierCode", "carrierId"),
  detailTrainNumber: (d) =>
    pick(d, "trainNumber", "trainNo", "number", "commercialNumber", "nr"),
  detailStops: (d) =>
    asArray(pick(d, "stops", "route", "stations", "points", "st")),
  stopStationId: (s) =>
    pick(s, "stationId", "stationCode", "station", "id", "sid"),
  stopName: (s) => pick(s, "stationName", "name"),
  stopArrival: (s) =>
    pick(s, "plannedArrival", "arrival", "plannedArrivalTime", "arr"),
  stopDeparture: (s) =>
    pick(s, "plannedDeparture", "departure", "plannedDepartureTime", "dep"),
  stopLat: (s) => pick(s, "latitude", "lat", "y"),
  stopLon: (s) => pick(s, "longitude", "lon", "lng", "x"),
  stationList: (v) =>
    Array.isArray(v) ? v : asArray(pick(v, "stations", "items", "data")),
  stationTotalPages: (v) => pick(v, "totalPages", "pages", "pageCount"),
  stationId: (st) => pick(st, "id", "stationId", "code"),
  stationName: (st) => pick(st, "name", "stationName"),
  stationLat: (st) => pick(st, "latitude", "lat", "y"),
  stationLon: (st) => pick(st, "longitude", "lon", "lng", "x"),
};

// ── Pure transforms (exported for tests) ─────────────────────────────────────

/**
 * Normalize a PLK route-detail stop array into the bundle's stop shape
 * ({ name, arr, dep, lat, lon }). Names/coords resolve from the stop itself,
 * falling back to the stations dictionary by station id.
 * @param {object[]} rawStops
 * @param {Record<string, {name?: string, lat?: number, lon?: number}>} stationsById
 * @returns {{name: string, arr: string|null, dep: string|null, lat: number|null, lon: number|null}[]}
 */
export function normalizeStops(rawStops, stationsById = {}) {
  const out = [];
  for (const s of asArray(rawStops)) {
    const id = FIELDS.stopStationId(s);
    const station = id != null ? stationsById[String(id)] : null;
    const name = FIELDS.stopName(s) ?? station?.name;
    if (!name) continue;
    const lat = num(FIELDS.stopLat(s)) ?? num(station?.lat);
    const lon = num(FIELDS.stopLon(s)) ?? num(station?.lon);
    out.push({
      name: String(name).trim(),
      arr: fmtHHMM(FIELDS.stopArrival(s)),
      dep: fmtHHMM(FIELDS.stopDeparture(s)),
      lat: lat ?? null,
      lon: lon ?? null,
    });
  }
  return out;
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
 * Fill missing PLK stop coordinates from the GTFS stop list (matched by city),
 * so compound-label stitching (which cuts polylines at junction coords) keeps
 * working after we swap in the richer PLK stops.
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
 * `variants`), pick the PLK candidate for that train number whose endpoints
 * match the entry's own corridor and that is at least as detailed, then replace
 * the entry's `stops` (coords reconciled from GTFS). Geometry/calendar are kept.
 * Reused train numbers can't cross-contaminate: endpoint validation rejects
 * wrong-corridor candidates, exactly like pkpEntryForRoute.
 *
 * @param {Record<string, object>} byTrainKey
 * @param {Record<string, {stops: object[]}[]>} candidatesByNumber
 * @returns {{ byTrainKey: Record<string, object>, enrichedCount: number }}
 */
export function mergePlkIntoBundle(byTrainKey, candidatesByNumber = {}) {
  const out = {};
  let enrichedCount = 0;

  const enrichStops = (existingStops, key) => {
    const candidates = candidatesByNumber[key];
    if (!Array.isArray(candidates) || !existingStops?.length) return null;
    const match = candidates.find(
      (c) =>
        c.stops?.length >= 2 &&
        endpointsMatch(c.stops, existingStops) &&
        c.stops.length >= existingStops.length,
    );
    if (!match) return null;
    return reconcileStopCoords(match.stops, existingStops);
  };

  for (const [key, entry] of Object.entries(byTrainKey)) {
    const next = { ...entry };
    const mainStops = enrichStops(entry.stops, key);
    if (mainStops) {
      next.stops = mainStops;
      enrichedCount += 1;
    }
    if (Array.isArray(entry.variants)) {
      next.variants = entry.variants.map((v) => {
        const vs = enrichStops(v.stops, key);
        if (vs) {
          enrichedCount += 1;
          return { ...v, stops: vs };
        }
        return v;
      });
    }
    out[key] = next;
  }

  return { byTrainKey: out, enrichedCount };
}

// ── I/O + network ────────────────────────────────────────────────────────────

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

async function loadStations({ rootDir, apiKey, budget, params, log }) {
  const cached = readScrapedData(rootDir, STATIONS_CACHE_REL)?.stationsById;
  if (cached && Object.keys(cached).length) {
    log(`stations: ${Object.keys(cached).length} from cache`);
    return cached;
  }
  const stationsById = {};
  const pageSize = params.stationsPageSize ?? 5000;
  for (let page = 1; ; page += 1) {
    const resp = await getJson(
      `${BASE_URL}/dictionaries/stations?page=${page}&pageSize=${pageSize}`,
      apiKey,
      budget,
    );
    if (!resp.ok) break;
    const list = FIELDS.stationList(resp.json);
    for (const st of list) {
      const id = FIELDS.stationId(st);
      if (id == null) continue;
      stationsById[String(id)] = {
        name: FIELDS.stationName(st),
        lat: num(FIELDS.stationLat(st)),
        lon: num(FIELDS.stationLon(st)),
      };
    }
    const totalPages = Number(FIELDS.stationTotalPages(resp.json)) || 1;
    if (list.length === 0 || page >= totalPages) break;
  }
  if (Object.keys(stationsById).length) {
    fs.writeFileSync(
      path.join(rootDir, STATIONS_CACHE_REL),
      JSON.stringify({
        uploadedAt: new Date().toISOString(),
        data: { stationsById },
      }) + "\n",
      "utf8",
    );
    log(`stations: fetched + cached ${Object.keys(stationsById).length}`);
  }
  return stationsById;
}

/** Fetch PLK route detail for the scoped train numbers → { number: [{stops}] }. */
async function fetchScoped({
  rootDir,
  apiKey,
  budget,
  scopedNumbers,
  params,
  log,
}) {
  const stationsById = await loadStations({
    rootDir,
    apiKey,
    budget,
    params,
    log,
  });

  const date = params.date || new Date().toISOString().slice(0, 10);
  const carrier = (params.carriersInclude || "").toUpperCase();
  const listResp = await getJson(
    `${BASE_URL}/schedules/routes/${date}`,
    apiKey,
    budget,
  );
  if (!listResp.ok) {
    log(`schedules/routes/${date} → ${listResp.status || listResp.error}`);
    return null;
  }

  const seen = new Set();
  const wanted = FIELDS.routeList(listResp.json)
    .map((r) => ({
      sid: FIELDS.routeScheduleId(r),
      oid: FIELDS.routeOrderId(r),
      num: String(FIELDS.routeTrainNumber(r) ?? ""),
      carrier: String(FIELDS.routeCarrier(r) ?? "").toUpperCase(),
    }))
    .filter((r) => r.sid != null && r.oid != null)
    .filter((r) => scopedNumbers.has(r.num))
    .filter((r) => !carrier || !r.carrier || r.carrier.includes(carrier))
    .filter((r) => {
      const k = `${r.sid}/${r.oid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  log(
    `${wanted.length} scoped route(s) to fetch (budget ${budget.max - budget.used} left)`,
  );

  const details = await pMapLimit(
    wanted,
    params.concurrency ?? 4,
    async (r) => {
      if (
        budget.used >= budget.max ||
        budget.rateRemaining <= (params.rateFloor ?? 10)
      )
        return null;
      const d = await getJson(
        `${BASE_URL}/schedules/route/${r.sid}/${r.oid}`,
        apiKey,
        budget,
      );
      if (!d.ok) return null;
      return {
        num: r.num || String(FIELDS.detailTrainNumber(d.json) ?? ""),
        detail: d.json,
      };
    },
  );

  const byNumber = {};
  for (const item of details) {
    if (!item?.num) continue;
    const stops = normalizeStops(FIELDS.detailStops(item.detail), stationsById);
    if (stops.length < 2) continue;
    (byNumber[item.num] ||= []).push({ stops });
  }
  return byNumber;
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

  const params = entry.params || {};
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

  let candidatesByNumber = prev?.candidatesByNumber ?? null;
  let dataVersion = prev?.dataVersion ?? null;

  const unchanged =
    currentVersion &&
    dataVersion &&
    currentVersion === dataVersion &&
    candidatesByNumber;

  if (unchanged) {
    log(
      `data unchanged (${currentVersion}) — re-applying cached PLK stops, 0 further requests`,
    );
  } else {
    const fetched = await fetchScoped({
      rootDir,
      apiKey,
      budget,
      scopedNumbers,
      params,
      log,
    });
    if (fetched && Object.keys(fetched).length) {
      candidatesByNumber = fetched;
      dataVersion = currentVersion ?? dataVersion;
    } else if (candidatesByNumber) {
      log("fetch produced nothing — falling back to cached PLK stops");
    } else {
      log("no PLK data available — leaving bundle as GTFS-only");
      return;
    }
  }

  // 2) Fold PLK stops into the freshly-regenerated GTFS bundle (supplement).
  const { byTrainKey: merged, enrichedCount } = mergePlkIntoBundle(
    byTrainKey,
    candidatesByNumber,
  );
  shapes.byTrainKey = merged;
  shapes.plkEnrichedAt = new Date().toISOString();
  shapes.plkDataVersion = dataVersion ?? null;
  fs.writeFileSync(shapesPath, JSON.stringify(shapes) + "\n", "utf8");
  log(
    `enriched ${enrichedCount}/${Object.keys(merged).length} bundle entries from PLK (${budget.used} request(s))`,
  );

  // 3) Provenance + cache for the next run's data-version gate.
  ctx.write(entry.output, {
    dataVersion: dataVersion ?? null,
    fetchedAt: new Date().toISOString(),
    requests: budget.used,
    enrichedCount,
    candidatesByNumber,
  });
}
