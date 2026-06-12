// scripts/adapters/europeansleeper.mjs
// European Sleeper — official stop lists from europeansleeper.eu; geometry via
// the OSM-backed route-geometry cache (no official polylines exist).
//
// Discovery: Back-on-Track tells which ES trains run (agency "ES"); the
// official site provides the authoritative stop list per train. Trains are
// keyed by BARE number ("452") because BoT view-map trip_short_name_* uses
// bare numbers (trips.json uses "ES 452") — the enrichment post-step and
// excludeBotMatched both match against view-map names.
//
// PROBE-GATED: the dev sandbox cannot reach europeansleeper.eu, so the page /
// booking parsers below are finalized from CI findings. Run the
// "Probe European Sleeper source" workflow (scripts/probe-europeansleeper.mjs),
// implement parseTimetableHtml() (and/or a booking-API strategy) from the
// captured artifact, then flip the registry entry to enabled:true. Until a
// strategy yields journeys, run() throws — runner error isolation plus the
// sticky merge keep yesterday's data live and the failure visible in the
// scrape log and /data dashboard.

import fs from "node:fs";
import path from "node:path";
import {
  emptyGeometryCache,
  resolveRouteGeometry,
} from "../lib/route-geometry.mjs";
import { relationCoordsFromOverpass } from "../../src/pages/api/lib/osm-geo.mjs";
import { renderCalendar } from "../../src/pages/api/lib/calendar.mjs";

const GEOMETRY_CACHE_FILE = "route-geometry.json";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Bare ES train numbers running per Back-on-Track (the discovery index).
export function discoverEsTrainNumbers(viewMap = {}, trips = {}) {
  const numbers = new Set();
  const collect = (label) => {
    const m = String(label ?? "").match(/(\d{3,5})/);
    if (m) numbers.add(m[1]);
  };
  for (const row of Object.values(viewMap ?? {})) {
    if ((row?.agency_id ?? "").toString().trim() !== "ES") continue;
    [row.trip_short_name_0, row.trip_short_name_1].filter(Boolean).forEach(collect);
  }
  for (const trip of Object.values(trips ?? {})) {
    if ((trip?.agency_id ?? "").toString().trim() !== "ES") continue;
    collect(trip?.trip_short_name);
  }
  return numbers;
}

// Coordinate resolution chain: manual overrides win, then the BoT stops table.
export function makeStationResolver({ botStops = {}, overrides = {} }) {
  const fromBot = new Map();
  for (const stop of Object.values(botStops ?? {})) {
    if (
      !stop?.stop_name ||
      !Number.isFinite(stop?.stop_lat) ||
      !Number.isFinite(stop?.stop_lon)
    ) {
      continue;
    }
    const key = stop.stop_name.toLowerCase().trim();
    if (!fromBot.has(key)) fromBot.set(key, { lat: stop.stop_lat, lon: stop.stop_lon });
  }
  const fromOverrides = new Map(
    Object.entries(overrides ?? {})
      .filter(([, v]) => Number.isFinite(v?.lat) && Number.isFinite(v?.lon))
      .map(([k, v]) => [k.toLowerCase().trim(), { lat: v.lat, lon: v.lon }]),
  );
  return (name) => {
    const key = (name ?? "").toString().toLowerCase().trim();
    if (!key) return null;
    return fromOverrides.get(key) ?? fromBot.get(key) ?? null;
  };
}

/**
 * Normalize parsed official journeys into the standard trains-file shape.
 * Journeys: [{ train, stops: [{name, arrival: "HH:MM"|null, departure}],
 * calendar: string | calendar.mjs object | null }]
 */
export function normalizeEsTrains(journeys, { resolveStation, today }) {
  const trains = {};
  for (const j of journeys ?? []) {
    const number = String(j?.train ?? "").match(/(\d{3,5})/)?.[1];
    if (!number || !(j?.stops?.length >= 2)) continue;
    const stations = j.stops.map((s) => {
      const coords = resolveStation(s?.name);
      return {
        id: null,
        name: s?.name ?? null,
        location: coords ? { latitude: coords.lat, longitude: coords.lon } : null,
        // Official site publishes local wall-clock HH:MM only; keep it in a
        // "THH:MM" datetime so downstream HH:MM extraction works unchanged.
        arrival: s?.arrival ? `${today}T${s.arrival}:00` : null,
        departure: s?.departure ? `${today}T${s.departure}:00` : null,
        pickup: true,
        dropoff: true,
      };
    });
    trains[number] = {
      lineName: number,
      operator: "European Sleeper",
      polyline: null, // filled from the route-geometry cache in run()
      stations,
      frequency:
        typeof j?.calendar === "string"
          ? j.calendar
          : (renderCalendar(j?.calendar) ?? null),
    };
  }
  return trains;
}

// ─── Official fetch strategies (finalized from the CI probe) ────────────────

/**
 * Parse the official timetable page into journeys.
 * PROBE-GATED: implement from the captured probe artifact (__NEXT_DATA__ JSON
 * or DOM tables — see scripts/probe-europeansleeper.mjs). Returns null until
 * then so run() fails loudly instead of publishing wrong data.
 */
export function parseTimetableHtml(_html, _wantedNumbers) {
  return null;
}

async function fetchOfficialJourneys(entry, wantedNumbers) {
  const url = entry.params?.timetableUrl;
  if (!url) return null;
  let html = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) {
      console.warn(`[scrape] europeansleeper: timetable page returned ${res.status}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    console.warn(`[scrape] europeansleeper: timetable fetch failed — ${err.message}`);
    return null;
  }
  const journeys = parseTimetableHtml(html, wantedNumbers);
  if (!journeys?.length) {
    console.warn(
      "[scrape] europeansleeper: page fetched but no journeys parsed — finalize parseTimetableHtml() from the probe findings",
    );
    return null;
  }
  return journeys;
}

export async function run(entry, ctx) {
  const wanted = discoverEsTrainNumbers(ctx.shared.viewMap, ctx.shared.trips);
  const journeys = await fetchOfficialJourneys(entry, wanted);
  if (!journeys?.length) {
    throw new Error(
      "no official European Sleeper data extracted — run the ES probe workflow and finalize the parser (see adapter header)",
    );
  }

  const overrides =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json")) ?? {};
  const resolveStation = makeStationResolver({
    botStops: ctx.shared.stops ?? {},
    overrides,
  });
  const trains = normalizeEsTrains(journeys, { resolveStation, today: ctx.today });

  // Geometry: regenerated only when a train's official stop list changed
  // (hash-gated cache, committed alongside the scraped data).
  const scrapedDir = path.join(ctx.rootDir, "public", "data", "scraped");
  const cache = readJsonSafe(path.join(scrapedDir, GEOMETRY_CACHE_FILE))?.data ?? emptyGeometryCache();
  const pinned = entry.params?.pinnedRelations ?? {};
  for (const train of Object.values(trains)) {
    const stops = train.stations.map((s) => ({
      name: s.name,
      lat: s.location?.latitude,
      lon: s.location?.longitude,
    }));
    const resolved = await resolveRouteGeometry({
      key: `${entry.id}:${train.lineName}`,
      stops,
      pinnedRelationIds: pinned[train.lineName] ?? [],
      refCandidates: [train.lineName, `ES ${train.lineName}`],
      operatorRegex: "European Sleeper",
      cache,
      readScrapedRelation: (id) => {
        const raw = readJsonSafe(path.join(scrapedDir, `osm-${id}.json`));
        return raw ? relationCoordsFromOverpass(raw.data, id) : null;
      },
      log: (msg) => console.log(`[scrape] europeansleeper ${msg}`),
    });
    train.polyline = resolved.polyline;
  }

  ctx.write(GEOMETRY_CACHE_FILE, cache);
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
}
