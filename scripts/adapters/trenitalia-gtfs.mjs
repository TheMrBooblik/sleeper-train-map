// scripts/adapters/trenitalia-gtfs.mjs
// Trenitalia Intercity Notte from the national GTFS (Mobility Database
// mdb-3569: Trenitalia's NeTEx from the Italian National Access Point,
// CCISS, converted to GTFS), with fares from lefrecce.it.
//
// Why not Viaggiatreno any more. The adapter used to ask Viaggiatreno's
// andamentoTreno for each train number in a registry list, and andamentoTreno
// is a *running status*: it only knows a train on a day that train runs. So
// the nightly file held whichever trains happened to run that day — between 13
// and 24 of the 34 numbers in October 2026, a different set every night — and
// because a healthy fetch is authoritative (scrape-data.mjs drops a train it
// did not see), weekend trains, every 3×-a-week train and whole directions
// (ICN 757, 765, 770, 794 and 799 on 21 October) dropped off the map on the
// nights they did not run. It also could not find a train running under a
// works number: Roma–Palermo ICN 1956/1959 runs as 95074/95063 until the
// December timetable, so it was missing from the map altogether. And its
// line was the station chain drawn straight.
//
// The GTFS has none of those problems: every ICN trip for the next ~3 months
// with its dates, stops, times and a real shapes.txt track. What it has
// instead is the operator's own bookkeeping, which this adapter turns back
// into "the trains":
//
//   - A train is a (number, first station, last station) unit, so a number
//     with two through-car portions (ICN 1955 Roma → Catania and Roma →
//     Palermo, split at Messina) is two trains; the smaller portion is labelled
//     with the city it serves, "ICN 1955 (Palermo)".
//   - A unit that stands in for another on the nights that one does not run —
//     same two stations, nights (almost) disjoint, leaving within a few hours —
//     is folded into it: works numbers (5-digit, 95063 for 1959) and short-lived
//     timetable numbers alike (ICN 1930 runs Palermo → Roma on the weeknights
//     ICN 1958 does not). The train keeps its timetable number and lists what
//     it runs as (`operatedAs`).
//   - Stops, times and line are the modal run over the current timetable
//     period, weighted by nights (pickRepresentativeRun, shared with
//     Trafiklab); service days are every night any of its runs operate.
//
// Station codes stay Viaggiatreno's ("S" + GTFS stop_id), which is what
// lefrecce.it and the operator's per-train schedule page address a station by.

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { downloadFile, streamZipCsv } from "../lib/gtfs.mjs";
import { titleCase } from "../lib/scrape-helpers.mjs";
import { simplifyPath } from "../lib/rail-graph.mjs";
import { fillFareCalendars } from "../lib/icn-fares.mjs";
import { FARE_CALENDAR_BUDGET, FARE_CALENDAR_DAYS } from "../lib/fare-calendar.mjs";
import {
  compactDate,
  pickRepresentativeRun,
  pickServiceWindow,
  renderServiceDays,
  serviceDatesById,
} from "./trafiklab-gtfs.mjs";
import { cityForStation } from "../../src/lib/seo/cities.mjs";

const TIME_ZONE = "Europe/Rome";

const DEFAULTS = {
  categories: ["ICN"],
  // RFI numbers a train running in place of a timetable train during works
  // from 10000 up (35051, 89645, 95063…); the timetable's own are below.
  variationNumberFrom: 10000,
  // A unit running fewer nights than this from today is a one-off (a single
  // diverted night under its own number) and is not a train of its own.
  minNights: 3,
  // A stand-in leaves within this many minutes of the train it replaces.
  standInClockMinutes: 180,
  // …and shares at most this fraction of its nights with it.
  standInMaxOverlap: 0.1,
  // Douglas–Peucker tolerance for the shapes.txt line, in metres.
  simplifyMeters: 30,
  stationNames: {},
};

// ─── Small helpers ──────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** "20:25:00" → minutes past midnight of the service day (hours may be ≥ 24). */
function minutesOf(t) {
  const m = String(t ?? "").trim().match(/^(\d{1,3}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function tzOffsetMs(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return (
    Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms
  );
}

/**
 * A GTFS stop time on a service date, as an ISO instant. The trains file has
 * always carried instants (Viaggiatreno's arrivo_teorico), and every reader —
 * the panel, lefrecce's romeClock, the SEO timetables via INSTANT_TIME_ZONES —
 * turns them back into an Italian clock, so the shape is kept.
 */
export function romeInstant(yyyymmdd, time, timeZone = TIME_ZONE) {
  const minutes = minutesOf(time);
  const d = String(yyyymmdd ?? "");
  if (minutes === null || !/^\d{8}$/.test(d)) return null;
  const guess = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), 0, minutes);
  let ms = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(ms, timeZone);
  if (second !== ms) ms = second;
  return new Date(ms).toISOString();
}

const overlapCount = (a, b) => {
  let n = 0;
  for (const d of a) if (b.has(d)) n += 1;
  return n;
};

// ─── Feed ───────────────────────────────────────────────────────────────────

/**
 * The tables an ICN build needs, streamed out of the zip: routes of the night
 * categories, their trips, stop times and shapes, plus stops and calendars.
 * shapes.txt is 80 MB for the whole network and ICN uses ~1% of it.
 */
export async function loadFeed(zipPath, { categories = DEFAULTS.categories, log = () => {} } = {}) {
  const wanted = new Set(categories);
  const routes = [];
  await streamZipCsv(zipPath, "routes.txt", (r) => {
    if (wanted.has(String(r.route_short_name).trim())) routes.push(r);
  });
  const routeIds = new Set(routes.map((r) => r.route_id));
  const trips = [];
  await streamZipCsv(zipPath, "trips.txt", (t) => {
    if (routeIds.has(t.route_id)) trips.push(t);
  });
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const stopTimes = [];
  await streamZipCsv(zipPath, "stop_times.txt", (st) => stopTimes.push(st), {
    keep: { column: "trip_id", test: (id) => tripIds.has(id) },
  });
  const stopsById = new Map();
  await streamZipCsv(zipPath, "stops.txt", (s) => stopsById.set(s.stop_id, s));
  const serviceIds = new Set(trips.map((t) => t.service_id));
  const calendar = [];
  await streamZipCsv(zipPath, "calendar.txt", (c) => calendar.push(c), {
    keep: { column: "service_id", test: (id) => serviceIds.has(id) },
  });
  const calendarDates = [];
  await streamZipCsv(zipPath, "calendar_dates.txt", (c) => calendarDates.push(c), {
    keep: { column: "service_id", test: (id) => serviceIds.has(id) },
  });
  const shapeIds = new Set(trips.map((t) => t.shape_id).filter(Boolean));
  const shapes = new Map();
  await streamZipCsv(
    zipPath,
    "shapes.txt",
    (p) => {
      if (!shapes.has(p.shape_id)) shapes.set(p.shape_id, []);
      shapes.get(p.shape_id).push([Number(p.shape_pt_sequence), Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
    },
    { keep: { column: "shape_id", test: (id) => shapeIds.has(id) } },
  );
  for (const pts of shapes.values()) pts.sort((a, b) => a[0] - b[0]);
  let feedInfo = null;
  await streamZipCsv(zipPath, "feed_info.txt", (f) => {
    feedInfo ??= f;
  });
  log(
    `feed ${feedInfo?.feed_version ?? "(no version)"}: ${routes.length} ${categories.join("/")} route(s), ${trips.length} trip(s), ${stopTimes.length} stop time(s), ${shapes.size} shape(s)`,
  );
  return { routes, trips, stopTimes, stopsById, calendar, calendarDates, shapes, feedInfo };
}

// ─── Trains ─────────────────────────────────────────────────────────────────

/**
 * Turn the ICN trips of a feed into the trains file's `trains` map (see the
 * header for the rules). Pure: the feed, the date and the config in, trains
 * out. `stats` collects what the log reports.
 */
export function buildTrenitaliaTrains({ feed, today, config = {}, log = () => {}, stats = null }) {
  const cfg = { ...DEFAULTS, ...config };
  const todayC = compactDate(today);
  const datesById = serviceDatesById(feed.calendar, feed.calendarDates);

  const stationOf = (stopId) => {
    const stop = feed.stopsById.get(stopId);
    if (!stop) return null;
    // A platform's parent is the station; the stop_id of the station itself is
    // Viaggiatreno's code without the S.
    const parent = stop.parent_station ? feed.stopsById.get(stop.parent_station) : null;
    const id = String(stopId).split(":")[0];
    const s = parent ?? stop;
    const lat = Number.parseFloat(s.stop_lat ?? stop.stop_lat);
    const lon = Number.parseFloat(s.stop_lon ?? stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const name = cfg.stationNames[id] ?? titleCase(String(stop.stop_name ?? s.stop_name ?? "").trim());
    return { id, name, lat, lon };
  };

  const stopTimesByTrip = new Map();
  for (const st of feed.stopTimes) {
    if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
    stopTimesByTrip.get(st.trip_id).push(st);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  // ── Runs, grouped into (number, first station, last station) units ──
  const units = new Map();
  const allDates = new Set();
  for (const t of feed.trips) {
    const number = String(t.trip_short_name ?? "").trim();
    if (!/^\d+$/.test(number)) continue;
    const dates = new Set([...(datesById.get(t.service_id) ?? [])].filter((d) => d >= todayC));
    if (!dates.size) continue;
    const stops = (stopTimesByTrip.get(t.trip_id) ?? [])
      .map((st) => {
        const station = stationOf(st.stop_id);
        return station
          ? { station: station.id, feed: station, arrival: st.arrival_time, departure: st.departure_time }
          : null;
      })
      .filter(Boolean);
    if (stops.length < 2) continue;
    for (const d of dates) allDates.add(d);
    const key = `${number}|${stops[0].station}|${stops[stops.length - 1].station}`;
    if (!units.has(key)) {
      units.set(key, {
        number,
        origin: stops[0].station,
        destination: stops[stops.length - 1].station,
        runs: [],
        nights: new Set(),
        clocks: new Map(),
      });
    }
    const u = units.get(key);
    u.runs.push({ tripId: t.trip_id, number, shapeId: t.shape_id || null, stops, dates });
    for (const d of dates) u.nights.add(d);
    const dep = minutesOf(stops[0].departure ?? stops[0].arrival);
    if (dep !== null) u.clocks.set(dep, (u.clocks.get(dep) ?? 0) + dates.size);
  }
  for (const u of units.values()) {
    u.clock = [...u.clocks.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
    u.variation = Number(u.number) >= cfg.variationNumberFrom;
  }

  const oneOffs = [];
  const candidates = [];
  for (const u of units.values()) {
    if (u.nights.size < cfg.minNights) oneOffs.push(`${u.number} (${u.nights.size} night${u.nights.size === 1 ? "" : "s"})`);
    else candidates.push(u);
  }

  // ── Fold stand-ins into the train they replace ──
  // Timetable numbers first, then the busiest: 1959 must claim 95063 before
  // 95063 (more nights before December) can become a train of its own.
  candidates.sort(
    (a, b) =>
      Number(a.variation) - Number(b.variation) ||
      b.nights.size - a.nights.size ||
      Number(a.number) - Number(b.number),
  );
  const primaries = [];
  const folded = [];
  for (const u of candidates) {
    const host = primaries
      .filter(
        (p) =>
          p.origin === u.origin &&
          p.destination === u.destination &&
          p.clock !== null &&
          u.clock !== null &&
          Math.abs(p.clock - u.clock) <= cfg.standInClockMinutes &&
          overlapCount(u.nights, p.nights) <= u.nights.size * cfg.standInMaxOverlap &&
          (u.variation || u.nights.size < p.nights.size),
      )
      .sort((a, b) => Math.abs(a.clock - u.clock) - Math.abs(b.clock - u.clock))[0];
    if (host) {
      host.runs.push(...u.runs);
      for (const d of u.nights) host.nights.add(d);
      host.standIns.push(u.number);
      folded.push(`${u.number} → ${host.number}`);
    } else {
      primaries.push({ ...u, runs: [...u.runs], nights: new Set(u.nights), standIns: [] });
    }
  }

  // ── The period described: the timetable running now ──
  const window = pickServiceWindow(today, allDates);
  const inWindow = (d) => d >= window.start && (!window.end || d < window.end);
  const notNow = [];
  const built = [];
  for (const p of primaries) {
    const runs = p.runs
      .map((r) => ({ ...r, dates: new Set([...r.dates].filter(inWindow)) }))
      .filter((r) => r.dates.size);
    if (!runs.length) {
      const first = [...p.nights].sort()[0];
      notNow.push(`${p.number} (from ${first})`);
      continue;
    }
    const rep = pickRepresentativeRun(runs);
    if (!rep) continue;
    const nights = new Set();
    for (const r of runs) for (const d of r.dates) nights.add(d);
    // The other numbers it runs under in this period (works numbers).
    const operatedAs = [...new Set(runs.map((r) => r.number))].filter((n) => n !== p.number).sort();
    built.push({ ...p, runs, rep, nights, operatedAs });
  }

  let horizonStart = null;
  let horizonEnd = null;
  for (const b of built) {
    for (const d of b.nights) {
      if (!horizonStart || d < horizonStart) horizonStart = d;
      if (!horizonEnd || d > horizonEnd) horizonEnd = d;
    }
  }

  // ── Labels: one train per number keeps the bare number ──
  // The busiest unit of a number is "ICN n"; another portion of it is named
  // by the city where it differs. On a tie the shorter portion keeps the bare
  // number (ICN 1955 Roma → Catania, as Viaggiatreno and the existing icn_
  // rows had it; Back-on-Track marks the Palermo portion the same way, "(P)").
  const byNumber = new Map();
  for (const b of built) {
    if (!byNumber.has(b.number)) byNumber.set(b.number, []);
    byNumber.get(b.number).push(b);
  }
  for (const list of byNumber.values()) {
    list.sort(
      (a, b) =>
        b.nights.size - a.nights.size ||
        a.rep.stops.length - b.rep.stops.length ||
        a.destination.localeCompare(b.destination),
    );
    const [main, ...others] = list;
    main.lineName = `ICN ${main.number}`;
    for (const o of others) {
      const end =
        o.destination !== main.destination
          ? o.rep.stops[o.rep.stops.length - 1].feed.name
          : o.rep.stops[0].feed.name;
      o.lineName = `ICN ${o.number} (${cityForStation(end) || end})`;
    }
  }

  // ── Trains ──
  const trains = {};
  const chordOnly = [];
  for (const b of built) {
    const firstNight = [...b.rep.dates].sort()[0];
    const stations = [];
    b.rep.stops.forEach((s, i) => {
      // A train calls at a station once; a repeat is a reversal in a station.
      if (stations.length && stations[stations.length - 1].code === `S${s.feed.id}`) return;
      stations.push({
        name: s.feed.name,
        code: `S${s.feed.id}`,
        location: { latitude: s.feed.lat, longitude: s.feed.lon },
        arrival: i === 0 ? null : romeInstant(firstNight, s.arrival),
        departure: i === b.rep.stops.length - 1 ? null : romeInstant(firstNight, s.departure),
      });
    });
    if (stations.length < 2) continue;

    const shape = b.rep.shapeId ? feed.shapes.get(b.rep.shapeId) : null;
    let points;
    if (shape?.length >= 2) {
      points = simplifyPath(
        shape.map(([, lat, lon]) => [lat, lon]),
        cfg.simplifyMeters,
      ).map(([lat, lon]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))]);
    } else {
      chordOnly.push(b.lineName);
      points = stations.map((s) => [s.location.latitude, s.location.longitude]);
    }

    trains[b.lineName] = {
      lineName: b.lineName,
      operator: "Trenitalia",
      frequency: renderServiceDays(b.nights, { horizonStart, horizonEnd }),
      polyline: polyline.encode(points),
      stations,
      feedTrip: b.rep.tripId,
      runsInWindow: b.nights.size,
      ...(b.operatedAs.length ? { operatedAs: b.operatedAs } : {}),
    };
  }

  const ordered = orderInPairs(trains);

  if (stats) {
    Object.assign(stats, { window, horizonStart, horizonEnd, oneOffs, folded, notNow, chordOnly });
  }
  if (folded.length) log(`folded ${folded.length} stand-in(s) into the train they replace: ${folded.join(", ")}`);
  if (oneOffs.length) log(`left out ${oneOffs.length} one-off run(s): ${oneOffs.join(", ")}`);
  if (notNow.length) log(`not running in ${window.start}–${window.end ?? "…"}: ${notNow.join(", ")}`);
  if (chordOnly.length) log(`WARNING: no shape for ${chordOnly.join(", ")} — drawn through the stations`);
  return ordered;
}

/**
 * The trains in pair order, each followed by its return. appendSyntheticRoutes
 * pairs a train with the first unpaired reverse train in file order, and Roma ↔
 * Palermo has two of each (the Napoli portion of 1955/1958 and the Lamezia
 * express 1959/1956), so the pairing is decided here, by the stops the two
 * directions share, and the file order carries it.
 */
export function orderInPairs(trains) {
  const numberOf = (k) => Number(k.match(/\d+/)?.[0] ?? 0);
  const entries = Object.entries(trains).sort(([a], [b]) => numberOf(a) - numberOf(b) || a.localeCompare(b));
  const ends = (t) => [t.stations[0].code, t.stations[t.stations.length - 1].code];
  const codes = (t) => new Set(t.stations.map((s) => s.code));
  const used = new Set();
  const out = {};
  for (const [key, train] of entries) {
    if (used.has(key)) continue;
    used.add(key);
    out[key] = train;
    const [o, d] = ends(train);
    const mine = codes(train);
    const partner = entries
      .filter(([k, t]) => !used.has(k) && ends(t)[0] === d && ends(t)[1] === o)
      .map(([k, t]) => {
        const theirs = codes(t);
        const shared = overlapCount(mine, theirs);
        return { k, t, score: shared / (mine.size + theirs.size - shared) };
      })
      .sort((a, b) => b.score - a.score)[0];
    if (partner) {
      used.add(partner.k);
      out[partner.k] = partner.t;
    }
  }
  return out;
}

// ─── Adapter entry point ────────────────────────────────────────────────────

async function fetchFeed(entry, destZip, log) {
  const params = entry.params ?? {};
  const urls = [params.feedUrl, ...(params.fallbackUrls ?? [])].filter(Boolean);
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  for (const url of urls) {
    try {
      log(`downloading ${url}`);
      await downloadFile(url, destZip);
      const size = fs.statSync(destZip).size;
      if (size < 1e6) throw new Error(`only ${size} bytes — not the national feed`);
      log(`downloaded ${(size / 1e6).toFixed(0)} MB`);
      return;
    } catch (err) {
      log(`download failed: ${err.message}`);
    }
  }
  throw new Error("every feed URL failed");
}

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = params.configPath
    ? readJsonSafe(path.join(ctx.rootDir, params.configPath)) ?? {}
    : {};

  // A zip already on disk (TRENITALIA_GTFS_ZIP) skips the download.
  const manualZip = process.env.TRENITALIA_GTFS_ZIP;
  let zipPath;
  if (manualZip) {
    zipPath = path.resolve(ctx.rootDir, manualZip);
    log(`reading ${zipPath}`);
  } else {
    zipPath = path.join(ctx.rootDir, "gtfs-data", `${entry.id}.zip`);
    await fetchFeed(entry, zipPath, log);
  }

  const feed = await loadFeed(zipPath, { categories: config.categories ?? DEFAULTS.categories, log });
  const stats = {};
  const trains = buildTrenitaliaTrains({ feed, today: ctx.today, config, log, stats });
  const count = Object.keys(trains).length;
  if (!count) throw new Error(`${entry.id}: no Intercity Notte train found in the feed`);
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const z = t.stations[t.stations.length - 1];
    log(
      `${t.lineName}: ${a.name} → ${z.name}, ${t.stations.length} stops, ${t.frequency}` +
        (t.operatedAs ? ` (runs as ${t.operatedAs.join("/")} on some nights)` : ""),
    );
  }

  // Last night's file: the fare calendar is built up across runs.
  let previous = null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(ctx.rootDir, "public", "data", "scraped", entry.output), "utf8"),
    );
    previous = raw?.data?.trains ?? raw?.trains ?? null;
  } catch {
    /* first run, or unreadable: nothing to build on */
  }
  // A calendar describes one journey: when a key now names another one (ICN
  // 1964 was Viaggiatreno's seats-only Palermo–Messina portion and is the
  // through train to Milano here), its nights start over.
  const ends = (t) => `${t?.stations?.[0]?.code}>${t?.stations?.[t.stations.length - 1]?.code}`;
  if (previous) {
    previous = Object.fromEntries(
      Object.entries(previous).filter(([key, t]) => trains[key] && ends(t) === ends(trains[key])),
    );
  }
  const fareStats = await fillFareCalendars(trains, previous, {
    today: ctx.today,
    fetchImpl: ctx.fetch ?? fetch,
    days: params.fareCalendarDays ?? FARE_CALENDAR_DAYS,
    budget: params.fareSearchesPerRun ?? FARE_CALENDAR_BUDGET,
  });
  log(
    `${fareStats.searched}/${fareStats.planned} fare search(es) tonight ` +
      `(${fareStats.priced} priced, ${fareStats.none} without a berth, ${fareStats.noTrain} with no direct train, ` +
      `${fareStats.errors} failed${fareStats.stopped ? ", stopped early" : ""}); ` +
      `fares for ${Object.values(trains).filter((t) => t.fare).length}/${count} trains`,
  );

  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    feedVersion: feed.feedInfo?.feed_version ?? null,
    window: stats.window,
    trains,
  });
  log(`stored ${count} Intercity Notte trains for ${stats.window.start}–${stats.window.end ?? "…"}`);
  if (!manualZip) fs.rmSync(zipPath, { force: true });
}
