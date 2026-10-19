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
//   • each date can carry its own stop sequence and its own shape, for two very
//     different reasons: one-off engineering diversions (which must be ignored —
//     the longest sequence is sometimes a diversion that runs once a year) and
//     the December timetable change, where a train legitimately switches routing
//     AND operating days. Trips are therefore grouped into timetable PERIODS:
//     the one running now drives the route, and the next one (if the feed
//     already has it) rides along as `future` so the map can show both.
//
// This is why the generic buildSleeperTrains() in ../lib/gtfs.mjs is not reused:
// it keys by route name, reads the calendar off a single representative trip,
// picks the trip with the most stations, and emits bare "HH:MM". All four are
// wrong for this feed. downloadGtfs/loadGtfsDir are shared as-is.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  downloadGtfs,
  loadGtfsDir,
  decemberTimetableChange,
  nextTimetableChangeAfter,
} from "../lib/gtfs.mjs";
import { renderCalendar, DAY_KEYS } from "../../src/pages/api/lib/calendar.mjs";
import { resolveCanonicalStationName } from "../../src/pages/api/lib/primitives.mjs";
import { distanceKm } from "../../src/components/Map/utils/returnGeometryBranches.js";
import { cityForStation } from "../../src/lib/seo/cities.mjs";
import { parseTimetableHtml } from "../lib/es-timetable.mjs";
import { fillEsFareCalendars, ES_FARE_BUDGET } from "../lib/es-fare-calendar.mjs";
import { fetchDeals } from "../lib/es-last-minute.mjs";

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
 * calendar: string | calendar.mjs object | null, polyline?: string|null,
 * future?: {activeFrom, stops, calendar, polyline} }]
 *
 * `future` is carried through onto the train so the merge can emit the upcoming
 * timetable as its own map route (see appendSyntheticRoutes).
 */
export function normalizeEsTrains(journeys, { resolveStation, today }) {
  const toStations = (stops) =>
    (stops ?? []).map((s) => {
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
  const toFrequency = (calendar) =>
    typeof calendar === "string" ? calendar : (renderCalendar(calendar) ?? null);

  const trains = {};
  for (const j of journeys ?? []) {
    const number = String(j?.train ?? "").match(/(\d{3,5})/)?.[1];
    if (!number || !(j?.stops?.length >= 2)) continue;
    trains[number] = {
      lineName: number,
      operator: "European Sleeper",
      polyline: j?.polyline ?? null,
      stations: toStations(j.stops),
      frequency: toFrequency(j?.calendar),
      // Which source the stops and times came from, so provenance is visible
      // without re-reading the page.
      timetableSource: j?.timetableSource ?? "gtfs",
    };
    // The next timetable period, when the feed already carries it. Same shape as
    // the train itself so the merge can build a second row from it directly.
    if (j?.future?.activeFrom && j.future.stops?.length >= 2) {
      trains[number].future = {
        activeFrom: j.future.activeFrom,
        polyline: j.future.polyline ?? null,
        stations: toStations(j.future.stops),
        frequency: toFrequency(j.future.calendar),
      };
    }
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

// Timetable periods.
//
// The feed spans the European timetable change — the second Sunday in December —
// and on that date a train can switch both its routing and its operating days.
// Reading the whole future window as one timetable merges the two: that is how
// ES 400 came to advertise four weekdays when it runs three in each period, and
// to show the December routing four months early.
//
// So trips are split at the change date, and each side is summarised on its own.
// Splitting by date rather than by stop sequence matters: within one period a
// train still has minor variants (a Sunday that skips a stop, an engineering
// diversion), and grouping on the sequence would fragment the weekday set.
// A handful of stray dates after the change date is not a new timetable, so the
// upcoming period has to be substantial before it earns its own line. The
// current period has no such floor: a train still running even once should show.
const MIN_FUTURE_PERIOD_TRIPS = 3;

// decemberTimetableChange / nextTimetableChangeAfter now live in lib/gtfs.mjs,
// because the same question — which weekdays does this train run — has the same
// wrong answer in any date-expanded feed read as one window. SNCF hit it next.

/**
 * Split a route's future trips into [current, next?] timetable periods.
 * Each period carries its trips, the dates they run, and the modal stop
 * sequence within that period (so a one-off diversion cannot define a routing).
 */
function periodsForRoute(trips, { gtfs, datesOf, todayCompact }) {
  const change = nextTimetableChangeAfter(todayCompact);

  const buckets = [[], []];
  for (const trip of trips) {
    const stopTimes = gtfs.stopTimesByTrip.get(trip.trip_id) ?? [];
    if (stopTimes.length < 2) continue;
    for (const date of datesOf(trip)) {
      if (date < todayCompact) continue;
      const idx = change && date >= change ? 1 : 0;
      buckets[idx].push({ trip, stopTimes, date });
    }
  }

  const summarise = (runs, minRuns) => {
    if (runs.length < minRuns) return null;
    // Modal stop sequence within the period: the routing most departures use,
    // so an engineering diversion running a handful of times cannot win.
    const bySequence = new Map();
    for (const run of runs) {
      const key = run.stopTimes.map((st) => st.stop_id).join(" ");
      if (!bySequence.has(key)) bySequence.set(key, { stopTimes: run.stopTimes, trips: [], count: 0 });
      const g = bySequence.get(key);
      g.count += 1;
      g.trips.push(run.trip);
    }
    const [, modal] = [...bySequence.entries()].sort(
      (a, b) => b[1].count - a[1].count || b[1].stopTimes.length - a[1].stopTimes.length,
    )[0];
    // Weekdays come from every run in the period, not just the modal routing —
    // a Sunday departure that skips one stop still means the train runs Sundays.
    const dates = runs.map((r) => r.date).sort();
    return { stopTimes: modal.stopTimes, trips: modal.trips, dates };
  };

  return [
    summarise(buckets[0], 1),
    summarise(buckets[1], MIN_FUTURE_PERIOD_TRIPS),
  ].filter(Boolean);
}

// Summarise one period into the journey shape: canonicalised stops with
// wall-clock times, a calendar covering just that period, and its own geometry.
function summarisePeriod(period, gtfs) {
  const stops = period.stopTimes
    .map((st) => {
      const stop = gtfs.stopsById.get(st.stop_id);
      if (!stop) return null;
      return {
        // Canonicalize here, not downstream: enrich-view-map's updateVia writes
        // these names straight into via_*, and only BoT spellings link a station
        // to its route in deriveCities/buildAllRoutesPaths.
        name: resolveCanonicalStationName(stop.name),
        lat: stop.lat,
        lon: stop.lon,
        arrival: wallClock(st.arrival),
        departure: wallClock(st.departure),
      };
    })
    .filter(Boolean);

  const days = new Set(period.dates.map(dayKeyOf).filter(Boolean));
  const calendar = period.dates.length
    ? {
        validFrom: dashDate(period.dates[0]),
        validUntil: dashDate(period.dates[period.dates.length - 1]),
        daysOfWeek: DAY_KEYS.filter((d) => days.has(d)),
        exceptions: [],
        note: null,
        raw: null,
      }
    : null;

  const shapePts = period.trips[0]?.shape_id
    ? gtfs.shapePoints.get(period.trips[0].shape_id)
    : null;
  const positions =
    shapePts && shapePts.length >= 2
      ? shapePts.map((p) => [p.lat, p.lon])
      : stops
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
          .map((s) => [s.lat, s.lon]);

  return {
    stops,
    calendar,
    polyline: positions.length >= 2 ? polyline.encode(positions) : null,
    activeFrom: period.dates.length ? dashDate(period.dates[0]) : null,
  };
}

// Whether the upcoming period deserves its own line on the map.
//
// Only when it changes WHEN the train runs or WHICH CITIES it links. A train
// that keeps its days and endpoints but swaps an intermediate stop (ES 452 runs
// through Berlin Gesundbrunnen today and Ostbahnhof + Hbf from December) would
// draw a second line tracing almost exactly the first — visual noise that reads
// as one thick line. Endpoints compare by city, so ES 474 starting from
// Berlin-Spandau now and Berlin Gesundbrunnen later is one Berlin–Paris train,
// not two. Suppressed changes are not lost: the nightly scrape rolls them in by
// itself once it crosses the change date.
function worthShowingSeparately(current, next) {
  const days = (p) => (p.calendar?.daysOfWeek ?? []).join(",");
  if (days(current) !== days(next)) return true;
  const ends = (p) =>
    [p.stops[0]?.name, p.stops[p.stops.length - 1]?.name]
      .map((n) => cityForStation(n ?? "") || n)
      .join(" → ");
  return ends(current) !== ends(next);
}

/**
 * Build journeys from a loaded GTFS feed.
 *
 * @param {ReturnType<import("../lib/gtfs.mjs").loadGtfsDir>} gtfs
 * @param {string[]} args.routeShortNames  Allowlisted route_short_name values
 * @param {string} args.today              "YYYY-MM-DD"; trips that never run
 *   again on or after this date are ignored, so a retired routing can't win
 * @param {object} [args.stats]            Out-param: { matched, unmatched, feedRouteCount }
 * @returns {{train, stops, calendar, polyline, future?: object}[]} `future` is
 *   present when the feed already contains the next timetable period, so the
 *   map can show the current routing and the upcoming one side by side.
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

    const datesOf = (trip) => gtfs.addedDatesByService.get(trip.service_id) ?? [];
    const live = trips.filter((t) => datesOf(t).some((d) => d >= todayCompact));
    if (live.length === 0) continue; // route has finished running

    const periods = periodsForRoute(live, { gtfs, datesOf, todayCompact });
    if (periods.length === 0) continue;

    const current = summarisePeriod(periods[0], gtfs);
    const journey = {
      train: shortName,
      stops: current.stops,
      calendar: current.calendar,
      polyline: current.polyline,
    };
    if (periods[1]) {
      const next = summarisePeriod(periods[1], gtfs);
      if (next.activeFrom && worthShowingSeparately(current, next)) {
        journey.future = next;
      }
    }
    journeys.push(journey);
  }

  if (stats) {
    stats.matched = [...matched];
    stats.unmatched = routeShortNames.filter((n) => !matched.has(n));
    stats.feedRouteCount = tripsByRoute.size;
  }
  return journeys;
}

// Station-name → coords straight from the feed, for the resolver's fallback layer.
/**
 * Lay the operator's published timetable over the feed's.
 *
 * European Sleeper publishes its own timetable, and where the two disagree the
 * operator is right: the feed runs ES 474 out of Berlin-Spandau at 17:52 while
 * the operator runs it out of Berlin Gesundbrunnen at 17:25, and Spandau appears
 * nowhere on the published page.
 *
 * The page cannot be asked for a date, though — its picker is JS-driven — so a
 * nightly fetch only sees the trains running now. ES 400/401 don't start until
 * September and the December timetable isn't reachable at all, so the feed still
 * fills those gaps and each train upgrades to operator data by itself on the day
 * the page starts carrying it.
 *
 * The feed defines the set of trains (the allowlist gates it) and always keeps
 * geometry; the page contributes stops, times and service days.
 *
 * @param {object[]} feedJourneys  from journeysFromGtfs
 * @param {object[]} pageJourneys  from parseTimetableHtml
 * @param {(msg: string) => void} [log]
 * @returns {object[]} journeys carrying `timetableSource`
 */
/**
 * Extend a GTFS shape so it reaches the stations the operator actually names.
 *
 * Stops come from the page and geometry from the feed, and when the two disagree
 * about a terminus the drawn line stops short of its own marker: the feed runs
 * ES 474 out of Berlin-Spandau, the operator out of Berlin Gesundbrunnen, 13 km
 * away. Rather than discard a 7,000-point real-track shape over that gap, or
 * leave the line detached from its endpoint, the missing leg is drawn straight.
 * It reads honestly — the operator starts here, the feed's track starts there.
 *
 * Returns the input untouched when both ends already sit on the shape, so a
 * train whose sources agree keeps a byte-identical polyline.
 */
function stitchGeometryToStops(encoded, stops, resolveStation, toleranceKm = 2) {
  if (!encoded || typeof resolveStation !== "function") return encoded;
  const points = polyline.decode(encoded);
  if (points.length < 2 || !stops?.length) return encoded;

  const ends = [
    { coords: resolveStation(stops[0]?.name), at: 0 },
    { coords: resolveStation(stops[stops.length - 1]?.name), at: points.length - 1 },
  ];
  const out = [...points];
  let extended = false;
  for (const { coords, at } of ends) {
    if (!coords) continue;
    const [lat, lng] = points[at];
    if (distanceKm(coords.lat, coords.lon, lat, lng) <= toleranceKm) continue;
    if (at === 0) out.unshift([coords.lat, coords.lon]);
    else out.push([coords.lat, coords.lon]);
    extended = true;
  }
  return extended ? polyline.encode(out) : encoded;
}

export function mergePageOverFeed(
  feedJourneys,
  pageJourneys = [],
  { log = () => {}, resolveStation = null } = {},
) {
  const numberOf = (value) => String(value ?? "").match(/(\d{3,5})/)?.[1] ?? null;

  const page = new Map();
  for (const p of pageJourneys ?? []) {
    const n = numberOf(p?.number ?? p?.train);
    if (n && p?.stops?.length >= 2) page.set(n, p);
  }

  const used = new Set();
  const merged = (feedJourneys ?? []).map((j) => {
    const n = numberOf(j?.train);
    const p = n ? page.get(n) : null;
    if (!p) return { ...j, timetableSource: "gtfs" };
    used.add(n);

    // Canonicalize here, at the one boundary where page names start being used
    // as keys. The parser keeps the operator's spelling so drift stays visible,
    // but "Hamburg-Harburg" matches no station: it resolves to no coordinates,
    // drops off the map, and reaches via_* in a form deriveCities cannot link.
    const stops = p.stops.map((s) => ({
      ...s,
      name: resolveCanonicalStationName(s.name),
    }));

    return {
      ...j,
      // Geometry and the upcoming period stay the feed's; stops and times do not.
      stops,
      polyline: stitchGeometryToStops(j?.polyline, stops, resolveStation),
      // The page states days but no validity window, so keep the feed's dates.
      calendar: p.daysOfWeek?.length
        ? { ...(j?.calendar ?? {}), daysOfWeek: p.daysOfWeek }
        : j?.calendar,
      timetableSource: "europeansleeper.eu",
    };
  });

  const extra = [...page.keys()].filter((n) => !used.has(n));
  if (extra.length) {
    // A train the operator publishes but the feed has no route for: it would
    // have no geometry, and the allowlist is what decides which routes we carry,
    // so it is reported rather than invented.
    log(`page lists ${extra.length} train(s) the feed does not carry: ${extra.join(", ")}`);
  }
  return merged;
}

export function feedCoordIndex(gtfs) {
  const index = {};
  for (const stop of gtfs.stopsById.values()) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    const name = resolveCanonicalStationName(stop.name);
    if (name && !(name in index)) index[name] = { lat: stop.lat, lon: stop.lon };
  }
  return index;
}

const TIMETABLE_USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

/**
 * The operator's published timetable, or [] when it cannot be read.
 *
 * Deliberately never throws: the GTFS feed can carry a whole night on its own,
 * so a page outage costs us the operator's times, not the operator's trains.
 */
async function fetchTimetableJourneys(url, log) {
  if (!url) {
    log("no params.timetableUrl — using GTFS times only");
    return [];
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": TIMETABLE_USER_AGENT, Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) {
      log(`timetable page returned ${res.status} — using GTFS times only`);
      return [];
    }
    const journeys = parseTimetableHtml(await res.text());
    if (journeys.length === 0) {
      // A 200 that parses to nothing means the markup moved, which is worth
      // saying out loud: it looks identical to "no trains today" otherwise.
      log(`timetable page parsed to 0 trains — markup may have changed (${url})`);
    }
    return journeys;
  } catch (err) {
    log(`timetable page fetch failed (${err.message}) — using GTFS times only`);
    return [];
  }
}

/**
 * Fares for every train, night by night, from the operator's booking API plus
 * the last-minute deals its fare finder leaves out (scripts/lib/es-fare-
 * calendar.mjs). Never fatal: a timetable without prices is still the
 * timetable, so any failure here costs the fares, not the trains.
 */
async function priceTrains(trains, entry, ctx, log) {
  const cfg = entry.params?.fares;
  if (!cfg || cfg.enabled === false) return null;
  const previous =
    readJsonSafe(path.join(ctx.rootDir, "public", "data", "scraped", entry.output)) ?? null;
  const previousTrains = previous?.data?.trains ?? previous?.trains ?? null;
  const booking =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "operator-booking.json")) ?? {};
  const curated = booking?.[entry.agencyDefaults?.agencyId ?? "ES"]?.stationNames ?? {};
  let dealPages = null;
  // Promotional programmes, each an index page of per-direction offer pages:
  // last-minute (1–3 weeks out) and flash sales (selected dates further out).
  const programmes = [
    cfg.lastMinute && { id: "lastMinute", indexPath: "/last-minute", ...cfg.lastMinute },
    cfg.flashSale && { id: "flashSale", indexPath: "/flash-sale", ...cfg.flashSale },
  ].filter(Boolean);
  // A page that names no train in the registry is attributed by the route its
  // link text names ("offer from Paris and Brussels to Hamburg and Berlin") or
  // its address does (/flash-paris-berlin), matched on the cities each train
  // starts and ends in.
  const trainCities = Object.fromEntries(
    Object.entries(trains).map(([key, t]) => [
      key,
      [t.stations?.[0]?.name, t.stations?.[t.stations.length - 1]?.name].map(
        (n) => cityForStation(n ?? "") || n || "",
      ),
    ]),
  );
  try {
    const stats = await fillEsFareCalendars(trains, previousTrains, {
      today: ctx.today,
      fetchImpl: ctx.fetch ?? fetch,
      curated,
      days: cfg.days ?? undefined,
      budget: cfg.searchesPerRun ?? ES_FARE_BUDGET,
      loadDeals: programmes.length
        ? async () => {
            const result = await fetchDeals({
              programmes,
              trains,
              trainCities,
              today: ctx.today,
              fetchImpl: ctx.fetch ?? fetch,
              // As far ahead as the calendar reaches: a flash sale sells
              // nights two and a half months out.
              ...(cfg.days ? { horizonDays: cfg.days } : {}),
            });
            dealPages = result.pages.map(({ path: p, programme, status, ids, dated, outside, used, train }) => ({
              path: p, programme, status, ids, dated, ...(outside ? { outside } : {}), used, train,
            }));
            return result;
          }
        : null,
    });
    log(
      `${stats.searched}/${stats.planned} night(s) searched in ${stats.requests} request(s) ` +
        `(${stats.priced} priced, ${stats.none} with no berth on sale, ${stats.errors} failed, ${stats.retries} retried` +
        `${stats.stopped ? ", stopped early" : ""}); ${stats.deals} promotional deal(s)` +
        `${stats.dealsFrom != null ? ` from €${stats.dealsFrom}` : ""}; fares for ` +
        `${Object.values(trains).filter((t) => t.fare).length}/${Object.keys(trains).length} trains` +
        `${stats.unpriced.length ? ` (no station ids: ${stats.unpriced.join(", ")})` : ""}`,
    );
    return { checkedAt: ctx.today, dealPages };
  } catch (err) {
    log(`fare pass failed (${err.message}) — trains published without fares`);
    return null;
  }
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
  // The operator's own timetable wins over the feed wherever it carries a train.
  const pageJourneys = await fetchTimetableJourneys(entry.params?.timetableUrl, log);
  const merged = mergePageOverFeed(journeys, pageJourneys, { log, resolveStation });
  const fromPage = merged
    .filter((j) => j.timetableSource === "europeansleeper.eu")
    .map((j) => j.train);
  log(
    fromPage.length
      ? `timetable page supplied stops and times for ${fromPage.length}/${merged.length} train(s): ${fromPage.join(", ")}`
      : `timetable page supplied nothing — all ${merged.length} train(s) on GTFS times`,
  );

  const trains = normalizeEsTrains(merged, { resolveStation, today: ctx.today });

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

  const fares = await priceTrains(trains, entry, ctx, log);

  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    trains,
    // Compact provenance rather than the 87 KB page: which trains the operator
    // supplied tonight, so a regression is visible in the committed diff.
    timetable: {
      url: entry.params?.timetableUrl ?? null,
      trainsFromPage: fromPage,
    },
    // Which landing pages yielded last-minute deals tonight, so a page whose
    // markup moved shows up in the committed diff as a page that went quiet.
    ...(fares ? { fares } : {}),
  });
  log(`stored ${built} trains`);
}
