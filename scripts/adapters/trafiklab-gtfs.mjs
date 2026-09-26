// scripts/adapters/trafiklab-gtfs.mjs
// Sweden's night trains from Trafiklab's GTFS Sweden 3 — the national
// aggregate Samtrafiken builds from every operator's timetable, published at
// opendata.samtrafiken.se behind a free API key (TRAFIKLAB_API_KEY).
//
// Why it is worth a dedicated adapter rather than a gtfs-sleeper allowlist:
//
// 1. The feed says which trains are sleepers. Samtrafiken files them under the
//    extended GTFS route_type 105 ("Sleeper Rail Service"), and names each
//    route by its train number (route_short_name "94"). So the allowlist is a
//    list of numbers, not a heuristic over endpoints and departure times — and,
//    unlike SNCF or Entur, a service day here belongs to ONE train, which is
//    what makes updateServiceDays safe to switch on.
//
// 2. It is too big for readCsv. stop_times.txt is 698 MB (past V8's string
//    limit) and shapes.txt 2.4 GB, so every table is streamed straight out of
//    the zip (streamZipCsv) and only the allowlisted trips are kept. The rail
//    shapes turned out to be the stop coordinates again — 3 to 17 points for a
//    Stockholm–Luleå run — so shapes.txt is not read at all and the line is the
//    chain through the official stops.
//
// 3. It is date-expanded and full of engineering works. SJ 1 alone has 28
//    trips over eleven weeks, each covering a few dates with its own detour or
//    shifted time. The train's routing is therefore the MODAL stop pattern —
//    weighted by the dates it runs on, not by trip count and not "the trip
//    with the most stations", which picks whichever week a diversion added a
//    stop — and its days are the weekdays it runs on across the timetable
//    period, not one trip's calendar.
//
// 4. Its foreign stops are a Swedish traveller's view. Snälltåget's Berlin
//    train comes through as Stockholm … Malmö – København Syd – Berlin, with no
//    Hamburg, although the operator sells tickets to Hamburg. The feed is the
//    authority for Swedish stations, so only stations OUTSIDE Sweden are ever
//    borrowed from the Back-on-Track row, and only where they fall between two
//    stations the feed and the row both carry (fillForeignGaps).
//
// The feed also has a keyless mirror: the Mobility Database re-hosts it daily
// as mdb-2939 (the same latest.zip alias European Sleeper and CFR read). The
// key is the primary path because it is the publisher's own endpoint; the
// mirror is the fallback for a night the key is missing, revoked or out of
// quota (Bronze allows 60 requests per 30 days — one a night fits, a retry
// loop would not), so a quota hiccup costs nothing but a log line.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import {
  downloadFile,
  streamZipCsv,
  nextTimetableChangeAfter,
} from "../lib/gtfs.mjs";
import {
  resolveCanonicalStationName,
  inAgencyScope,
} from "../../src/pages/api/lib/primitives.mjs";
import { splitViaString } from "../../src/lib/viaSplit.mjs";

// ─── Small helpers ──────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const CAL_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "2026-09-26" or "20260926" → "20260926". */
export function compactDate(d) {
  return String(d ?? "").replace(/-/g, "").slice(0, 8);
}

/** "YYYYMMDD" → UTC Date. UTC throughout: a date here is a label, not an instant. */
function utcDate(yyyymmdd) {
  const s = String(yyyymmdd);
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
}

function addDays(yyyymmdd, n) {
  const d = utcDate(yyyymmdd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function daysBetween(a, b) {
  return Math.round((utcDate(b) - utcDate(a)) / 86400000);
}

const slashDate = (d) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;

/** "30:59:00" → "06:59". The feed writes past-midnight times as hours ≥ 24. */
export function fmtTime(t) {
  const m = String(t ?? "").trim().match(/^(\d{1,3}):(\d{2})/);
  if (!m) return null;
  return `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}`;
}

function km(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return 6371 * Math.hypot(x, y);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readScraped(rootDir, name) {
  return readJsonSafe(path.join(rootDir, "public/data/scraped", name))?.data ?? null;
}

// ─── Allowlist ──────────────────────────────────────────────────────────────

/**
 * { operators: { "<feed agency_name>": { agencyId, operator } },
 *   routeTypes: ["105"],
 *   routes: [{ agency, route, name? }] }
 *
 * `route` is the feed's route_short_name (the train number), `name` the label
 * the Back-on-Track row carries when the two differ — Snälltåget's summer
 * Jämtland train is 24/25 in the feed and 3920/3921 in Back-on-Track, and the
 * trainsByNumber enrichment looks a row up by its own label.
 */
export function loadAllowlist(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(parsed?.routes) || !parsed.routes.length) {
    throw new Error(`allowlist ${configPath} needs a non-empty routes array`);
  }
  return {
    operators: parsed.operators ?? {},
    routeTypes: (parsed.routeTypes ?? ["105"]).map(String),
    routes: parsed.routes.map((r) => ({
      agency: String(r.agency ?? "").trim(),
      route: String(r.route ?? "").trim(),
      name: String(r.name ?? r.route ?? "").trim(),
    })),
  };
}

// ─── Feed loading (streamed) ────────────────────────────────────────────────

/**
 * Read what the allowlist needs out of a GTFS Sweden 3 zip. Small tables are
 * read whole; stop_times.txt is streamed and filtered to the selected trips.
 *
 * @returns {Promise<object>} the in-memory tables buildTrafiklabTrains takes
 */
export async function loadFeed(zipPath, allowlist, { log = () => {} } = {}) {
  const read = async (member, keep = null) => {
    const rows = [];
    await streamZipCsv(zipPath, member, (row) => rows.push(row), keep ? { keep } : {});
    return rows;
  };

  const agencyNameById = new Map((await read("agency.txt")).map((a) => [a.agency_id, a.agency_name]));
  const routes = (await read("routes.txt")).map((r) => ({
    ...r,
    agency_name: agencyNameById.get(r.agency_id) ?? "",
  }));

  // Every route of a listed operator with a sleeper route_type, allowlisted or
  // not — the unlisted ones are how a new night train announces itself.
  const operatorNames = new Set([
    ...Object.keys(allowlist.operators),
    ...allowlist.routes.map((r) => r.agency),
  ]);
  const candidateRoutes = routes.filter(
    (r) => operatorNames.has(r.agency_name) && allowlist.routeTypes.includes(String(r.route_type)),
  );
  const candidateIds = new Set(candidateRoutes.map((r) => r.route_id));

  const trips = await read("trips.txt", { column: "route_id", test: (id) => candidateIds.has(id) });
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const serviceIds = new Set(trips.map((t) => t.service_id));

  const stopTimes = await read("stop_times.txt", { column: "trip_id", test: (id) => tripIds.has(id) });
  const stopIds = new Set(stopTimes.map((st) => st.stop_id));

  // stop_times points at platforms; their parent is the station, with the
  // station's own name and coordinate. Two passes over one 10 MB file are
  // cheaper than holding all 60 000 stops.
  const stopsById = new Map();
  const parents = new Set();
  await streamZipCsv(zipPath, "stops.txt", (s) => {
    if (!stopIds.has(s.stop_id)) return;
    stopsById.set(s.stop_id, s);
    if (s.parent_station) parents.add(s.parent_station);
  });
  await streamZipCsv(zipPath, "stops.txt", (s) => {
    if (parents.has(s.stop_id)) stopsById.set(s.stop_id, s);
  });

  const byService = { column: "service_id", test: (id) => serviceIds.has(id) };
  const calendar = await read("calendar.txt", byService);
  const calendarDates = await read("calendar_dates.txt", byService);
  const feedInfo = (await read("feed_info.txt"))[0] ?? {};

  log(
    `feed ${feedInfo.feed_version ?? "(no version)"}: ${candidateRoutes.length} sleeper route(s) of the listed operators, ${trips.length} trip(s), ${stopTimes.length} stop time(s)`,
  );
  return { routes: candidateRoutes, trips, stopTimes, stopsById, calendar, calendarDates, feedInfo };
}

// ─── Service dates ──────────────────────────────────────────────────────────

/** service_id → Set("YYYYMMDD"), from calendar.txt weekday spans plus exceptions. */
export function serviceDatesById(calendar, calendarDates) {
  const out = new Map();
  const set = (id) => {
    if (!out.has(id)) out.set(id, new Set());
    return out.get(id);
  };
  for (const c of calendar ?? []) {
    const dates = set(c.service_id);
    const flags = CAL_DAYS.map((d) => c[d] === "1");
    if (!flags.some(Boolean) || !/^\d{8}$/.test(c.start_date) || !/^\d{8}$/.test(c.end_date)) continue;
    for (let d = c.start_date; d <= c.end_date; d = addDays(d, 1)) {
      if (flags[utcDate(d).getUTCDay()]) dates.add(d);
    }
  }
  for (const cd of calendarDates ?? []) {
    const dates = set(cd.service_id);
    if (cd.exception_type === "1") dates.add(cd.date);
    else if (cd.exception_type === "2") dates.delete(cd.date);
  }
  return out;
}

/**
 * The timetable period a train is described in: the one running now, unless
 * fewer than `minDays` of it remain — then the next one, if the feed already
 * carries it. Answering in the last week of a period would read "Thu, Fri" for
 * a daily train, because only a Thursday and a Friday are left.
 */
export function pickServiceWindow(today, allDates, { minDays = 14 } = {}) {
  const start = compactDate(today);
  const change = nextTimetableChangeAfter(start);
  const current = { start, end: change };
  if (!change || daysBetween(start, change) >= minDays) return current;
  const next = { start: change, end: nextTimetableChangeAfter(change) };
  const nextHasData = [...allDates].some((d) => d >= next.start && (!next.end || d < next.end));
  return nextHasData ? next : current;
}

const inWindow = (d, w) => d >= w.start && (!w.end || d < w.end);

// ─── Service days → display string ──────────────────────────────────────────

/**
 * The weekdays a train runs on, from its dates. A weekday counts when it
 * carries at least `minShare` of the busiest weekday's runs: an engineering
 * works diversion that moves one Saturday run to a Monday should not make a
 * Sunday-to-Friday train read "Daily".
 */
export function weekdayList(dates, { minShare = 0.25 } = {}) {
  const counts = new Array(7).fill(0);
  for (const d of dates) counts[utcDate(d).getUTCDay()] += 1;
  const max = Math.max(...counts);
  if (!max) return null;
  const days = MONDAY_FIRST.filter((wd) => counts[wd] > 0 && counts[wd] >= max * minShare);
  return days.length === 7 ? "Daily" : days.map((wd) => WEEKDAY_SHORT[wd]).join(", ");
}

/**
 * "When does it run", in the shape the row schema reads.
 *
 * The feed only reaches as far as the next timetable change (Samtrafiken
 * publishes about eleven weeks ahead), so the span of a train's dates is not
 * its season: a year-round train simply stops at the horizon. What IS a season
 * is a train that stops running well before the horizon every other train
 * reaches — Snälltåget's Malmö–Storlien summer train ends on 3 October while
 * SJ runs on to 11 December — and that one is written with its dates, which
 * is what lets the map retire it the day after its last run.
 *
 * The start of such a season is usually before the feed begins, and inventing
 * it from the feed's first date would publish an eleven-day "season" for a
 * train that ran all summer. So the start comes from the row when it already
 * states one (`rowSeasonStart`), and the feed's first date only when the train
 * genuinely starts inside the feed.
 */
export function renderServiceDays(
  trainDates,
  { horizonStart, horizonEnd, rowSeasonStart = null, slackDays = 7, minShare = 0.25 } = {},
) {
  const dates = [...trainDates].sort();
  if (!dates.length) return null;
  const days = weekdayList(dates, { minShare });
  if (!days) return null;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const opensBefore = !horizonStart || daysBetween(horizonStart, first) <= slackDays;
  const runsToHorizon = !horizonEnd || daysBetween(last, horizonEnd) <= slackDays;
  const yearly = `${first.slice(0, 4)}: ${days}`;
  if (runsToHorizon) return yearly;

  let start = first;
  const rowStart = compactDate(rowSeasonStart);
  if (opensBefore && /^\d{8}$/.test(rowStart) && rowStart <= first && rowStart.slice(0, 4) === first.slice(0, 4)) {
    start = rowStart;
  }
  if (start.slice(0, 4) !== last.slice(0, 4)) return yearly;
  return `${slashDate(start)}-${slashDate(last)}: ${days}`;
}

/** The first date of a row's stated season ("2026/06/25-09/27: Wed, Sat"), or null. */
export function rowSeasonStart(serviceString) {
  const m = String(serviceString ?? "").match(/^\s*(\d{4})\/(\d{2})\/(\d{2})\s*-/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

// ─── Representative run ─────────────────────────────────────────────────────

/**
 * Pick the run that describes the train.
 *
 * Patterns are weighted by the dates they run on. Among those carrying at
 * least `minShare` of the heaviest one's dates — a near tie — the one with the
 * most stops wins: Snälltåget 300 lists every night twice, once as the
 * Berlin–Malmö sleeper portion (3 stops) and once as the through train to
 * Stockholm (12), and the two tie on dates. The share is 0.9, not 0.5: at a
 * half SJ 2 came out calling at Helsingborg, which it skips on most nights. A pattern below the share — the Friday extension
 * to Dresden, a works diversion calling at five stations — never wins however
 * long it is. Within the pattern the most-run timing wins, for the same reason.
 *
 * @param {Array<{tripId: string, stops: Array<{station: string}>, dates: Set<string>}>} runs
 */
export function pickRepresentativeRun(runs, { minShare = 0.9 } = {}) {
  const patterns = new Map();
  for (const run of runs) {
    if (!run.dates.size || run.stops.length < 2) continue;
    const key = run.stops.map((s) => s.station).join("|");
    if (!patterns.has(key)) patterns.set(key, { stops: run.stops.length, dates: new Set(), runs: [] });
    const p = patterns.get(key);
    for (const d of run.dates) p.dates.add(d);
    p.runs.push(run);
  }
  if (!patterns.size) return null;
  const heaviest = Math.max(...[...patterns.values()].map((p) => p.dates.size));
  const best = [...patterns.values()]
    .filter((p) => p.dates.size >= heaviest * minShare)
    .sort((a, b) => b.stops - a.stops || b.dates.size - a.dates.size)[0];

  // The usual clock is the most-run (departure, arrival) PAIR, not the most-run
  // full timing: a works period nudges intermediate stops by a minute or two
  // and splits one timetable into many "timings", and the most-run of those
  // fragments need not carry the endpoint times most nights actually have.
  const ends = (run) =>
    `${run.stops[0]?.departure ?? run.stops[0]?.arrival}>${run.stops[run.stops.length - 1]?.arrival}`;
  const pairs = new Map();
  for (const run of best.runs) {
    const key = ends(run);
    if (!pairs.has(key)) pairs.set(key, { dates: new Set(), runs: [] });
    const p = pairs.get(key);
    for (const d of run.dates) p.dates.add(d);
    p.runs.push(run);
  }
  const pair = [...pairs.values()].sort((a, b) => b.dates.size - a.dates.size)[0];
  return pair.runs.sort((a, b) => b.dates.size - a.dates.size)[0];
}

// ─── Upcoming deviations ────────────────────────────────────────────────────

/**
 * The nights in the next `days` on which the train does NOT run its usual
 * timetable, with what it runs instead.
 *
 * The card shows the train's usual run — the modal pattern — because that is
 * what describes it on a map and in a planner. But engineering works are
 * dated, and they are exactly what a traveller checking a night next week runs
 * into: SJ 93 normally reaches Stockholm at 10:13, and from 21 September to 2
 * October it runs via the inland line, calls at 10 stations instead of 17 and
 * arrives at 12:13, 13:42, 14:13 or 14:26 depending on the night — which is what
 * sj.se shows for any one of those dates. Listing those nights next to the
 * usual timetable says both things at once instead of picking one to be wrong.
 *
 * A night differs when its fullest run calls at a different set of stations,
 * or starts or ends more than `toleranceMinutes` off the usual time. A few
 * minutes' drift is not a deviation worth printing.
 *
 * @returns {Array<{date, from, to, departure, arrival, stops, skipped, added}>}
 */
export function upcomingDeviations(
  runs,
  representative,
  { today, days = 14, toleranceMinutes = 10, nameOf = (s) => s.feed?.name ?? s.station } = {},
) {
  if (!representative) return [];
  const clock = (t) => {
    const m = String(t ?? "").match(/^(\d+):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const firstTime = (run) => clock(run.stops[0]?.departure ?? run.stops[0]?.arrival);
  const lastTime = (run) =>
    clock(run.stops[run.stops.length - 1]?.arrival ?? run.stops[run.stops.length - 1]?.departure);
  const pattern = (run) => run.stops.map((s) => s.station).join("|");
  // Beyond this an end time is a different timetable, below it a timing
  // tweak the usual timetable already describes.
  const offBy = (a, b) => a === null || b === null || Math.abs(a - b) > toleranceMinutes;
  const sameAsUsual = (run) =>
    pattern(run) === pattern(representative) &&
    !offBy(firstTime(run), firstTime(representative)) &&
    !offBy(lastTime(run), lastTime(representative));
  const usualStations = new Set(representative.stops.map((s) => s.station));
  const start = compactDate(today);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(start, i);
    const tonight = runs.filter((r) => r.dates.has(date));
    if (!tonight.length) continue;
    const fullest = tonight.sort((a, b) => b.stops.length - a.stops.length || (a === representative ? -1 : 1))[0];
    if (fullest === representative || sameAsUsual(fullest)) continue;
    const stations = new Set(fullest.stops.map((s) => s.station));
    const first = fullest.stops[0];
    const last = fullest.stops[fullest.stops.length - 1];
    out.push({
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      from: nameOf(first),
      to: nameOf(last),
      departure: fmtTime(first.departure ?? first.arrival),
      arrival: fmtTime(last.arrival ?? last.departure),
      stops: fullest.stops.length,
      skipped: representative.stops.filter((s) => !stations.has(s.station)).map(nameOf),
      added: fullest.stops.filter((s) => !usualStations.has(s.station)).map(nameOf),
    });
  }
  return out;
}

// ─── Station names ──────────────────────────────────────────────────────────

// Suffixes the feed puts on a station name that the rest of the dataset does
// not. Longest first, so "Resecentrum Tät" goes before "Resecentrum".
const NAME_SUFFIXES = [
  " Resecentrum Tät",
  " C/Resecentrum",
  " järnvägsstation",
  " resecentrum",
  " Resecentrum",
  " Turist E10",
  " station",
  " Station",
  " ReseC",
  " bstn",
];

// The one foreign spelling Samtrafiken writes differently from everybody
// else: "Köbenhavn" with a Swedish ö.
const LETTER_FIXES = [[/^Köbenhavn\b/, "København"]];

/**
 * Spellings to try for a feed station name, most specific first.
 *
 * "Umeå Centralstation" is "Umeå C" in Back-on-Track, "Härnösand Central" is
 * "Härnösands central", "Hudiksvalls station" is "Hudiksvall" (a Swedish
 * genitive), "Berlin Hbf (Tief)" is "Berlin Hbf".
 */
export function nameCandidates(feedName) {
  let n = String(feedName ?? "").trim().replace(/\s*\([^)]*\)\s*$/, "");
  for (const [re, to] of LETTER_FIXES) n = n.replace(re, to);
  const out = [];
  const push = (x) => {
    const v = String(x ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const central = n.match(/^(.*) (?:Centralstation(?: Tåg)?|[Cc]entral)$/);
  if (central) {
    const b = central[1];
    push(`${b} C`);
    push(`${b} central`);
    push(`${b}s central`);
    push(b);
  }
  let base = n;
  for (const suffix of NAME_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  push(base);
  push(`${base} C`);
  push(`${base} central`);
  push(`${base}s central`);
  if (/[^s]s$/.test(base)) push(base.slice(0, -1));
  push(n);
  return out;
}

/**
 * Name a feed station the way the rest of the payload does — but only where
 * that name is provably the same place.
 *
 * A via station becomes a map dot only when a coordinate-bearing stop of that
 * exact name exists, so reusing Back-on-Track's spelling is what buys the dot.
 * But Back-on-Track's coordinates are not to be trusted blind: "Boden" sits
 * 2 271 km from Boden, "Stockholms central" 1 164 km from Stockholm — the same
 * geocoder failure that put Norway's stations across Europe. So a candidate is
 * accepted only when its coordinate lies within `matchKm` of the feed's own.
 * A station with no such match keeps its own (suffix-stripped) name, and the
 * build injects it as a new stop at the feed's coordinate.
 *
 * @returns {(stop: {name: string, lat: number, lon: number}) => {name: string, matched: boolean, collision: object|null}}
 */
export function makeStationNamer({ botStops, coordOverrides = {}, resolveAlias = (n) => n, matchKm = 3, prefixKm = 1.5 }) {
  const overrides = new Map(
    Object.entries(coordOverrides ?? {})
      .filter(([, v]) => Number.isFinite(v?.lat) && Number.isFinite(v?.lon))
      .map(([k, v]) => [k.toLowerCase().trim(), v]),
  );
  const index = new Map();
  for (const s of Object.values(botStops ?? {})) {
    if (!s?.stop_name) continue;
    const fix =
      overrides.get(String(s.stop_id ?? "").toLowerCase().trim()) ??
      overrides.get(String(s.stop_name).toLowerCase().trim());
    const lat = fix ? fix.lat : s.stop_lat;
    const lon = fix ? fix.lon : s.stop_lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = s.stop_name.toLowerCase().trim();
    if (!index.has(key)) index.set(key, { name: s.stop_name, lat, lon, country: s.stop_country ?? null });
  }
  const entries = [...index.values()];

  return (stop) => {
    const near = (hit) => hit && km(stop.lat, stop.lon, hit.lat, hit.lon) <= matchKm;
    const candidates = nameCandidates(stop.name);
    for (const c of candidates) {
      const aliased = resolveAlias(c);
      for (const name of [c, aliased]) {
        const hit = index.get(String(name).toLowerCase());
        if (near(hit)) return { name: hit.name, matched: true, collision: null };
      }
    }
    // "Södertälje syd station" is "Södertälje syd övre" — the long-distance
    // platforms — and "Mölndal station" is "Mölndals nedre": a longer name
    // starting with ours, standing where our station stands.
    const base = candidates.find((c) => !/ (C|central)$/.test(c)) ?? candidates[0];
    const prefixes = [base, `${base}s`].map((p) => `${p.toLowerCase()} `);
    let best = null;
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (!prefixes.some((p) => lower.startsWith(p))) continue;
      const d = km(stop.lat, stop.lon, e.lat, e.lon);
      if (d <= prefixKm && (!best || d < best.d)) best = { e, d };
    }
    if (best) return { name: best.e.name, matched: true, collision: null };

    const name = resolveAlias(base);
    // Our own name is taken by a station somewhere else. Publishing it would
    // put this stop's dot at that coordinate — say so rather than draw it.
    const taken = index.get(name.toLowerCase());
    return {
      name,
      matched: false,
      collision: taken ? { name: taken.name, km: Math.round(km(stop.lat, stop.lon, taken.lat, taken.lon)) } : null,
    };
  };
}

// ─── Foreign stations the feed leaves out ───────────────────────────────────

/** A Back-on-Track row direction as a station chain: origin, via…, destination. */
export function botChain(route, d, isKnownStation = null) {
  const origin = route?.[`origin_trip_${d}`];
  const destination = route?.[`destination_trip_${d}`];
  if (!origin || !destination) return [];
  return [origin, ...splitViaString(route[`via_${d}`], isKnownStation), destination].filter(Boolean);
}

/**
 * Put back the stations abroad that the feed skips.
 *
 * Only between two consecutive feed stations A and B, only stations the row
 * lists right after A (in the feed's direction of travel), only stations
 * OUTSIDE Sweden, and never one standing within `sameCityKm` of A or B —
 * Back-on-Track's "Berlin Hbf" is not a stop to add before the feed's
 * "Berlin Gesundbrunnen", it is the same city's other station. Anything the
 * feed says about a Swedish station stands, because that is what the feed is
 * the authority on.
 *
 * @param {Array} stations feed stations, in travel order, already named
 * @param {string[]} chain  the matching Back-on-Track direction, same order
 * @param {(name: string) => {lat: number, lon: number, country: string|null}|null} botStation
 */
export function fillForeignGaps(stations, chain, botStation, { homeCountry = "SE", sameCityKm = 15 } = {}) {
  if (!chain?.length || stations.length < 2) return { stations, inserted: [] };
  const fold = (n) => String(n ?? "").toLowerCase().trim();
  const inFeed = new Set(stations.map((s) => fold(s.name)));
  const chainIndex = new Map(chain.map((n, i) => [fold(n), i]));
  const out = [];
  const inserted = [];
  for (let i = 0; i < stations.length; i += 1) {
    const a = stations[i];
    out.push(a);
    const b = stations[i + 1];
    const at = chainIndex.get(fold(a.name));
    if (!b || at === undefined) continue;
    for (let j = at + 1; j < chain.length; j += 1) {
      const name = chain[j];
      if (inFeed.has(fold(name))) break;
      const bot = botStation(name);
      if (!bot || !bot.country || bot.country === homeCountry) break;
      const nearEnd = [a, b].some(
        (s) => s.location && km(s.location.latitude, s.location.longitude, bot.lat, bot.lon) <= sameCityKm,
      );
      if (nearEnd) break;
      const st = {
        name,
        code: null,
        location: { latitude: bot.lat, longitude: bot.lon },
        arrival: null,
        departure: null,
        pickup: true,
        dropoff: true,
        source: "backontrack",
      };
      out.push(st);
      inserted.push(name);
    }
  }
  return { stations: out, inserted };
}

/**
 * Which direction of a row describes this train, by the ORDER of the stations
 * both carry — not by the row's label. Back-on-Track files Snälltåget's
 * Stockholm–Berlin train as "300" and the feed runs 300 the other way.
 */
export function orientedChain(route, stationNames, isKnownStation = null) {
  const fold = (n) => String(n ?? "").toLowerCase().trim();
  const want = stationNames.map(fold);
  let best = null;
  for (const d of [0, 1]) {
    const chain = botChain(route, d, isKnownStation);
    const pos = new Map(chain.map((n, i) => [fold(n), i]));
    const hits = want.map((n) => pos.get(n)).filter((i) => i !== undefined);
    if (hits.length < 2) continue;
    let ordered = 0;
    for (let i = 1; i < hits.length; i += 1) if (hits[i] > hits[i - 1]) ordered += 1;
    const score = ordered / (hits.length - 1);
    if (score > 0.5 && (!best || score > best.score)) best = { d, chain, score };
  }
  return best;
}

// ─── Build ──────────────────────────────────────────────────────────────────

/**
 * The trains dict for every allowlisted sleeper, in the standard shape
 * (lineName, operator, agency_id, frequency, polyline, stations).
 *
 * Pure: every input is passed in, so tests can hand it a feed built in memory.
 */
export function buildTrafiklabTrains({
  feed,
  allowlist,
  today,
  botStops = {},
  coordOverrides = {},
  viewMap = {},
  agencyScope = null,
  resolveAlias = resolveCanonicalStationName,
  log = () => {},
  stats = null,
}) {
  const datesById = serviceDatesById(feed.calendar, feed.calendarDates);
  const namer = makeStationNamer({ botStops, coordOverrides, resolveAlias });

  const stopTimesByTrip = new Map();
  for (const st of feed.stopTimes) {
    if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
    stopTimesByTrip.get(st.trip_id).push(st);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }
  const tripsByRoute = new Map();
  for (const t of feed.trips) {
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  // A trip's dates, from today on.
  const todayCompact = compactDate(today);
  const tripDates = (t) =>
    new Set([...(datesById.get(t.service_id) ?? [])].filter((d) => d >= todayCompact));
  const allDates = new Set();
  for (const t of feed.trips) for (const d of tripDates(t)) allDates.add(d);
  const window = pickServiceWindow(today, allDates);

  const stationOf = (stopId) => {
    const stop = feed.stopsById.get(stopId);
    if (!stop) return null;
    const parent = stop.parent_station ? feed.stopsById.get(stop.parent_station) : null;
    const s = parent ?? stop;
    const lat = Number.parseFloat(s.stop_lat);
    const lon = Number.parseFloat(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { id: s.stop_id, name: String(s.stop_name ?? "").trim(), lat, lon };
  };

  // The runs of every allowlisted route, restricted to the service window.
  const selected = [];
  const unmatched = [];
  const listedRouteIds = new Set();
  for (const entry of allowlist.routes) {
    // route_type too, not only in loadFeed: SJ files a seated twin of train 1
    // under route_type 100, same agency, same number.
    const route = feed.routes.find(
      (r) =>
        r.agency_name === entry.agency &&
        String(r.route_short_name).trim() === entry.route &&
        allowlist.routeTypes.includes(String(r.route_type)),
    );
    if (!route) {
      unmatched.push(`${entry.agency} ${entry.route}`);
      continue;
    }
    listedRouteIds.add(route.route_id);
    const runs = [];
    for (const t of tripsByRoute.get(route.route_id) ?? []) {
      const dates = new Set([...tripDates(t)].filter((d) => inWindow(d, window)));
      if (!dates.size) continue;
      const stops = (stopTimesByTrip.get(t.trip_id) ?? [])
        .map((st) => {
          const station = stationOf(st.stop_id);
          return station
            ? {
                station: station.id,
                feed: station,
                arrival: st.arrival_time,
                departure: st.departure_time,
                pickup: st.pickup_type !== "1",
                dropoff: st.drop_off_type !== "1",
              }
            : null;
        })
        .filter(Boolean);
      runs.push({ tripId: t.trip_id, stops, dates });
    }
    if (!runs.length) {
      unmatched.push(`${entry.agency} ${entry.route} (no run in ${window.start}–${window.end ?? "…"})`);
      continue;
    }
    selected.push({ entry, route, runs });
  }

  // Horizon: how far the feed reaches for these trains, so a train that stops
  // well short of it can be told apart from one the feed simply ends on.
  let horizonStart = null;
  let horizonEnd = null;
  for (const { runs } of selected) {
    for (const run of runs) {
      for (const d of run.dates) {
        if (!horizonStart || d < horizonStart) horizonStart = d;
        if (!horizonEnd || d > horizonEnd) horizonEnd = d;
      }
    }
  }

  const unlisted = feed.routes
    .filter((r) => !listedRouteIds.has(r.route_id))
    .map((r) => `${r.agency_name} ${r.route_short_name}`);

  // Rows this source may enrich, by label — for the season start and the
  // foreign stations the feed leaves out.
  const rowsByLabel = new Map();
  for (const route of Object.values(viewMap ?? {})) {
    if (!inAgencyScope(route, agencyScope)) continue;
    for (const d of [0, 1]) {
      const label = String(route[`trip_short_name_${d}`] ?? "").trim();
      if (label && !rowsByLabel.has(label)) rowsByLabel.set(label, { route, d });
    }
  }
  const botIndex = new Map();
  for (const s of Object.values(botStops ?? {})) {
    if (!s?.stop_name || !Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    const key = s.stop_name.toLowerCase().trim();
    if (!botIndex.has(key)) botIndex.set(key, { lat: s.stop_lat, lon: s.stop_lon, country: s.stop_country ?? null });
  }
  const botStation = (name) => botIndex.get(String(name ?? "").toLowerCase().trim()) ?? null;
  const isKnownStation = (name) => Boolean(botStation(name));

  const trains = {};
  const collisions = [];
  const newStations = new Set();
  const insertedAbroad = [];
  for (const { entry, route, runs } of selected) {
    const run = pickRepresentativeRun(runs);
    if (!run) continue;
    const operatorCfg = allowlist.operators[entry.agency] ?? {};

    const stations = [];
    for (const s of run.stops) {
      const named = namer(s.feed);
      if (named.collision) collisions.push(`${s.feed.name} → "${named.name}" (${named.collision.km} km away)`);
      if (!named.matched) newStations.add(named.name);
      // A train calls at a station once; a duplicate is a works reversal.
      if (stations.length && stations[stations.length - 1].name === named.name) continue;
      stations.push({
        name: named.name,
        code: s.feed.id,
        location: { latitude: s.feed.lat, longitude: s.feed.lon },
        arrival: fmtTime(s.arrival),
        departure: fmtTime(s.departure),
        pickup: s.pickup,
        dropoff: s.dropoff,
      });
    }
    if (stations.length < 2) {
      unmatched.push(`${entry.agency} ${entry.route} (fewer than two located stops)`);
      continue;
    }

    // Days: every run of the train in the window, whatever its pattern — a
    // works diversion is still the train running that night.
    const trainDates = new Set();
    for (const r of runs) for (const d of r.dates) trainDates.add(d);
    const row = rowsByLabel.get(entry.name);
    const frequency = renderServiceDays(trainDates, {
      horizonStart,
      horizonEnd,
      rowSeasonStart: rowSeasonStart(row?.route?.[`service_id_${row?.d}`]),
    });

    let finalStations = stations;
    if (row) {
      const oriented = orientedChain(row.route, stations.map((s) => s.name), isKnownStation);
      if (oriented) {
        const filled = fillForeignGaps(stations, oriented.chain, botStation);
        finalStations = filled.stations;
        for (const n of filled.inserted) insertedAbroad.push(`${entry.name}: ${n}`);
      }
    }

    trains[entry.name] = {
      lineName: entry.name,
      operator: operatorCfg.operator ?? entry.agency,
      agency_id: operatorCfg.agencyId ?? null,
      frequency,
      polyline: polyline.encode(
        finalStations.map((s) => [s.location.latitude, s.location.longitude]),
      ),
      stations: finalStations,
      feedRoute: String(route.route_short_name),
      feedTrip: run.tripId,
      runsInWindow: trainDates.size,
      // Nights in the next fortnight that differ from the timetable above
      // (engineering works, a Dresden extension) — shown beside it.
      deviations: upcomingDeviations(runs, run, {
        today,
        nameOf: (s) => namer(s.feed).name,
      }),
    };
  }

  const relabelled = alignLabelsWithRows(trains, viewMap, agencyScope);

  if (stats) {
    Object.assign(stats, {
      relabelled,
      window,
      horizonStart,
      horizonEnd,
      unmatched,
      unlisted,
      collisions,
      newStations: [...newStations].sort(),
      insertedAbroad,
      feedRouteCount: feed.routes.length,
    });
  }
  if (unmatched.length) log(`WARNING: ${unmatched.length} allowlist entr${unmatched.length === 1 ? "y" : "ies"} matched no train: ${unmatched.join(", ")}`);
  if (unlisted.length) log(`sleeper routes in the feed that the allowlist does not list (one-offs and works portions are expected here): ${unlisted.join(", ")}`);
  if (collisions.length) log(`WARNING: station name(s) already used elsewhere in Back-on-Track — ${collisions.join("; ")}`);
  if (insertedAbroad.length) log(`kept ${insertedAbroad.length} station(s) abroad that the feed skips: ${insertedAbroad.join(", ")}`);
  if (newStations.size) log(`${newStations.size} station(s) not in Back-on-Track at the feed's position, published at the feed's coordinate: ${[...newStations].sort().join(", ")}`);
  for (const r of relabelled) {
    log(
      `WARNING: row ${r.row} labels its directions ${r.labels.join("/")} the other way round from the operator — matched by direction instead, so ${r.labels[0]} carries feed train ${r.feedRoutes[0]} and ${r.labels[1]} feed train ${r.feedRoutes[1]}`,
    );
  }
  return trains;
}

/**
 * Hand each row direction the train that runs that way, when the row's two
 * labels are the operator's two numbers the wrong way round.
 *
 * Back-on-Track files Snälltåget's Stockholm → Berlin train as "300"; the feed
 * (and the operator) call it 301, and 300 the northbound one. Matching by
 * number would turn the row around — which the row can survive, but the trips
 * table cannot: enrichment never rewrites trips, so the detail panel would
 * print trip "300 Stockholm C → Berlin Hbf" with Berlin-to-Stockholm times
 * under it, and the row's per-direction notes ("continues to Dresden on some
 * Fridays") under the wrong train. Swapping the two keys keeps every surface
 * describing one train per direction; the cost is that the row still shows
 * Back-on-Track's numbers, which is a label and is logged as such.
 *
 * Only a clean swap is made: both directions matched, both reversed.
 */
export function alignLabelsWithRows(trains, viewMap, agencyScope = null) {
  const fold = (n) => String(n ?? "").toLowerCase().trim();
  const reversed = (train, route, d) => {
    const first = fold(train?.stations?.[0]?.name);
    const last = fold(train?.stations?.[train.stations.length - 1]?.name);
    const origin = fold(route[`origin_trip_${d}`]);
    const dest = fold(route[`destination_trip_${d}`]);
    if (first === origin || last === dest) return false;
    return first === dest || last === origin;
  };
  const done = [];
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    if (!inAgencyScope(route, agencyScope)) continue;
    const labels = [0, 1].map((d) => String(route[`trip_short_name_${d}`] ?? "").trim());
    const [a, b] = labels.map((l) => (l ? trains[l] : null));
    if (!a || !b || labels[0] === labels[1]) continue;
    if (!reversed(a, route, 0) || !reversed(b, route, 1)) continue;
    trains[labels[0]] = { ...b, lineName: labels[0] };
    trains[labels[1]] = { ...a, lineName: labels[1] };
    done.push({ row: key, labels, feedRoutes: [b.feedRoute, a.feedRoute] });
  }
  return done;
}

// ─── Download ───────────────────────────────────────────────────────────────

const redact = (url) => String(url).replace(/([?&]key=)[^&]+/i, "$1***");

/**
 * Fetch the feed: the Trafiklab endpoint with the key, else the keyless
 * mirror. Returns which one answered, for the trains file and the log.
 */
async function fetchFeed(entry, destZip, log) {
  const params = entry.params ?? {};
  const keyEnv = params.apiKeyEnv || "TRAFIKLAB_API_KEY";
  const key = process.env[keyEnv];
  const attempts = [];
  if (key && params.feedUrl) {
    const sep = params.feedUrl.includes("?") ? "&" : "?";
    attempts.push({ source: "trafiklab", url: `${params.feedUrl}${sep}key=${encodeURIComponent(key)}` });
  } else {
    log(`${keyEnv} is not set — reading the Mobility Database mirror instead`);
  }
  for (const url of params.fallbackUrls ?? []) attempts.push({ source: "mirror", url });

  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  for (const attempt of attempts) {
    try {
      log(`downloading ${redact(attempt.url)}`);
      await downloadFile(attempt.url, destZip);
      const size = fs.statSync(destZip).size;
      if (size < 1e6) throw new Error(`only ${size} bytes — not a national feed`);
      log(`downloaded ${(size / 1e6).toFixed(0)} MB from ${attempt.source}`);
      return attempt.source;
    } catch (err) {
      // The message never carries the URL, so the key cannot leak through it.
      log(`${attempt.source} download failed: ${err.message}`);
    }
  }
  throw new Error("every feed URL failed");
}

// ─── Adapter entry point ────────────────────────────────────────────────────

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  if (!params.configPath) throw new Error(`${entry.id}: params.configPath is required`);
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const allowlist = loadAllowlist(path.join(ctx.rootDir, params.configPath));

  // A pre-downloaded zip (local runs, tests of a new allowlist) skips the
  // network entirely — and with it one of the key's 60 monthly requests.
  const manualZip = process.env[`${entry.id.toUpperCase().replace(/-/g, "_")}_GTFS_ZIP`];
  let zipPath;
  let feedSource;
  if (manualZip) {
    zipPath = path.resolve(ctx.rootDir, manualZip);
    feedSource = "local";
    log(`reading ${zipPath}`);
  } else {
    zipPath = path.join(ctx.rootDir, "gtfs-data", `${entry.id}.zip`);
    feedSource = await fetchFeed(entry, zipPath, log);
  }

  const feed = await loadFeed(zipPath, allowlist, { log });
  const viewMap = ctx.shared?.viewMap ?? readScraped(ctx.rootDir, "backontrack-view_ontd_map.json") ?? {};
  const botStops = ctx.shared?.stops ?? readScraped(ctx.rootDir, "backontrack-stops.json") ?? {};
  const coordOverrides =
    readJsonSafe(path.join(ctx.rootDir, "data", "overrides", "station-coordinates.json")) ?? {};

  const stats = {};
  const trains = buildTrafiklabTrains({
    feed,
    allowlist,
    today: ctx.today,
    botStops,
    coordOverrides,
    viewMap,
    agencyScope: entry.enrich?.agencyIds ?? entry.synthetic?.botMatchAgencies ?? null,
    log,
    stats,
  });

  const built = Object.keys(trains).length;
  if (built === 0) {
    throw new Error(
      `${entry.id}: 0 of ${allowlist.routes.length} allowlisted trains found in the feed — numbering or route_type may have changed (${stats.unmatched.join(", ")})`,
    );
  }
  for (const t of Object.values(trains)) {
    log(
      `${t.lineName}: ${t.stations[0].name} ${t.stations[0].departure} → ${t.stations[t.stations.length - 1].name} ${t.stations[t.stations.length - 1].arrival}, ${t.stations.length} stops, ${t.frequency}`,
    );
  }
  log(`built ${built} of ${allowlist.routes.length} allowlisted train(s) for ${stats.window.start}–${stats.window.end ?? "…"}`);

  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    feedVersion: feed.feedInfo?.feed_version ?? null,
    feedSource,
    window: stats.window,
    trains,
  });

  // The zip is 650 MB; nothing reads it again tonight.
  if (!manualZip) fs.rmSync(zipPath, { force: true });
}
