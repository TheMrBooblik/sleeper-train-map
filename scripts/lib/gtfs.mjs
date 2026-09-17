// scripts/lib/gtfs.mjs
// Generic GTFS → trains-dict builder, shared by the registry's `gtfs-sleeper`
// adapter (Amtrak, VIA Rail). Operator GTFS feeds carry everything we need —
// stop coordinates, route shapes and service calendars — so a North American
// sleeper route becomes a synthetic map route with no manual coordinate entry.
//
// The heavy work is split so it stays testable offline:
//   - downloadGtfs(url, destDir)  → network (used by the adapter only)
//   - loadGtfsDir(dir)            → parses the .txt tables into memory (pure)
//   - buildSleeperTrains({...})   → filters to an allowlist, builds the trains
//                                   dict in the standard shape (pure)
//
// CSV parsing / download / unzip mirror scripts/parse-pkp-gtfs.js; the service
// calendar is rendered with the canonical parser in src/pages/api/lib/calendar.mjs.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execSync } from "node:child_process";
import polyline from "@mapbox/polyline";
import {
  DAY_KEYS,
  parseGtfsCalendar,
  renderCalendar,
} from "../../src/pages/api/lib/calendar.mjs";

// DAY_KEYS is Monday-first ("mon"…"sun"); JS Date.getDay() is Sunday-first.
const DAY_KEY_TO_JS_DAY = [1, 2, 3, 4, 5, 6, 0];

// ─── CSV / download / unzip (mirrors parse-pkp-gtfs.js) ──────────────────────

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

export function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    const out = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? "";
    });
    return out;
  });
}

/**
 * Per-host request headers, for a feed whose publisher asks for something
 * beyond a bare GET. Keyed by hostname so every other feed is fetched exactly
 * as before — several of them work today and none of them should be risked for
 * one that does not.
 *
 * Digitraffic's terms ask clients to identify themselves in a Digitraffic-User
 * header, so we send one. Worth being clear that this does NOT fix the 406 that
 * rata.digitraffic.fi answers with: the probe was run with these exact headers
 * on 2026-09-12 and got 406 again, which also rules out content negotiation,
 * since no server honouring a wildcard Accept can refuse it. The status is a
 * generic rejection and the URL in official-sources.json is the suspect. The
 * header stays because it is the courteous way to ask that host for anything,
 * not because it is a fix.
 */
const HOST_HEADERS = {
  "rata.digitraffic.fi": {
    "Digitraffic-User": "pingwi.com/sleeper-train-map",
    Accept: "application/zip, application/octet-stream, */*",
  },
};

export function headersFor(url, extra) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // A malformed URL is the caller's problem, not this function's: fall
    // through and let the client report it.
  }
  return { ...(HOST_HEADERS[host] ?? {}), ...(extra ?? {}) };
}

// A download with no timeout has no bound at all: against a host that drops
// packets rather than refusing them — data.gov.ro does exactly that from GitHub
// runners — https.get waits for the OS to give up on the TCP connection, which
// is minutes. Four adapters sit on this path (amtrak, viarail, europeansleeper,
// cfr) plus the CFR probe, so one such host could stall the whole nightly run.
// setTimeout fires on socket inactivity, which bounds a connect that never
// completes AND a transfer that stalls mid-stream.
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * @param {string} url
 * @param {string} destPath
 * @param {{headers?: object, timeoutMs?: number, redirectsLeft?: number}} [options]
 */
export function downloadFile(url, destPath, options = {}) {
  const { headers: extraHeaders = null } = options;
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const redirectsLeft = options.redirectsLeft ?? MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    // Every failure path closes the stream and removes the partial file: a
    // non-200 used to leave a 0-byte artifact behind that a later read would
    // treat as data, and leak the descriptor with it.
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.destroy();
      fs.unlink(destPath, () => reject(err));
    };

    // Pick the client by scheme: the function takes a URL, so an http:// one
    // (a redirect target, or a local server in the tests) must not be sent as
    // an https request.
    const client = new URL(url).protocol === "http:" ? http : https;
    const headers = headersFor(url, extraHeaders);
    const request = client.get(url, Object.keys(headers).length ? { headers } : {}, (res) => {
      const status = res.statusCode;
      if (status === 301 || status === 302 || status === 307 || status === 308) {
        const location = res.headers.location;
        res.resume();
        if (!location) return fail(new Error("Redirect without location"));
        // The recursion used to be uncapped, and it opened a second write
        // stream on the same path while the first was still open.
        if (redirectsLeft <= 0) return fail(new Error(`Too many redirects: ${url}`));
        file.destroy();
        settled = true;
        // Resolve against the current URL so a relative Location works, and
        // carry the caller's headers across the hop — headersFor re-resolves
        // the per-host ones for whatever host we land on.
        downloadFile(new URL(location, url).toString(), destPath, {
          headers: extraHeaders,
          timeoutMs,
          redirectsLeft: redirectsLeft - 1,
        }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${status}`));
      }
      res.on("error", fail);
      file.on("error", fail);
      file.on("finish", () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve());
      });
      res.pipe(file);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        Object.assign(new Error(`download timed out after ${timeoutMs}ms: ${url}`), {
          code: "ETIMEDOUT",
        }),
      );
    });
    request.on("error", fail);
  });
}

// Download + unzip a GTFS feed into destDir (returns destDir). Requires `unzip`
// on PATH, exactly like the PKP/RegioJet parsers.
export async function downloadGtfs(url, destDir, options = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, "feed.zip");
  await downloadFile(url, zipPath, options);
  execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  return destDir;
}

// ─── Parse a GTFS directory into in-memory tables ────────────────────────────

// Above this, shapes.txt is skipped rather than parsed (see loadGtfsDir). Set
// clear of every feed we read today — Amtrak's is the largest at 17 MB — and
// well under the 416 MB that OOMs a default Node heap.
export const MAX_SHAPES_BYTES = 200e6;

const toNum = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the GTFS .txt tables we need into lookup structures.
 * @param {string} dir directory containing the unzipped feed
 */
export function loadGtfsDir(dir, { maxShapesBytes = MAX_SHAPES_BYTES } = {}) {
  const routesById = new Map();
  for (const r of readCsv(path.join(dir, "routes.txt"))) {
    if (r.route_id) routesById.set(r.route_id, r);
  }

  const stopsById = new Map();
  for (const s of readCsv(path.join(dir, "stops.txt"))) {
    if (s.stop_id) {
      stopsById.set(s.stop_id, {
        name: (s.stop_name || s.stop_id).trim(),
        lat: toNum(s.stop_lat),
        lon: toNum(s.stop_lon),
        parent: s.parent_station || "",
      });
    }
  }

  // shape_id → [{ seq, lat, lon }] (sorted by sequence)
  //
  // Geometry is the one optional part of a feed, and the heaviest by far: Entur
  // ships 416 MB of shapes for Vy alone against 7.6 MB of stop_times, and 2.6 GB
  // for the national aggregate. readCsv reads a whole file into one string and
  // then splits it, so a file that size is several GB of heap before a single
  // point is stored — which is precisely how the first Entur probe died. Skip it
  // past a ceiling instead: buildSleeperTrains already falls back to the station
  // chain per trip when a shape is missing, which is what SNCF runs on anyway.
  const shapesPath = path.join(dir, "shapes.txt");
  const shapesBytes = fs.existsSync(shapesPath) ? fs.statSync(shapesPath).size : 0;
  const shapesSkipped = shapesBytes > maxShapesBytes;
  const shapePoints = new Map();
  for (const row of shapesSkipped ? [] : readCsv(shapesPath)) {
    const id = row.shape_id;
    if (!id) continue;
    const lat = toNum(row.shape_pt_lat);
    const lon = toNum(row.shape_pt_lon);
    if (lat === null || lon === null) continue;
    if (!shapePoints.has(id)) shapePoints.set(id, []);
    shapePoints.get(id).push({
      seq: Number.parseInt(row.shape_pt_sequence || "0", 10),
      lat,
      lon,
    });
  }
  for (const pts of shapePoints.values()) pts.sort((a, b) => a.seq - b.seq);

  const trips = readCsv(path.join(dir, "trips.txt"));

  // trip_id → [{ seq, stop_id, arrival, departure }] (sorted by sequence)
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const stopTimesByTrip = new Map();
  for (const row of readCsv(path.join(dir, "stop_times.txt"))) {
    if (!tripIds.has(row.trip_id)) continue;
    if (!stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.set(row.trip_id, []);
    stopTimesByTrip.get(row.trip_id).push({
      seq: Number.parseInt(row.stop_sequence || "0", 10),
      stop_id: row.stop_id,
      arrival: row.arrival_time,
      departure: row.departure_time,
    });
  }
  for (const sts of stopTimesByTrip.values()) sts.sort((a, b) => a.seq - b.seq);

  // service_id → calendar.txt row (weekly pattern + date window)
  const calendarById = new Map();
  for (const row of readCsv(path.join(dir, "calendar.txt"))) {
    if (row.service_id) calendarById.set(row.service_id, row);
  }

  // service_id → ["YYYYMMDD"] of added dates (exception_type 1), for feeds that
  // ship only calendar_dates.txt.
  const addedDatesByService = new Map();
  for (const row of readCsv(path.join(dir, "calendar_dates.txt"))) {
    if (row.exception_type !== "1") continue;
    if (!addedDatesByService.has(row.service_id)) {
      addedDatesByService.set(row.service_id, []);
    }
    addedDatesByService.get(row.service_id).push(row.date);
  }

  return {
    routesById,
    stopsById,
    shapePoints,
    trips,
    stopTimesByTrip,
    calendarById,
    addedDatesByService,
    // So a caller can say so rather than leaving "no geometry" to be mistaken
    // for a feed that never had any.
    shapesSkipped,
    shapesBytes,
  };
}

// ─── Timetable periods ───────────────────────────────────────────────────────
//
// A date-expanded feed publishes a whole year, and a train is free to change
// its operating days at the European timetable change — the second Sunday in
// December. So "which weekdays does this train run" is only answerable inside
// one period: ask it of the whole file and a service that runs Fri-Sun in
// winter and daily in July answers "Daily", which is true of no week of the
// year. The European Sleeper adapter met this first (ES 400 advertised four
// weekdays for a 3x/week train); these helpers are that lesson, shared.

/** Second Sunday in December of `year`, as "YYYYMMDD". */
export function decemberTimetableChange(year) {
  const dec1 = new Date(Date.UTC(year, 11, 1));
  const firstSunday = 1 + ((7 - dec1.getUTCDay()) % 7);
  return `${year}12${String(firstSunday + 7).padStart(2, "0")}`;
}

/** The next timetable change strictly after "YYYYMMDD", or null if none is near. */
export function nextTimetableChangeAfter(yyyymmdd) {
  const year = Number(String(yyyymmdd).slice(0, 4));
  for (const y of [year, year + 1]) {
    const change = decemberTimetableChange(y);
    if (change > yyyymmdd) return change;
  }
  return null;
}

/** "YYYYMMDD" for today, UTC. */
export function todayCompact(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * The timetable period running now: [start, end) as compact dates, end
 * exclusive and null when no change is near.
 */
export function currentTimetableWindow(now = new Date()) {
  const start = todayCompact(now);
  return { start, end: nextTimetableChangeAfter(start) };
}

/**
 * Does a calendar.txt row's validity span intersect the window? A row with no
 * readable span is kept — the window is there to exclude what it can prove is
 * elsewhere in the year, not to drop a service for being undated.
 */
function calendarOverlapsWindow(calRow, window) {
  if (!window) return true;
  const span = (v) => (/^\d{8}$/.test(String(v ?? "")) ? String(v) : null);
  const from = span(calRow.start_date);
  const until = span(calRow.end_date);
  if (window.end && from && from >= window.end) return false;
  if (window.start && until && until < window.start) return false;
  return true;
}

/** Is a compact date inside [start, end)? A null bound does not constrain. */
function withinWindow(date, window) {
  if (!window) return true;
  if (window.start && date < window.start) return false;
  if (window.end && date >= window.end) return false;
  return true;
}

// ─── Service calendar → display string ───────────────────────────────────────

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Summarise calendar_dates-only services into a "Daily"/"Mon, Wed, Fri" string,
// mirroring parse-pkp-gtfs's summariseCalendar (the canonical renderer in
// calendar.mjs handles calendar.txt feeds).
function summariseAddedDates(dates) {
  if (!dates || dates.length === 0) return null;
  const sorted = [...dates].sort();
  const weekdays = new Set();
  for (const d of sorted) {
    const dt = new Date(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
    );
    weekdays.add(dt.getDay());
  }
  if (weekdays.size === 7) return "Daily";
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order
    .filter((d) => weekdays.has(d))
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}

/**
 * "When does it run" for a train spread across MANY trips.
 *
 * A date-expanded feed gives every operating date its own trip and its own
 * service_id, so one trip's service answers "when does this particular run
 * go", not "when does this train run". SNCF's export is such a feed, and the
 * single-trip answer was visibly incoherent: IC Nuit 3740 came out "Mon, Tue,
 * Wed, Thu, Fri" while IC Nuit 3731 — the other direction of the same service —
 * came out "Sun". Both cannot be the train's timetable.
 *
 * So union every trip that matched the entry: calendar.txt weekdays where the
 * feed has them, plus the weekdays of every added date.
 *
 * But union WITHIN ONE TIMETABLE PERIOD, which is the half this first shipped
 * without. A year-wide union answers "which weekdays does this train ever run
 * on", and for a seasonal service that is every weekday: the first live SNCF
 * run returned "Daily" for Paris-Latour-de-Carol and Paris-Cerbere, both of
 * which Back-on-Track has as weekend services, and 13 of 18 trains came out
 * Daily. Saturating at the value that means "no restriction" is the worst
 * possible failure here, because it is indistinguishable from a train that
 * genuinely runs daily — and eight of these genuinely do.
 *
 * The union is only as honest as the trips that feed it, which is why
 * resolveNamedTrips keeps its overnight filter: a day train sharing the
 * corridor must not lend its weekdays to the night train.
 *
 * @param {{start?: string, end?: string}|null} window compact dates, end
 *        exclusive; null unions across everything the feed carries.
 */
function serviceDisplayForServices(serviceIds, gtfs, window = null) {
  const ids = [...serviceIds].filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length === 1 && !window) return serviceDisplay(ids[0], gtfs);

  // Collect weekdays as JS day numbers (0 = Sunday), from both shapes a feed
  // can express a service in: calendar.txt weekday flags, and the dates in
  // calendar_dates.txt that a date-expanded feed uses instead.
  const weekdays = new Set();
  let sawAny = false;
  for (const id of ids) {
    const calRow = gtfs.calendarById.get(id);
    // A calendar.txt service states its own validity span, so it counts only
    // where that span overlaps the window — a summer-only service must not
    // lend its weekdays to a winter timetable.
    if (calRow && calendarOverlapsWindow(calRow, window)) {
      for (const day of parseGtfsCalendar(calRow).daysOfWeek ?? []) {
        const i = DAY_KEYS.indexOf(day);
        if (i !== -1) {
          weekdays.add(DAY_KEY_TO_JS_DAY[i]);
          sawAny = true;
        }
      }
    }
    for (const d of gtfs.addedDatesByService.get(id) ?? []) {
      if (!withinWindow(d, window)) continue;
      const dt = new Date(
        Number(d.slice(0, 4)),
        Number(d.slice(4, 6)) - 1,
        Number(d.slice(6, 8)),
      );
      if (Number.isFinite(dt.getTime())) {
        weekdays.add(dt.getDay());
        sawAny = true;
      }
    }
  }
  if (!sawAny) return null;
  if (weekdays.size === 7) return "Daily";
  // Monday first, the order the rest of the payload reads in.
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => weekdays.has(d))
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}

/**
 * "When does it run" for a service that only runs part of the year.
 *
 * `serviceDisplayForServices` answers within a window, so a train whose season
 * has already closed gets `null` — true, and useless: the row then keeps
 * Back-on-Track's "2026: Daily" and the map advertises a train that stopped
 * running in September. Thirteen of Romania's forty-two night trains are summer
 * Black Sea services, and two of them are rows we publish.
 *
 * So when a service's own dates cover only part of a year, say so in the shape
 * the rest of the payload already reads: "2026/06/13-2026/09/06: Daily", which
 * `parseBoTServiceIdDateRange` parses to hide the line once the season closes
 * and `parseBotServiceString` parses back into a calendar. Note that is the
 * *trips* spelling, with a year on both sides — `renderCalendar` emits a
 * shorter "2026/06/13-09/06" that only calendar.mjs understands, and picking
 * the form the map can act on is the whole point.
 *
 * Returns null when the service is not seasonal (so the caller keeps the plain
 * windowed answer) or when its span crosses a year boundary, which this shape
 * cannot express and which a year-round timetable looks like anyway.
 */
/** "YYYYMMDD" as a local Date at midnight. */
function asLocalDate(d) {
  return new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
}

export function seasonalServiceDisplay(serviceIds, gtfs, { maxSeasonDays = 300 } = {}) {
  const spanDates = [];
  const weekdays = new Set();
  let sawWeekday = false;

  for (const id of [...serviceIds].filter(Boolean)) {
    for (const d of gtfs.addedDatesByService.get(id) ?? []) {
      if (!/^\d{8}$/.test(String(d))) continue;
      spanDates.push(String(d));
      weekdays.add(asLocalDate(String(d)).getDay());
      sawWeekday = true;
    }
    const cal = gtfs.calendarById.get(id);
    if (!cal) continue;
    // The span comes from the row's own validity, but the DAYS come from its
    // weekday flags. Taking them from the two endpoint dates instead reports a
    // daily summer service as "Fri, Sat" — whichever weekdays the season
    // happens to start and finish on.
    if (cal.start_date && cal.end_date) {
      spanDates.push(String(cal.start_date), String(cal.end_date));
    }
    for (const day of parseGtfsCalendar(cal).daysOfWeek ?? []) {
      const i = DAY_KEYS.indexOf(day);
      if (i !== -1) {
        weekdays.add(DAY_KEY_TO_JS_DAY[i]);
        sawWeekday = true;
      }
    }
  }

  if (spanDates.length < 2 || !sawWeekday) return null;
  spanDates.sort();
  const first = spanDates[0];
  const last = spanDates[spanDates.length - 1];
  if (first.slice(0, 4) !== last.slice(0, 4)) return null;

  const spanDays =
    Math.round((asLocalDate(last) - asLocalDate(first)) / 86400000) + 1;
  if (spanDays > maxSeasonDays) return null;

  const days =
    weekdays.size === 7
      ? "Daily"
      : [1, 2, 3, 4, 5, 6, 0]
          .filter((d) => weekdays.has(d))
          .map((d) => WEEKDAY_SHORT[d])
          .join(", ");
  if (!days) return null;
  const slash = (d) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
  return `${slash(first)}-${slash(last)}: ${days}`;
}

/**
 * The service string a route-named entry writes onto its row: the season when
 * there is one, else the plain weekday list under the year it belongs to.
 *
 * The year matters as much as the days. Back-on-Track writes "2026: Daily" and
 * the row is read by `parseBotServiceString`, which turns a bare "Daily" into a
 * calendar with no validity at all — so dropping the prefix trades a real loss
 * on every year-round train for a fix on the seasonal few.
 */
export function seasonalOrYearlyDisplay(serviceIds, gtfs, serviceWindow = null) {
  const seasonal = seasonalServiceDisplay(serviceIds, gtfs);
  if (seasonal) return seasonal;
  const plain = serviceDisplayForServices(serviceIds, gtfs, serviceWindow);
  if (!plain) return null;
  // serviceDisplay() can already render a prefixed string for a calendar.txt
  // feed; never stack a second year on it.
  if (/^\d{4}\s*[:/]/.test(plain)) return plain;
  const year = String(serviceWindow?.start ?? todayCompact()).slice(0, 4);
  return /^\d{4}$/.test(year) ? `${year}: ${plain}` : plain;
}

// Resolve a trip's service to a human "when does it run" string.
function serviceDisplay(serviceId, gtfs) {
  const calRow = gtfs.calendarById.get(serviceId);
  if (calRow) {
    const rendered = renderCalendar(parseGtfsCalendar(calRow));
    if (rendered) return rendered;
  }
  return summariseAddedDates(gtfs.addedDatesByService.get(serviceId));
}

// ─── Build the trains dict ───────────────────────────────────────────────────

const fmtTime = (t) => {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length < 2) return null;
  let h = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(h)) return null;
  h %= 24; // GTFS uses 24:00+ for after-midnight
  return `${String(h).padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
};

// Normalise a route name / station for matching: fold accents (Montréal →
// montreal), lowercase, collapse punctuation to single spaces. Accent-folding
// matters for bilingual feeds like VIA Rail.
function normLabel(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ─── Station-name canonicalisation at emit time ─────────────────────────────
// A via station only becomes a map dot when a coordinate-bearing stop of that
// exact name exists, so a feed's spelling has to be reconciled with the rest of
// the payload before it is written — not on read, where every consumer would
// need the same rule.
//
// Two registry params, composed in this order because they answer different
// problems. `stripStationSuffixes` removes a word the feed appends to every
// name: Entur writes "Drammen stasjon" where every other source in the dataset
// (Back-on-Track included) writes "Drammen". `canonicalizeStationNames` then
// puts what is left through the shared alias table, for the irregular cases a
// rule cannot reach ("Oslo lufthavn" → "Oslo Airport Gardermoen"). The other
// order needs an alias entry per station — 86 lines of mechanical JSON for
// Norway alone, and another set for every Nordic feed added after it.
//
// The strip is only safe because it cannot collide: no station in the
// Back-on-Track table is named "… stasjon", so there is no correct name for it
// to destroy. Both params stay opt-in per source for exactly that reason — the
// next feed's suffix has to earn the same check before it is added here.
//
// `resolveAlias` is injected rather than imported so this module keeps having
// no dependency on src/; the two call sites (the adapter and probe-gtfs) share
// this factory so the probe cannot report names the scrape would not write.

export function stripStationSuffixes(name, suffixes) {
  let out = String(name ?? "").trim();
  for (const suffix of suffixes) {
    const tail = String(suffix ?? "").trim();
    if (!tail) continue;
    if (out.length <= tail.length) continue;
    const candidate = out.slice(0, out.length - tail.length);
    if (out.slice(-tail.length).toLowerCase() !== tail.toLowerCase()) continue;
    // Only at a word boundary, and never down to nothing: a station really
    // called "Stasjon" keeps its name.
    if (!/\s$/.test(candidate)) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    out = trimmed;
  }
  return out;
}

export function stationNameCanonicalizer(params, resolveAlias) {
  const suffixes = Array.isArray(params?.stripStationSuffixes)
    ? params.stripStationSuffixes.filter((s) => String(s ?? "").trim())
    : [];
  const alias = params?.canonicalizeStationNames ? resolveAlias : null;
  if (!suffixes.length && !alias) return null;
  return (name) => {
    const stripped = suffixes.length ? stripStationSuffixes(name, suffixes) : name;
    return alias ? alias(stripped) : stripped;
  };
}

// Does a route endpoint (already normalised) start with an allowlist city?
// Token-aware so "toronto union station" matches "toronto" but "new york"
// never matches "york".
function endpointMatchesCity(endpointNorm, cityNorm) {
  if (!cityNorm || !endpointNorm) return false;
  return endpointNorm === cityNorm || endpointNorm.startsWith(`${cityNorm} `);
}

// Order-independent endpoint-pair match: keep a route when its two termini are
// the allowlisted city pair in either direction.
function pairMatches(originNorm, destNorm, from, to) {
  const f = normLabel(from);
  const t = normLabel(to);
  return (
    (endpointMatchesCity(originNorm, f) && endpointMatchesCity(destNorm, t)) ||
    (endpointMatchesCity(originNorm, t) && endpointMatchesCity(destNorm, f))
  );
}

// One direction only, for the named entries below: from must be the first
// terminus and to the last, never the other way round. Both sides arrive
// already normalised — this runs once per trip per entry, and normalising the
// entry inside it would re-fold the same two strings 39 000 times.
function orientedMatch(originNorm, destNorm, fromNorm, toNorm) {
  return (
    endpointMatchesCity(originNorm, fromNorm) &&
    endpointMatchesCity(destNorm, toNorm)
  );
}

/**
 * Resolve each named pair entry to the one trip it describes, scanning every
 * trip in the feed rather than one representative per route.
 *
 * Both halves of that matter for a feed like SNCF's. Its route_long_name is
 * "-" for six of the eleven Intercites de Nuit and files two of the named ones
 * under another train's corridor, so the route is not a usable address; and a
 * single route_id there carries both directions plus the portions that split
 * at Toulouse, so "the fullest trip on this route" answers a question nobody
 * asked. An oriented endpoint pair addresses exactly one train, and the entry
 * carries the operator's own label for it so the trains dict comes out keyed
 * the way the enrichment will look it up.
 *
 * Endpoints are read from the first and last located stop, which is two map
 * lookups per trip — the full station list is only built for the winner.
 */
function resolveNamedTrips(namedEntries, gtfs) {
  // name → { trip, stopCount, serviceIds }. The fullest trip supplies the stop
  // list and the times; EVERY matching trip supplies a service, because on a
  // date-expanded feed one trip's service_id is one operating date.
  const best = new Map();
  const wanted = namedEntries.map((e) => ({
    name: e.name,
    fromNorm: normLabel(e.from),
    toNorm: normLabel(e.to),
  }));
  for (const trip of gtfs.trips) {
    const sts = gtfs.stopTimesByTrip.get(trip.trip_id);
    if (!sts || sts.length < 2) continue;
    // An allowlist of sleepers has no use for a day train, and taking one is
    // worse than taking nothing: SNCF's fullest Paris Austerlitz → Toulouse
    // Matabiau trip is the 08:27 Intercités via Limoges, which would have
    // overwritten the night train's Montauban routing with a different
    // corridor under the night train's own number.
    if (!crossesMidnight(sts)) continue;
    const first = firstLocatedStop(sts, gtfs, 1);
    const last = firstLocatedStop(sts, gtfs, -1);
    if (!first || !last || first === last) continue;
    const originNorm = normLabel(first);
    const destNorm = normLabel(last);
    for (const e of wanted) {
      if (!orientedMatch(originNorm, destNorm, e.fromNorm, e.toNorm)) continue;
      const prev = best.get(e.name);
      if (!prev) {
        best.set(e.name, {
          trip,
          stopCount: sts.length,
          serviceIds: new Set([trip.service_id]),
          // What the union actually swept up. An entry matches on endpoints
          // plus "runs past midnight" and nothing else, so if a corridor
          // carries more than one overnight train they all land here and lend
          // it their days — which is the first thing to check when a train
          // comes out running more often than it does.
          tripCount: 1,
          shortNames: new Set([trip.trip_short_name].filter(Boolean)),
        });
        continue;
      }
      prev.serviceIds.add(trip.service_id);
      prev.tripCount += 1;
      if (trip.trip_short_name) prev.shortNames.add(trip.trip_short_name);
      if (sts.length > prev.stopCount) {
        prev.trip = trip;
        prev.stopCount = sts.length;
      }
    }
  }
  return best;
}

/** "25:10:00" → 90600. GTFS writes a past-midnight time as hours ≥ 24. */
function timeToSeconds(hhmmss) {
  const parts = String(hhmmss ?? "").trim().split(":");
  if (parts.length < 2) return null;
  const [h, m, sec] = parts.map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 3600 + m * 60 + (Number.isFinite(sec) ? sec : 0);
}

/**
 * Does this trip still be running after midnight? Two ways a feed can say so:
 * the hours-≥-24 notation GTFS specifies, and — for a feed that resets at
 * midnight instead — an arrival earlier in the day than the departure.
 */
function crossesMidnight(sts) {
  const dep = timeToSeconds(sts[0]?.departure ?? sts[0]?.arrival);
  const lastSt = sts[sts.length - 1];
  const arr = timeToSeconds(lastSt?.arrival ?? lastSt?.departure);
  if (dep === null || arr === null) return false;
  return arr >= 24 * 3600 || arr < dep;
}

// The first (dir 1) or last (dir -1) stop of a trip that has coordinates.
function firstLocatedStop(sts, gtfs, dir) {
  const order = dir === -1 ? [...sts].reverse() : sts;
  for (const st of order) {
    const stop = gtfs.stopsById.get(st.stop_id);
    if (stop && stop.lat !== null && stop.lon !== null) return stop.name;
  }
  return null;
}

// Pick the representative trip for a route: the one serving the most located
// stations (full corridor), so seasonal/partial runs don't truncate it.
function representativeTrip(trips, gtfs) {
  let best = null;
  let bestStations = [];
  for (const t of trips) {
    const stations = stationsForTrip(t.trip_id, gtfs);
    if (stations.length > bestStations.length) {
      best = t;
      bestStations = stations;
    }
  }
  return { trip: best, stations: bestStations };
}

// Build the ordered station list for a trip from its stop_times.
function stationsForTrip(tripId, gtfs) {
  const sts = gtfs.stopTimesByTrip.get(tripId) || [];
  const stations = [];
  const seen = new Set();
  for (const st of sts) {
    const stop = gtfs.stopsById.get(st.stop_id);
    if (!stop || stop.lat === null || stop.lon === null) continue;
    if (seen.has(stop.name)) continue;
    seen.add(stop.name);
    stations.push({
      name: stop.name,
      // GTFS stop_id is the operator station code (Amtrak: CHI, VIA: MTL).
      code: st.stop_id,
      location: { latitude: stop.lat, longitude: stop.lon },
      arrival: fmtTime(st.arrival),
      departure: fmtTime(st.departure),
      pickup: true,
      dropoff: true,
    });
  }
  return stations;
}

// ─── Through-car stitching ──────────────────────────────────────────────────
// A Back-on-Track row can name two feed trains: "IRN 472/IRN 1743" is ONE
// journey (Bucuresti -> Oradea) that the operator timetables under two numbers,
// and the feed carries each leg as its own route. Concatenating them is wrong,
// because leg one runs PAST the junction — 472 carries on to the Hungarian
// border — so the drawn line would reach Curtici, jump back to Arad and set off
// again. The legs are therefore joined at the last station they share, and each
// leg's geometry is cut at that station too.

/** Index of the position closest to a lat/lon, longitudes scaled by latitude. */
function nearestPointIndex(positions, lat, lon) {
  let best = -1;
  let bestD = Infinity;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < positions.length; i++) {
    const dLat = positions[i][0] - lat;
    const dLon = (positions[i][1] - lon) * scale;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Join consecutive legs of one journey at the last station they share.
 *
 * The junction keeps leg one's arrival and leg two's departure, because that is
 * what a through car does there: 472 reaches Arad at 02:17 and the portion does
 * not leave again until 1743 does, at 06:07. Taking leg one's departure would
 * state a wait that never happens.
 *
 * Returns null when a consecutive pair shares no station — the caller then
 * keeps the legs apart rather than drawing a line through a junction that is
 * not one.
 *
 * @param {Array<{stations: Array, positions: Array}>} legs in journey order
 */
export function stitchLegs(legs) {
  if (!legs?.length) return null;
  let stations = legs[0].stations;
  let positions = legs[0].positions;
  for (let n = 1; n < legs.length; n++) {
    const next = legs[n];
    const nextNorms = next.stations.map((st) => normLabel(st.name));
    // Latest junction in what we have so far: a through car rejoins once, and
    // taking the earliest shared name would drop every stop in between.
    let cut = -1;
    let nextCut = -1;
    for (let i = stations.length - 1; i >= 0 && cut < 0; i--) {
      const k = nextNorms.indexOf(normLabel(stations[i].name));
      if (k >= 0) {
        cut = i;
        nextCut = k;
      }
    }
    if (cut < 0) return null;
    const junction = {
      ...stations[cut],
      departure: next.stations[nextCut]?.departure ?? stations[cut].departure,
    };
    const { latitude, longitude } = junction.location;
    const head =
      positions.length >= 2
        ? positions.slice(0, nearestPointIndex(positions, latitude, longitude) + 1)
        : positions;
    const tail =
      next.positions.length >= 2
        ? next.positions.slice(nearestPointIndex(next.positions, latitude, longitude))
        : next.positions;
    stations = [
      ...stations.slice(0, cut),
      junction,
      ...next.stations.slice(nextCut + 1),
    ];
    positions = [...head, ...tail];
  }
  return { stations, positions };
}

/**
 * Build the standard trains dict for the allowlisted routes of one feed.
 *
 * Allowlist entries can take any of three forms (mix freely):
 *   - a string            → matched against route_long_name / route_short_name
 *                           / route_id, accent/space/punctuation-insensitive.
 *                           Good for Amtrak, whose route_long_name is the
 *                           service name.
 *   - { from, to }        → matched against the route's two terminal stations,
 *                           in either direction and accent-folded. Robust for
 *                           feeds that name routes by city pair (VIA Rail:
 *                           "Montréal - Halifax"), where exact-name matching is
 *                           brittle.
 *   - { from, to, name }  → the same pair, but oriented (from must be the
 *                           origin) and keyed by `name` instead of the route's.
 *                           For a feed whose routes are not addresses: SNCF
 *                           calls six of its eleven night trains "-", files
 *                           two of the named ones under another corridor, and
 *                           runs both directions plus the split portions under
 *                           one route_id. Naming the entry both disambiguates
 *                           the train and lets the trains dict come out keyed
 *                           by the operator's own label, which is what the
 *                           trainsByNumber enrichment looks a row up by.
 *   - { route, name }     → match a feed route by its OWN name/short name/id
 *     { routes: [], name }  and key the train by `name`. Romania's feed is what
 *                           this exists for: route_id IS the train number and
 *                           route_short_name is "IR-N 346", while the row it
 *                           has to land on is labelled "D 346". `routes` lists
 *                           the legs of a through car, joined by stitchLegs.
 *                           Unlike { from, to, name } it never reads endpoints,
 *                           so it is the right form for a feed that addresses
 *                           its trains by number and truncates them at a
 *                           border (where the endpoints are not the train's).
 *
 * @param {object} args
 * @param {object} args.gtfs       result of loadGtfsDir()
 * @param {Array<string|{from:string,to:string}>} args.allowlist  routes to keep
 * @param {string} args.agency     agency_id stamp (e.g. "AMTK")
 * @param {string} args.operator   display operator name (e.g. "Amtrak")
 * @param {(msg: string) => void} [args.log]
 * @param {(name: string) => string} [args.canonicalizeName]
 *                                 optional per-stop name canonicaliser (the
 *                                 shared station-alias table), applied before
 *                                 stationRenames.
 * @param {object} [args.stats]    optional out-param filled with
 *                                 { matched, unmatched, feedRouteCount } so the
 *                                 adapter can flag naming drift (an allowlist
 *                                 entry that matched nothing).
 * @returns {Record<string, object>} trains dict in the shape build-initial-data expects
 */
/**
 * Which of a route's trips describe the same train as `best`.
 *
 * Direction first, train number second, and that order was settled by running
 * both against the live Amtrak feed rather than by reasoning.
 *
 * Direction is what actually needs separating: one route_id holds both ways,
 * and unioning across them turned the Cardinal — three times a week each way,
 * on different days — into six weekdays. Grouping by `trip_short_name` fixes
 * that too, but it is finer than the question being asked and fragments where
 * a feed numbers its runs rather than its trains: the California Zephyr, a
 * daily train, came back as "2027/03/13-2027/03/13: Sat", one Saturday, which
 * is the very fault this whole change exists to remove. Direction is coarse
 * enough not to fragment and fine enough to answer.
 *
 * A feed that populates neither (SNCF, Entur) gets the whole route, which is
 * the widest honest answer rather than a guess, and is where it already was.
 */
function sameTrainAs(best) {
  const dir = String(best?.direction_id ?? "").trim();
  if (dir) return (t) => String(t.direction_id ?? "").trim() === dir;
  const num = String(best?.trip_short_name ?? "").trim();
  if (num) return (t) => String(t.trip_short_name ?? "").trim() === num;
  return () => true;
}

export function buildSleeperTrains({
  gtfs,
  allowlist,
  agency,
  operator,
  log = () => {},
  stats = null,
  stationRenames = null,
  canonicalizeName = null,
  // Which carriers' routes this allowlist may select, as GTFS agency_ids.
  // A national feed carries every licensed operator — Romania's has seven —
  // and an allowlist keyed by route id will happily take any of them, then the
  // source stamps the lot with its own agency. Four entries selected by the
  // "IR-N" night-train prefix turned out to be Astra Trans Carpatic, and one
  // of them drew a second line over a Back-on-Track row for the same train
  // under the wrong operator. Absent means "any", which is right for a feed
  // that publishes one carrier.
  feedAgencyIds = null,
  // Which timetable period "when does it run" is asked of. Injectable because
  // the answer changes on the second Sunday in December, so a test pinning real
  // dates against the live window would start failing on a calendar date rather
  // than on a code change. null unions across the whole feed.
  serviceWindow = currentTimetableWindow(),
}) {
  // Split the allowlist into name entries and endpoint-pair entries.
  const nameEntries = [];
  const pairEntries = [];
  const namedEntries = [];
  const routeNamedEntries = [];
  for (const e of allowlist || []) {
    if (typeof e === "string" && e.trim()) {
      nameEntries.push({ raw: e, norm: normLabel(e) });
    } else if (e && e.name && (e.route || Array.isArray(e.routes))) {
      const legs = (Array.isArray(e.routes) ? e.routes : [e.route])
        .map((r) => String(r ?? "").trim())
        .filter(Boolean);
      if (legs.length) {
        routeNamedEntries.push({
          raw: `${e.name} (${legs.join(" + ")})`,
          name: String(e.name).trim(),
          legs: legs.map((r) => ({ raw: r, norm: normLabel(r) })),
        });
      }
    } else if (e && e.from && e.to && e.name) {
      namedEntries.push({
        raw: `${e.name} (${e.from} → ${e.to})`,
        from: e.from,
        to: e.to,
        name: String(e.name).trim(),
      });
    } else if (e && e.from && e.to) {
      pairEntries.push({ raw: `${e.from} – ${e.to}`, from: e.from, to: e.to });
    }
  }
  const matchedEntries = new Set();
  // Reported rather than skipped: a route from the wrong carrier means the
  // allowlist is wrong, and quietly dropping it would leave a night train
  // missing with nothing to say why.
  const wrongAgency = [];
  const agencyAllowed = (route) =>
    !Array.isArray(feedAgencyIds) ||
    feedAgencyIds.length === 0 ||
    feedAgencyIds.map(String).includes(String(route?.agency_id ?? ""));
  const renameMap =
    stationRenames && Object.keys(stationRenames).length
      ? new Map(
          Object.entries(stationRenames).map(([k, v]) => [k.toLowerCase(), v]),
        )
      : null;
  // Alias table first (feed spelling → the spelling the rest of the payload
  // uses), then the source's own explicit corrections, which therefore get the
  // last word on anything the table gets wrong for this feed.
  const renameStations = (list) =>
    !renameMap && !canonicalizeName
      ? list
      : list.map((s) => {
          if (!s?.name) return s;
          let name = canonicalizeName ? canonicalizeName(s.name) : s.name;
          name = renameMap?.get(String(name).toLowerCase()) ?? name;
          return name !== s.name ? { ...s, name } : s;
        });

  // Group every trip by its route; allowlist filtering happens per route below.
  const tripsByRoute = new Map();
  for (const t of gtfs.trips) {
    if (!gtfs.routesById.has(t.route_id)) continue;
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  const trains = {};

  // `frequencyOverride` is how a named entry hands in the union of every trip
  // that matched it; without one a single trip's service is the answer, which
  // stays right for a feed with real calendar.txt weekdays (Amtrak, VIA).
  // Geometry: prefer the GTFS shape; fall back to the station chain.
  const positionsFor = (trip, stations) => {
    const shapePts = trip.shape_id ? gtfs.shapePoints.get(trip.shape_id) : null;
    return shapePts && shapePts.length >= 2
      ? shapePts.map((p) => [p.lat, p.lon])
      : stations.map((s) => [s.location.latitude, s.location.longitude]);
  };

  const makeTrain = (
    lineName,
    trip,
    stations,
    frequencyOverride = null,
    positionsOverride = null,
  ) => {
    const positions = positionsOverride ?? positionsFor(trip, stations);
    return {
      lineName,
      operator,
      agency_id: agency,
      frequency: frequencyOverride ?? serviceDisplay(trip.service_id, gtfs),
      polyline: polyline.encode(positions),
      stations: renameStations(stations),
    };
  };

  // Two trains under one key is one train: a feed is free to give several
  // route_ids the same route_long_name (SNCF gives six of them "-"), and the
  // last one written would silently be the only one kept.
  const claimKey = (preferred, suffix) =>
    trains[preferred] === undefined ? preferred : `${preferred} (${suffix})`;

  // Named entries first, so they get the unsuffixed key.
  if (namedEntries.length) {
    const resolved = resolveNamedTrips(namedEntries, gtfs);
    for (const e of namedEntries) {
      const hit = resolved.get(e.name);
      if (!hit) continue;
      const stations = stationsForTrip(hit.trip.trip_id, gtfs);
      if (stations.length < 2) {
        log(`skip ${e.raw}: no trip with ≥2 located stops`);
        continue;
      }
      matchedEntries.add(e.raw);
      if (stats) {
        const dates = [];
        for (const id of hit.serviceIds) {
          for (const d of gtfs.addedDatesByService.get(id) ?? []) dates.push(d);
          const cal = gtfs.calendarById.get(id);
          if (cal?.start_date) dates.push(String(cal.start_date));
          if (cal?.end_date) dates.push(String(cal.end_date));
        }
        dates.sort();
        (stats.namedMatches ??= {})[e.name] = {
          trips: hit.tripCount,
          services: hit.serviceIds.size,
          shortNames: [...hit.shortNames].sort(),
          firstDate: dates[0] ?? null,
          lastDate: dates[dates.length - 1] ?? null,
        };
      }
      trains[claimKey(e.name, hit.trip.trip_id)] = makeTrain(
        e.name,
        hit.trip,
        stations,
        serviceDisplayForServices(hit.serviceIds, gtfs, serviceWindow),
      );
    }
  }

  // Route-keyed named entries. Resolved before the generic loop so they claim
  // the unsuffixed key, and kept separate from { from, to, name } because they
  // deliberately never read endpoints: a feed that stops at a national border
  // states endpoints that are not the train's, and matching on them would
  // reject every international train it carries.
  if (routeNamedEntries.length) {
    const routeIdByNorm = new Map();
    for (const [routeId, route] of gtfs.routesById) {
      for (const candidate of [
        route.route_long_name,
        route.route_short_name,
        route.route_id,
      ]) {
        const norm = normLabel(candidate);
        if (norm && !routeIdByNorm.has(norm)) routeIdByNorm.set(norm, routeId);
      }
    }
    for (const e of routeNamedEntries) {
      const legs = [];
      let missing = null;
      for (const leg of e.legs) {
        const routeId = routeIdByNorm.get(leg.norm);
        const legTrips = routeId ? tripsByRoute.get(routeId) : null;
        if (!legTrips?.length) {
          missing = leg.raw;
          break;
        }
        const legRoute = gtfs.routesById.get(routeId);
        if (!agencyAllowed(legRoute)) {
          wrongAgency.push(`${e.raw}: route ${leg.raw} belongs to agency ${legRoute?.agency_id}`);
          missing = leg.raw;
          break;
        }
        const rep = representativeTrip(legTrips, gtfs);
        if (!rep.trip || rep.stations.length < 2) {
          missing = leg.raw;
          break;
        }
        legs.push({
          trip: rep.trip,
          stations: rep.stations,
          positions: positionsFor(rep.trip, rep.stations),
        });
      }
      if (missing) {
        log(`skip ${e.raw}: feed has no usable route "${missing}"`);
        continue;
      }
      const joined =
        legs.length === 1
          ? { stations: legs[0].stations, positions: legs[0].positions }
          : stitchLegs(legs);
      if (!joined) {
        log(`skip ${e.raw}: legs share no junction station`);
        continue;
      }
      matchedEntries.add(e.raw);
      // The first leg's calendar, not a union over the legs: a through portion
      // runs when the train carrying it out of the origin runs, and unioning
      // would report days on which the journey cannot be made. Windowed, so a
      // service whose season has ended answers null rather than a day list
      // belonging to another part of the year.
      trains[claimKey(e.name, legs[0].trip.trip_id)] = makeTrain(
        e.name,
        legs[0].trip,
        joined.stations,
        // A seasonal service states its own dates; a year-round one keeps the
        // bare year the rest of the payload writes. Without that prefix every
        // "2026: Daily" came back as "Daily" — 28 of 35 directions quietly
        // losing the year they already had, to fix the seven that were wrong.
        seasonalOrYearlyDisplay(
          new Set([legs[0].trip.service_id]),
          gtfs,
          serviceWindow,
        ),
        joined.positions,
      );
    }
  }

  for (const [routeId, trips] of tripsByRoute.entries()) {
    const route = gtfs.routesById.get(routeId);
    const nameNorms = [
      route.route_long_name,
      route.route_short_name,
      route.route_id,
    ].map(normLabel);

    // Cheap name match first; only build the representative trip (which walks
    // stop_times) when endpoints are actually needed for pair matching.
    const nameHits = nameEntries.filter(
      (ne) => ne.norm && nameNorms.includes(ne.norm),
    );

    let rep = null;
    const getRep = () => (rep ??= representativeTrip(trips, gtfs));

    const pairHits = [];
    if (pairEntries.length) {
      const stations = getRep().stations;
      if (stations.length >= 2) {
        const originNorm = normLabel(stations[0].name);
        const destNorm = normLabel(stations[stations.length - 1].name);
        for (const pe of pairEntries) {
          if (pairMatches(originNorm, destNorm, pe.from, pe.to)) pairHits.push(pe);
        }
      }
    }

    if (nameHits.length === 0 && pairHits.length === 0) continue;
    if (!agencyAllowed(route)) {
      wrongAgency.push(
        `${route.route_short_name || route.route_long_name || routeId}: agency ${route.agency_id}`,
      );
      continue;
    }
    [...nameHits, ...pairHits].forEach((h) => matchedEntries.add(h.raw));

    const { trip: best, stations: bestStations } = getRep();
    const routeName =
      (route.route_long_name || route.route_short_name || "").trim() ||
      `Train ${routeId}`;
    if (!best || bestStations.length < 2) {
      log(`skip ${routeName}: no trip with ≥2 located stops`);
      continue;
    }

    // "When does it run" is a property of the TRAIN, not of whichever trip was
    // representative. Reading one trip's calendar.txt row is how Amtrak's City
    // of New Orleans — year-round, daily — came to state "2026/09/13-09/16", a
    // four-day window, and the California Zephyr "2027/03/13-03/13: Sat", a
    // single day: the feed splits a daily service across many short-dated
    // calendar rows and the representative trip lands on one of them.
    //
    // Union across trips, but only as far as the feed can tell them apart —
    // unioning the whole route folds both directions together, which turned
    // the Cardinal (three times a week each way, on different days) into six
    // weekdays. So: the same train number where the feed populates one, else
    // the same direction, else the route. SNCF and Entur populate neither and
    // land on the last rung, which is what they had before.
    trains[claimKey(routeName, routeId)] = makeTrain(
      routeName,
      best,
      bestStations,
      seasonalOrYearlyDisplay(
        new Set(trips.filter(sameTrainAs(best)).map((t) => t.service_id).filter(Boolean)),
        gtfs,
        serviceWindow,
      ),
    );
  }

  const unmatched = [...nameEntries, ...pairEntries, ...namedEntries, ...routeNamedEntries]
    .map((e) => e.raw)
    .filter((raw) => !matchedEntries.has(raw));
  if (stats) {
    stats.matched = [...matchedEntries];
    stats.unmatched = unmatched;
    stats.feedRouteCount = tripsByRoute.size;
    stats.wrongAgency = wrongAgency;
  }
  if (wrongAgency.length) {
    log(
      `WARNING: ${wrongAgency.length} allowlist entr${wrongAgency.length === 1 ? "y" : "ies"} name a route belonging to another carrier: ${wrongAgency.join("; ")}`,
    );
  }
  if (unmatched.length) {
    log(
      `WARNING: ${unmatched.length} allowlist entr${unmatched.length === 1 ? "y" : "ies"} matched no feed route: ${unmatched.join(", ")}`,
    );
  }
  log(`built ${Object.keys(trains).length} ${operator} sleeper route(s)`);
  return trains;
}
