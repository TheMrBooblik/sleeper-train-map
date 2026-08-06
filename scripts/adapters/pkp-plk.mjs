// scripts/adapters/pkp-plk.mjs
// Official PLK "Otwarte Dane Kolejowe" (Open Railway Data) API adapter.
// https://pdp-api.plk-sa.pl/api-documentation — the infrastructure manager's
// authoritative planned schedule. Base URL https://pdp-api.plk-sa.pl/api/v1,
// auth via the X-API-Key header (PLK_API_KEY).
//
// Pure transforms live in scripts/lib/plk.mjs; this file owns fetch +
// orchestration only. For the trains PKP operates, PLK outranks both the
// Polish GTFS bundle and the Back-on-Track stop list (station list, times,
// calendar). Geometry stays GTFS/OSM — PLK ships none. Nightjet-covered
// routes are the one exception and are left untouched.
//
// Every PLK station name is resolved onto a station the map's stop table
// already has (makeStopResolver → station-resolver.mjs). Without that step
// an alternately-spelled name ("Praha Hlavni Nadrazi") gets no map dot and
// is dropped from the route line.

import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { extractKeysFromTripLabel } from "../../src/lib/pkpTrainKeyExtract.js";
import {
  FIELDS,
  normalizeStops,
  candidateNumbers,
  endpointKey,
  isOperatedBy,
  mergePlkIntoBundle,
  plkScheduleForRow,
  makeStopResolver,
  coveredBy,
  // Re-export pure transforms so existing unit tests keep their import path.
  canonicalizeStationName,
  endpointsMatch,
  reconcileStopCoords,
} from "../lib/plk.mjs";

export {
  FIELDS,
  normalizeStops,
  candidateNumbers,
  endpointKey,
  isOperatedBy,
  mergePlkIntoBundle,
  plkScheduleForRow,
  makeStopResolver,
  coveredBy,
  canonicalizeStationName,
  endpointsMatch,
  reconcileStopCoords,
};

const BASE_URL = "https://pdp-api.plk-sa.pl/api/v1";
const SHAPES_REL = "public/data/gtfs/pkpTrainShapes.json";

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
 * One bulk `/schedules?carriersInclude=IC` pull over a multi-day window →
 * candidate list, filtered to our scoped night-train set.
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
    for (const c of list ?? []) {
      if (!c?.stops?.length) continue;
      map.set(`${c.number ?? ""}#${endpointKey(c.stops)}`, c);
    }
  }
  return [...map.values()];
}

/**
 * Train names owned by sources PLK must not override (registry
 * `skipTrainsFrom`, e.g. ["nightjet-trains.json"]).
 */
export function readSkippedTrainNames(rootDir, files = []) {
  const names = new Set();
  for (const file of files ?? []) {
    const data = readScrapedData(rootDir, `public/data/scraped/${file}`);
    for (const name of Object.keys(data?.trains ?? {})) names.add(name.trim());
  }
  return names;
}

function stampOfficialSource(route, sourceId) {
  const existing = Array.isArray(route.official_sources)
    ? route.official_sources
    : [];
  route.official_sources = [...new Set([...existing, sourceId])].sort();
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
  // Scope to every row PKP operates (alone or with a partner), so GTFS-less
  // through-car routes (e.g. Warszawa–Rijeka) keep a candidate from the pull.
  const viewMap = ctx.shared?.viewMap ?? null;
  const isPkpRow = (r) => isOperatedBy(r, params.viewMapOperator ?? "PKP");
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
      candidates = dedupCandidates(candidates, fetched); // fresher fetch wins
      dataVersion = currentVersion ?? dataVersion;
    } else if (candidates.length) {
      log("fetch produced nothing — re-applying cached candidates");
    } else {
      log("no PLK data available — leaving bundle as GTFS-only");
      return;
    }
  }

  // Every PLK station list: alias table → the map's own stop table → coords.
  const resolveStops = makeStopResolver(ctx.shared?.stops ?? []);

  // 2) Fold PLK stops into the freshly-regenerated GTFS bundle (supplement).
  const { byTrainKey: merged, enrichedCount } = mergePlkIntoBundle(
    byTrainKey,
    candidates,
    resolveStops,
  );
  shapes.byTrainKey = merged;
  shapes.plkEnrichedAt = new Date().toISOString();
  shapes.plkDataVersion = dataVersion ?? null;
  fs.writeFileSync(shapesPath, JSON.stringify(shapes) + "\n", "utf8");
  log(
    `enriched ${enrichedCount}/${Object.keys(merged).length} bundle entries from PLK (${budget.used} request(s))`,
  );

  // 2b) Apply PLK to every PKP-operated view-map row. Station list / times /
  // calendar win; geometry stays GTFS/OSM. Nightjet-covered rows are skipped.
  if (viewMap && candidates.length) {
    const nightjetTrains = readSkippedTrainNames(rootDir, params.skipTrainsFrom);
    let vmEnriched = 0;
    for (const route of Object.values(viewMap)) {
      if (!isPkpRow(route)) continue;
      if (coveredBy(route, nightjetTrains)) continue;
      const fields = plkScheduleForRow(route, candidates, resolveStops);
      if (fields) {
        Object.assign(route, fields);
        // Tell the browser-side GTFS merge to keep this station list instead of
        // overwriting it with the bundle's (src/lib/pkpGtfsMerge.js).
        for (const d of [0, 1]) {
          if (fields[`pkp_schedule_${d}`]) route[`pkp_source_${d}`] = entry.id;
        }
        stampOfficialSource(route, entry.id);
        vmEnriched += 1;
      }
    }
    log(`view-map: enriched ${vmEnriched} PKP-operated row(s) from PLK`);
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
