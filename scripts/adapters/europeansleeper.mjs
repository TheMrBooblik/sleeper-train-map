// scripts/adapters/europeansleeper.mjs
// European Sleeper — official timetable from the Mobility Database GTFS feed
// mdb-3107 (https://mobilitydatabase.org/feeds/gtfs/mdb-3107). The feed carries
// stop coordinates, real track geometry (shapes.txt) and service calendars, so
// there is nothing to scrape and no OSM geometry lookup: everything the map
// needs comes out of the .zip.
//
// Trains are keyed by BARE number ("452") because BoT view-map trip_short_name_*
// uses bare numbers (trips.json uses "ES 452") — the enrichment post-step and
// excludeBotMatched both match against view-map names. Which routes we take is
// declared in params.configPath (data/sources/europeansleeper-sleepers.json),
// matched against route_short_name; adding an ES route is a data edit.
//
// Feed quirks this adapter exists to absorb:
//   • routes carry no route_long_name and trips no trip_short_name/direction_id —
//     the identity of a train is route_short_name ("ES 452");
//   • the feed is date-expanded: one trip and one service_id per operating date,
//     with only calendar_dates.txt (no calendar.txt), and it retains past dates;
//   • each date can carry its own stop sequence and its own shape (engineering
//     diversions), so the map routing is the MODAL sequence, not the longest —
//     the longest is sometimes a diversion that runs once a year.
//
// This is why the generic buildSleeperTrains() in ../lib/gtfs.mjs is not reused:
// it keys by route name, reads the calendar off a single representative trip,
// picks the trip with the most stations, and emits bare "HH:MM". All four are
// wrong for this feed. downloadGtfs/loadGtfsDir are shared as-is.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { downloadGtfs, loadGtfsDir } from "../lib/gtfs.mjs";
import { renderCalendar, DAY_KEYS } from "../../src/pages/api/lib/calendar.mjs";
import { resolveCanonicalStationName } from "../../src/pages/api/lib/primitives.mjs";

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadAllowlist(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.routes;
  if (!Array.isArray(list)) {
    throw new Error(`allowlist ${configPath} must be an array or { routes: [...] }`);
  }
  return list.map((r) => String(r).trim()).filter(Boolean);
}

// Coordinate resolution chain: manual overrides win, then the BoT stops table,
// then whatever the source feed itself published (fallback). Keeping BoT ahead
// of the feed means stations already on the map keep the coordinates the rest
// of the map uses; the fallback only fills stations BoT has never carried.
export function makeStationResolver({ botStops = {}, overrides = {}, fallback = {} }) {
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
  const coordMap = (source) =>
    new Map(
      Object.entries(source ?? {})
        .filter(([, v]) => Number.isFinite(v?.lat) && Number.isFinite(v?.lon))
        .map(([k, v]) => [k.toLowerCase().trim(), { lat: v.lat, lon: v.lon }]),
    );
  const fromOverrides = coordMap(overrides);
  const fromFallback = coordMap(fallback);
  return (name) => {
    const key = (name ?? "").toString().toLowerCase().trim();
    if (!key) return null;
    return (
      fromOverrides.get(key) ?? fromBot.get(key) ?? fromFallback.get(key) ?? null
    );
  };
}

/**
 * Normalize parsed official journeys into the standard trains-file shape.
 * Journeys: [{ train, stops: [{name, arrival: "HH:MM"|null, departure}],
 * calendar: string | calendar.mjs object | null, polyline?: string|null }]
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
        // Official sources publish local wall-clock HH:MM only; keep it in a
        // "THH:MM" datetime so downstream HH:MM extraction works unchanged
        // (enrich-view-map's toHHMM matches /T(\d{2}:\d{2})/).
        arrival: s?.arrival ? `${today}T${s.arrival}:00` : null,
        departure: s?.departure ? `${today}T${s.departure}:00` : null,
        pickup: true,
        dropoff: true,
      };
    });
    trains[number] = {
      lineName: number,
      operator: "European Sleeper",
      polyline: j?.polyline ?? null,
      stations,
      frequency:
        typeof j?.calendar === "string"
          ? j.calendar
          : (renderCalendar(j?.calendar) ?? null),
    };
  }
  return trains;
}

// ─── GTFS → journeys ─────────────────────────────────────────────────────────

// "YYYYMMDD" → "YYYY-MM-DD"
function dashDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// GTFS times run past midnight ("35:10:00" = 11:10 the next day). Wrap to a
// wall-clock HH:MM; the date part is supplied by normalizeEsTrains.
function wallClock(time) {
  const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}`;
}

// Weekday key ("mon".."sun") of a "YYYYMMDD" date, computed in UTC so the
// runner's timezone can never shift a service day.
function dayKeyOf(yyyymmdd) {
  const d = new Date(`${dashDate(yyyymmdd)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Date#getUTCDay is 0=Sunday; DAY_KEYS is Monday-first.
  return DAY_KEYS[(d.getUTCDay() + 6) % 7];
}

/**
 * Build journeys from a loaded GTFS feed.
 *
 * @param {ReturnType<import("../lib/gtfs.mjs").loadGtfsDir>} gtfs
 * @param {string[]} args.routeShortNames  Allowlisted route_short_name values
 * @param {string} args.today              "YYYY-MM-DD"; trips that never run
 *   again on or after this date are ignored, so a retired routing can't win
 * @param {object} [args.stats]            Out-param: { matched, unmatched, feedRouteCount }
 * @returns {{train, stops, calendar, polyline}[]}
 */
export function journeysFromGtfs(gtfs, { routeShortNames = [], today, stats = null }) {
  const wanted = new Map(
    routeShortNames.map((n) => [n.toLowerCase().replace(/\s+/g, " ").trim(), n]),
  );
  const matched = new Set();
  const todayCompact = String(today ?? "").replace(/-/g, "");

  const tripsByRoute = new Map();
  for (const t of gtfs.trips) {
    if (!gtfs.routesById.has(t.route_id)) continue;
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  const journeys = [];
  for (const [routeId, trips] of tripsByRoute.entries()) {
    const route = gtfs.routesById.get(routeId);
    const shortName = (route.route_short_name || "").trim();
    const allowKey = shortName.toLowerCase().replace(/\s+/g, " ").trim();
    if (!wanted.has(allowKey)) continue;
    matched.add(wanted.get(allowKey));

    // Service dates per trip, keeping only trips that still have a future run.
    const datesOf = (trip) => gtfs.addedDatesByService.get(trip.service_id) ?? [];
    const live = trips.filter((t) => datesOf(t).some((d) => d >= todayCompact));
    if (live.length === 0) continue; // route has finished running

    // The map shows one routing per train, so pick the sequence most trips
    // actually run. Ties break on the longer sequence (more detail wins).
    const bySequence = new Map();
    for (const trip of live) {
      const stopTimes = gtfs.stopTimesByTrip.get(trip.trip_id) ?? [];
      if (stopTimes.length < 2) continue;
      const key = stopTimes.map((st) => st.stop_id).join(" ");
      if (!bySequence.has(key)) bySequence.set(key, { trips: [], stopTimes });
      bySequence.get(key).trips.push(trip);
    }
    if (bySequence.size === 0) continue;
    const [, best] = [...bySequence.entries()].sort(
      (a, b) =>
        b[1].trips.length - a[1].trips.length ||
        b[1].stopTimes.length - a[1].stopTimes.length,
    )[0];

    const stops = best.stopTimes
      .map((st) => {
        const stop = gtfs.stopsById.get(st.stop_id);
        if (!stop) return null;
        return {
          // Canonicalize here, not downstream: enrich-view-map's updateVia
          // writes these names straight into via_*, and only BoT spellings
          // link a station to its route in deriveCities/buildAllRoutesPaths.
          name: resolveCanonicalStationName(stop.name),
          lat: stop.lat,
          lon: stop.lon,
          arrival: wallClock(st.arrival),
          departure: wallClock(st.departure),
        };
      })
      .filter(Boolean);

    // Service days: the union across ALL of the route's future trips. Reading
    // one representative trip would render a single weekday, because this feed
    // gives every operating date its own service_id.
    const futureDates = live
      .flatMap(datesOf)
      .filter((d) => d >= todayCompact)
      .sort();
    const days = new Set(futureDates.map(dayKeyOf).filter(Boolean));
    const calendar = futureDates.length
      ? {
          validFrom: dashDate(futureDates[0]),
          validUntil: dashDate(futureDates[futureDates.length - 1]),
          daysOfWeek: DAY_KEYS.filter((d) => days.has(d)),
          exceptions: [],
          note: null,
          raw: null,
        }
      : null;

    const shapePts = best.trips[0].shape_id
      ? gtfs.shapePoints.get(best.trips[0].shape_id)
      : null;
    const positions =
      shapePts && shapePts.length >= 2
        ? shapePts.map((p) => [p.lat, p.lon])
        : stops
            .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
            .map((s) => [s.lat, s.lon]);

    journeys.push({
      train: shortName,
      stops,
      calendar,
      polyline: positions.length >= 2 ? polyline.encode(positions) : null,
    });
  }

  if (stats) {
    stats.matched = [...matched];
    stats.unmatched = routeShortNames.filter((n) => !matched.has(n));
    stats.feedRouteCount = tripsByRoute.size;
  }
  return journeys;
}

// Station-name → coords straight from the feed, for the resolver's fallback layer.
export function feedCoordIndex(gtfs) {
  const index = {};
  for (const stop of gtfs.stopsById.values()) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    const name = resolveCanonicalStationName(stop.name);
    if (name && !(name in index)) index[name] = { lat: stop.lat, lon: stop.lon };
  }
  return index;
}

export async function run(entry, ctx) {
  const { feedUrl, fallbackUrls = [], configPath } = entry.params ?? {};
  if (!feedUrl || !configPath) {
    throw new Error(`${entry.id}: params.feedUrl and params.configPath are required`);
  }
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const routeShortNames = loadAllowlist(path.join(ctx.rootDir, configPath));

  // Allow pointing at a pre-unpacked feed (CI re-use / debugging), same as the
  // gtfs-sleeper adapter.
  const manualDir = process.env[`${entry.id.toUpperCase().replace(/-/g, "_")}_GTFS_DIR`];
  const gtfsDir = manualDir
    ? path.resolve(ctx.rootDir, manualDir)
    : path.join(ctx.rootDir, "gtfs-data", `${entry.id}-unpacked`);

  if (!manualDir) {
    // The Mobility Database serves the same object under two hostnames; try
    // each so one host being unreachable doesn't cost us a night's data.
    const urls = [feedUrl, ...fallbackUrls];
    let downloaded = false;
    for (const url of urls) {
      try {
        log(`downloading ${url}`);
        await downloadGtfs(url, gtfsDir);
        downloaded = true;
        break;
      } catch (err) {
        log(`download failed (${url}): ${err.message}`);
      }
    }
    if (!downloaded) {
      throw new Error(`${entry.id}: all ${urls.length} feed URL(s) failed`);
    }
  }

  const gtfs = loadGtfsDir(gtfsDir);
  const stats = {};
  const journeys = journeysFromGtfs(gtfs, {
    routeShortNames,
    today: ctx.today,
    stats,
  });
  if (stats.unmatched?.length) {
    log(
      `WARNING: ${stats.unmatched.length} allowlist entr${stats.unmatched.length === 1 ? "y" : "ies"} matched no feed route: ${stats.unmatched.join(", ")}`,
    );
  }

  const overrides =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json")) ?? {};
  const resolveStation = makeStationResolver({
    botStops: ctx.shared.stops ?? {},
    overrides,
    fallback: feedCoordIndex(gtfs),
  });
  const trains = normalizeEsTrains(journeys, { resolveStation, today: ctx.today });

  const built = Object.keys(trains).length;

  // Freshness safety net, mirroring gtfs-sleeper: if the feed had routes but
  // none of ours survived, its naming or its date window drifted. Fail loudly
  // (the runner records it per-source) so the sticky merge keeps yesterday's
  // data instead of silently publishing an empty operator.
  if (built === 0 && stats.feedRouteCount > 0) {
    throw new Error(
      `${entry.id}: 0 of ${stats.feedRouteCount} feed routes produced a train — feed naming or date window may have changed (unmatched: ${(stats.unmatched || []).join(", ")})`,
    );
  }

  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  log(`stored ${built} trains`);
}
