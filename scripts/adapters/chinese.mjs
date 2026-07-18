// scripts/adapters/chinese.mjs
// China Railway overnight sleepers via kyfw.12306.cn (read-only schedule JSON).
//
// Flow per allowlist train (data/sources/chinese-sleepers.json):
//   1. leftTicket queryO on endpoint telecodes + date → internal train_no
//   2. queryByTrainNo → ordered stops with arrive/depart wall-clock times
//   3. Map Chinese station names → English + coords via the allowlist catalog
//   4. Polyline from the OSM-backed route-geometry cache (hash-gated)
//   5. Long jumps densified from denser sibling trains (path-only hidden
//      waypoints — never added to stations[] / map markers)
//
// Probe: dispatch "Probe 12306 source" (scripts/probe-12306.mjs). Local + CI
// probes confirmed the parsers in scripts/lib/12306.mjs — registry may be
// enabled:true. Sticky merge in the scrape runner keeps yesterday's file on
// total outage. Per-train seedStations (e.g. K23 Ulaanbaatar) fill in when
// 12306 has no domestic row.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  createCookieJar,
  datePlusDays,
  displayTrainCode,
  fetchStationNamesJs,
  findTrainInLeftTicket,
  formatChineseDisplayName,
  geocodeChineseStation,
  initSession,
  makeChineseStationResolver,
  normalizeChineseStations,
  normalizeTrainCode,
  queryByTrainNo,
  queryLeftTicket,
  sleep,
} from "../lib/12306.mjs";
import {
  emptyGeometryCache,
  resolveRouteGeometry,
} from "../lib/route-geometry.mjs";
import {
  coordPathFromStations,
  densifyPathWithSiblings,
  haversineKm,
} from "../lib/sibling-path.mjs";
import { relationCoordsFromOverpass } from "../../src/pages/api/lib/osm-geo.mjs";

// Gaps longer than this get optional sibling waypoints for the polyline only.
const SIBLING_GAP_KM = 400;
const SIBLING_MATCH_KM = 50;

const GEOMETRY_CACHE_FILE = "route-geometry.json";
const COORDS_CACHE_FILE = "chinese-station-coords.json";
// Booking window: +3 days avoids "today already departed" misses in UTC CI.
const QUERY_DATE_OFFSET_DAYS = 3;
const REQUEST_SPACING_MS = 700;
const GEOCODE_SPACING_MS = 350;
// Cap Nominatim lookups per scrape so a cold cache can't blow the nightly budget.
const GEOCODE_MAX_PER_RUN = 120;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadAllowlist(configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    stations: Array.isArray(raw.stations) ? raw.stations : [],
    trains: Array.isArray(raw.trains) ? raw.trains : [],
  };
}

/** Expand each allowlist row into one or two directed legs. */
export function expandAllowlistLegs(trains) {
  const legs = [];
  for (const t of trains ?? []) {
    if (!t?.lineName || !t?.fromTelecode || !t?.toTelecode) continue;
    legs.push({
      lineName: displayTrainCode(t.lineName) ?? t.lineName,
      fromTelecode: t.fromTelecode,
      toTelecode: t.toTelecode,
      frequency: t.frequency ?? null,
      seedStations: t.seedStations ?? null,
    });
    if (t.returnLineName) {
      legs.push({
        lineName: displayTrainCode(t.returnLineName) ?? t.returnLineName,
        fromTelecode: t.toTelecode,
        toTelecode: t.fromTelecode,
        frequency: t.frequency ?? null,
        seedStations: t.seedStations ? [...t.seedStations].reverse() : null,
      });
    }
  }
  return legs;
}

function stationsFromSeed(seedStations, resolveStation) {
  return (seedStations ?? [])
    .filter((s) => s?.name || s?.nameZh)
    .map((s) => {
      const zh = s.nameZh ?? null;
      const resolved = (zh && resolveStation?.(zh)) || resolveStation?.(s.name);
      const english = s.name ?? resolved?.name ?? null;
      const coords =
        Number.isFinite(s.lat) && Number.isFinite(s.lon)
          ? { lat: s.lat, lon: s.lon }
          : resolved?.coords ?? null;
      return {
        id: null,
        name: formatChineseDisplayName(english, zh) ?? english ?? zh,
        nameZh: zh,
        location: coords
          ? { latitude: coords.lat, longitude: coords.lon }
          : null,
        arrival: null,
        departure: null,
        pickup: true,
        dropoff: true,
      };
    });
}

/**
 * Fetch one leg's stop list from 12306. Returns null when the commercial
 * number is absent from leftTicket (seasonal / international-only).
 */
export async function fetchChineseLeg(leg, { date, jar, fetchImpl = fetch, log = console.warn }) {
  const lt = await queryLeftTicket(
    { date, fromTelecode: leg.fromTelecode, toTelecode: leg.toTelecode },
    { fetchImpl, jar },
  );
  const match = findTrainInLeftTicket(lt.trains, leg.lineName);
  if (!match?.trainNo) {
    log(`[chinese] no leftTicket row for ${leg.lineName} ${leg.fromTelecode}→${leg.toTelecode}`);
    return null;
  }
  const sched = await queryByTrainNo(
    {
      trainNo: match.trainNo,
      fromTelecode: match.fromTelecode || leg.fromTelecode,
      toTelecode: match.toTelecode || leg.toTelecode,
      date,
    },
    { fetchImpl, jar },
  );
  if (!sched.stops?.length) {
    log(`[chinese] empty stop list for ${leg.lineName} (${match.trainNo})`);
    return null;
  }
  return {
    trainCode: match.trainCode,
    trainNo: match.trainNo,
    stops: sched.stops,
    departTime: match.departTime,
    arriveTime: match.arriveTime,
  };
}

/**
 * Build the trains dict from allowlist legs (pure except for the fetch hook).
 * Exported for tests with a mock fetchLeg.
 */
export async function buildChineseTrains(legs, {
  resolveStation,
  today,
  date,
  fetchLeg,
  log = console.log,
} = {}) {
  const trains = {};
  for (const leg of legs) {
    let live = null;
    try {
      live = await fetchLeg(leg, { date });
    } catch (err) {
      log(`[chinese] fetch failed for ${leg.lineName}: ${err.message}`);
    }

    let stations = null;
    if (live?.stops?.length >= 2) {
      stations = normalizeChineseStations(live.stops, { resolveStation, today: date });
      // Prefer English catalog names; keep Chinese when unresolved.
    } else if (leg.seedStations?.length >= 2) {
      log(`[chinese] using seedStations for ${leg.lineName}`);
      stations = stationsFromSeed(leg.seedStations, resolveStation);
    }

    if (!stations || stations.length < 2) continue;

    const key = displayTrainCode(leg.lineName) ?? leg.lineName;
    trains[key] = {
      lineName: key,
      operator: "China Railway",
      agency_id: "CR",
      polyline: null,
      stations,
      frequency: leg.frequency ?? null,
    };
  }
  return trains;
}

export async function run(entry, ctx) {
  const configPath = path.join(ctx.rootDir, entry.params?.configPath ?? "data/sources/chinese-sleepers.json");
  const allowlist = loadAllowlist(configPath);
  const legs = expandAllowlistLegs(allowlist.trains);
  if (!legs.length) {
    throw new Error("chinese allowlist is empty — check data/sources/chinese-sleepers.json");
  }

  const scrapedDir = path.join(ctx.rootDir, "public", "data", "scraped");
  const overrides =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json")) ?? {};
  const coordsFile = readJsonSafe(path.join(scrapedDir, COORDS_CACHE_FILE));
  // Envelope from scrape runner: { uploadedAt, data: { byZh } }; bare { byZh } in tests.
  const coordsCache = {
    byZh: {
      ...(coordsFile?.data?.byZh && typeof coordsFile.data.byZh === "object"
        ? coordsFile.data.byZh
        : null),
      ...(coordsFile?.byZh && typeof coordsFile.byZh === "object" ? coordsFile.byZh : null),
    },
  };

  const jar = createCookieJar();
  const fetchImpl = ctx.fetch ?? fetch;
  const session = await initSession(fetchImpl, jar);
  if (!session.ok && !jar.header()) {
    throw new Error(`12306 session init failed (HTTP ${session.status})`);
  }

  // Official telecode/pinyin list — English fallback for every Chinese stop name.
  let stationNames = null;
  try {
    stationNames = await fetchStationNamesJs(fetchImpl, jar);
    console.log(`[scrape] chinese: loaded ${stationNames.byTelecode.size} 12306 station names`);
  } catch (err) {
    console.warn(`[scrape] chinese: station_name.js failed — ${err.message}`);
  }

  const resolveStation = makeChineseStationResolver({
    allowlistStations: allowlist.stations,
    overrides,
    stationNames,
    coordsByZh: coordsCache.byZh,
  });

  const date = datePlusDays(ctx.today, entry.params?.dateOffsetDays ?? QUERY_DATE_OFFSET_DAYS);

  // Cache leftTicket responses per corridor — outbound + return share one query.
  const leftTicketCache = new Map();
  async function cachedLeftTicket(fromTelecode, toTelecode) {
    const key = `${fromTelecode}|${toTelecode}|${date}`;
    if (leftTicketCache.has(key)) return leftTicketCache.get(key);
    const result = await queryLeftTicket(
      { date, fromTelecode, toTelecode },
      { fetchImpl, jar },
    );
    leftTicketCache.set(key, result);
    await sleep(REQUEST_SPACING_MS);
    return result;
  }

  const trains = await buildChineseTrains(legs, {
    resolveStation,
    today: ctx.today,
    date,
    log: (msg) => console.log(`[scrape] ${msg}`),
    fetchLeg: async (leg) => {
      const lt = await cachedLeftTicket(leg.fromTelecode, leg.toTelecode);
      const match = findTrainInLeftTicket(lt.trains, leg.lineName);
      if (!match?.trainNo) {
        console.warn(
          `[scrape] [chinese] no leftTicket row for ${leg.lineName} ${leg.fromTelecode}→${leg.toTelecode}`,
        );
        return null;
      }
      const sched = await queryByTrainNo(
        {
          trainNo: match.trainNo,
          fromTelecode: match.fromTelecode || leg.fromTelecode,
          toTelecode: match.toTelecode || leg.toTelecode,
          date,
        },
        { fetchImpl, jar },
      );
      await sleep(REQUEST_SPACING_MS);
      if (!sched.stops?.length) {
        console.warn(`[scrape] [chinese] empty stop list for ${leg.lineName}`);
        return null;
      }
      return {
        trainCode: match.trainCode,
        trainNo: match.trainNo,
        stops: sched.stops,
        departTime: match.departTime,
        arriveTime: match.arriveTime,
      };
    },
  });

  if (!Object.keys(trains).length) {
    throw new Error(
      "no China Railway trains fetched — check 12306 reachability (probe-12306 workflow) and allowlist telecodes",
    );
  }

  // Fill missing coordinates via Nominatim (cached) so map dots + polylines
  // include intermediate stops that the curated catalog doesn't cover yet.
  const missingZh = new Set();
  for (const train of Object.values(trains)) {
    for (const s of train.stations ?? []) {
      if (s?.nameZh && !s.location) missingZh.add(s.nameZh);
    }
  }
  let geocoded = 0;
  for (const zh of missingZh) {
    if (geocoded >= GEOCODE_MAX_PER_RUN) break;
    const cached = coordsCache.byZh[zh];
    if (Number.isFinite(cached?.lat) && Number.isFinite(cached?.lon)) continue;
    // Don't hammer Nominatim for the same miss twice in one day.
    if (cached?.source === "nominatim-miss" && cached.triedAt === ctx.today) continue;
    try {
      const hit = await geocodeChineseStation(zh, { fetchImpl });
      await sleep(GEOCODE_SPACING_MS);
      if (hit) {
        coordsCache.byZh[zh] = { ...hit, source: "nominatim" };
        geocoded++;
      } else {
        coordsCache.byZh[zh] = { lat: null, lon: null, source: "nominatim-miss", triedAt: ctx.today };
      }
    } catch (err) {
      console.warn(`[scrape] chinese geocode ${zh}: ${err.message}`);
    }
  }
  if (geocoded) {
    console.log(`[scrape] chinese: geocoded ${geocoded} stations (${missingZh.size} were missing coords)`);
  }

  // Re-apply resolver with the updated coord cache so tonight's trains pick up
  // newly geocoded (and previously cached) coordinates.
  const resolveWithCoords = makeChineseStationResolver({
    allowlistStations: allowlist.stations,
    overrides,
    stationNames,
    coordsByZh: Object.fromEntries(
      Object.entries(coordsCache.byZh).filter(([, v]) => Number.isFinite(v?.lat) && Number.isFinite(v?.lon)),
    ),
  });
  for (const train of Object.values(trains)) {
    for (const s of train.stations ?? []) {
      if (s.location || !s.nameZh) continue;
      const resolved = resolveWithCoords(s.nameZh);
      if (resolved?.coords) {
        s.location = { latitude: resolved.coords.lat, longitude: resolved.coords.lon };
      }
      // Ensure English(中文) even if the first pass only had Chinese.
      if (resolved?.name || s.nameZh) {
        s.name = formatChineseDisplayName(resolved?.name ?? null, s.nameZh);
      }
    }
  }

  ctx.write(COORDS_CACHE_FILE, {
    updatedAt: new Date().toISOString(),
    byZh: coordsCache.byZh,
  });

  // Geometry: regenerated only when a train's official stop list changed.
  const cache = readJsonSafe(path.join(scrapedDir, GEOMETRY_CACHE_FILE))?.data ?? emptyGeometryCache();
  const pinned = entry.params?.pinnedRelations ?? {};
  for (const train of Object.values(trains)) {
    const stops = train.stations.map((s) => ({
      name: s.name,
      lat: s.location?.latitude,
      lon: s.location?.longitude,
    }));
    const code = normalizeTrainCode(train.lineName);
    const resolved = await resolveRouteGeometry({
      key: `${entry.id}:${train.lineName}`,
      stops,
      pinnedRelationIds: pinned[train.lineName] ?? pinned[code] ?? [],
      // Skip Overpass: CR refs rarely exist as OSM route relations, and a
      // broad operator query times out. Pinned relations + stop-chain only.
      refCandidates: [],
      operatorRegex: null,
      fetchImpl: null,
      cache,
      allowChain: true,
      readScrapedRelation: (id) => {
        const raw = readJsonSafe(path.join(scrapedDir, `osm-${id}.json`));
        return raw ? relationCoordsFromOverpass(raw.data, id) : null;
      },
      log: (msg) => console.log(`[scrape] chinese ${msg}`),
    });
    train.polyline = resolved.polyline;
  }

  // Path-only densify: borrow coords from denser siblings across long jumps
  // so the map line follows the corridor without adding stations/markers.
  const densified = densifyChinesePolylines(trains);
  if (densified > 0) {
    console.log(`[scrape] chinese: densified ${densified} polyline(s) from sibling paths`);
  }

  ctx.write(GEOMETRY_CACHE_FILE, cache);
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] stored ${Object.keys(trains).length} chinese trains (query date ${date})`);
}

/**
 * Rewrite sparse stop-chain polylines using intermediate coords from other
 * Chinese trains on the same corridor. Stations[] unchanged (no map clutter).
 * Returns how many trains got a denser polyline.
 *
 * Runs multiple passes so a train densified from A can later help B fill a
 * different gap (composite corridors), still without adding map stations.
 */
export function densifyChinesePolylines(trains) {
  const entries = Object.entries(trains ?? {});
  const pathsByKey = new Map(
    entries.map(([key, train]) => [key, coordPathFromStations(train.stations)]),
  );
  let changed = 0;
  // Cap rounds — each pass only keeps paths that shrink the worst jump.
  for (let round = 0; round < 5; round++) {
    let roundChanged = 0;
    // Sparse trains first so denser siblings act as donors.
    const ordered = [...entries].sort(
      (a, b) => (pathsByKey.get(a[0])?.length ?? 0) - (pathsByKey.get(b[0])?.length ?? 0),
    );
    for (const [key, train] of ordered) {
      const own = pathsByKey.get(key) ?? [];
      if (own.length < 2) continue;
      const siblings = [];
      for (const [otherKey, otherPath] of pathsByKey) {
        if (otherKey === key) continue;
        siblings.push(otherPath);
      }
      const densified = densifyPathWithSiblings(own, siblings, {
        gapKm: SIBLING_GAP_KM,
        matchKm: SIBLING_MATCH_KM,
      });
      if (densified.length <= own.length) continue;
      if (maxSegmentKm(densified) >= maxSegmentKm(own)) continue;
      train.polyline = polyline.encode(densified);
      pathsByKey.set(key, densified);
      roundChanged++;
    }
    changed += roundChanged;
    if (!roundChanged) break;
  }
  return changed;
}

function maxSegmentKm(path) {
  let max = 0;
  for (let i = 0; i < path.length - 1; i++) {
    max = Math.max(max, haversineKm(path[i], path[i + 1]));
  }
  return max;
}
