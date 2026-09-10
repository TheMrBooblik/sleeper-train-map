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
  parseGtfsCalendar,
  renderCalendar,
} from "../../src/pages/api/lib/calendar.mjs";

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
 * @param {{timeoutMs?: number, redirectsLeft?: number}} [options]
 */
export function downloadFile(url, destPath, options = {}) {
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
    const request = client.get(url, (res) => {
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
        // Resolve against the current URL so a relative Location works.
        downloadFile(new URL(location, url).toString(), destPath, {
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
export async function downloadGtfs(url, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, "feed.zip");
  await downloadFile(url, zipPath);
  execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  return destDir;
}

// ─── Parse a GTFS directory into in-memory tables ────────────────────────────

const toNum = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the GTFS .txt tables we need into lookup structures.
 * @param {string} dir directory containing the unzipped feed
 */
export function loadGtfsDir(dir) {
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
  const shapePoints = new Map();
  for (const row of readCsv(path.join(dir, "shapes.txt"))) {
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
  };
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

/**
 * Build the standard trains dict for the allowlisted routes of one feed.
 *
 * Allowlist entries can take either form (mix freely):
 *   - a string      → matched against route_long_name / route_short_name /
 *                     route_id, accent/space/punctuation-insensitive. Good for
 *                     Amtrak, whose route_long_name is the service name.
 *   - { from, to }  → matched against the route's two terminal stations, in
 *                     either direction and accent-folded. Robust for feeds that
 *                     name routes by city pair (VIA Rail: "Montréal - Halifax"),
 *                     where exact-name matching is brittle.
 *
 * @param {object} args
 * @param {object} args.gtfs       result of loadGtfsDir()
 * @param {Array<string|{from:string,to:string}>} args.allowlist  routes to keep
 * @param {string} args.agency     agency_id stamp (e.g. "AMTK")
 * @param {string} args.operator   display operator name (e.g. "Amtrak")
 * @param {(msg: string) => void} [args.log]
 * @param {object} [args.stats]    optional out-param filled with
 *                                 { matched, unmatched, feedRouteCount } so the
 *                                 adapter can flag naming drift (an allowlist
 *                                 entry that matched nothing).
 * @returns {Record<string, object>} trains dict in the shape build-initial-data expects
 */
export function buildSleeperTrains({
  gtfs,
  allowlist,
  agency,
  operator,
  log = () => {},
  stats = null,
  stationRenames = null,
}) {
  // Split the allowlist into name entries and endpoint-pair entries.
  const nameEntries = [];
  const pairEntries = [];
  for (const e of allowlist || []) {
    if (typeof e === "string" && e.trim()) {
      nameEntries.push({ raw: e, norm: normLabel(e) });
    } else if (e && e.from && e.to) {
      pairEntries.push({ raw: `${e.from} – ${e.to}`, from: e.from, to: e.to });
    }
  }
  const matchedEntries = new Set();
  const renameMap =
    stationRenames && Object.keys(stationRenames).length
      ? new Map(
          Object.entries(stationRenames).map(([k, v]) => [k.toLowerCase(), v]),
        )
      : null;
  const renameStations = (list) =>
    renameMap
      ? list.map((s) => {
          const to = s?.name ? renameMap.get(String(s.name).toLowerCase()) : null;
          return to && to !== s.name ? { ...s, name: to } : s;
        })
      : list;

  // Group every trip by its route; allowlist filtering happens per route below.
  const tripsByRoute = new Map();
  for (const t of gtfs.trips) {
    if (!gtfs.routesById.has(t.route_id)) continue;
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  const trains = {};
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
    [...nameHits, ...pairHits].forEach((h) => matchedEntries.add(h.raw));

    const { trip: best, stations: bestStations } = getRep();
    const routeName =
      (route.route_long_name || route.route_short_name || "").trim() ||
      `Train ${routeId}`;
    if (!best || bestStations.length < 2) {
      log(`skip ${routeName}: no trip with ≥2 located stops`);
      continue;
    }

    // Geometry: prefer the GTFS shape; fall back to the station chain.
    const shapePts = best.shape_id ? gtfs.shapePoints.get(best.shape_id) : null;
    const positions =
      shapePts && shapePts.length >= 2
        ? shapePts.map((p) => [p.lat, p.lon])
        : bestStations.map((s) => [s.location.latitude, s.location.longitude]);

    trains[routeName] = {
      lineName: routeName,
      operator,
      agency_id: agency,
      frequency: serviceDisplay(best.service_id, gtfs),
      polyline: polyline.encode(positions),
      stations: renameStations(bestStations),
    };
  }

  const unmatched = [...nameEntries, ...pairEntries]
    .map((e) => e.raw)
    .filter((raw) => !matchedEntries.has(raw));
  if (stats) {
    stats.matched = [...matchedEntries];
    stats.unmatched = unmatched;
    stats.feedRouteCount = tripsByRoute.size;
  }
  if (unmatched.length) {
    log(
      `WARNING: ${unmatched.length} allowlist entr${unmatched.length === 1 ? "y" : "ies"} matched no feed route: ${unmatched.join(", ")}`,
    );
  }
  log(`built ${Object.keys(trains).length} ${operator} sleeper route(s)`);
  return trains;
}
