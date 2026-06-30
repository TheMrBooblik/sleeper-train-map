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

export function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) {
            reject(new Error("Redirect without location"));
            return;
          }
          res.resume();
          downloadFile(loc, destPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => reject(err));
      });
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

// Normalise a route name for allowlist matching (case/space/punctuation-loose).
function normLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
 * @param {object}   args
 * @param {object}   args.gtfs       result of loadGtfsDir()
 * @param {string[]} args.allowlist  route names to keep (matched against
 *                                   route_long_name / route_short_name / route_id)
 * @param {string}   args.agency     agency_id stamp (e.g. "AMTK")
 * @param {string}   args.operator   display operator name (e.g. "Amtrak")
 * @param {(msg: string) => void} [args.log]
 * @returns {Record<string, object>} trains dict in the shape build-initial-data expects
 */
export function buildSleeperTrains({ gtfs, allowlist, agency, operator, log = () => {} }) {
  const allow = new Set((allowlist || []).map(normLabel));
  const trains = {};

  // Group trips by the route they belong to, keeping only allowlisted routes.
  const tripsByRoute = new Map();
  for (const t of gtfs.trips) {
    const route = gtfs.routesById.get(t.route_id);
    if (!route) continue;
    const matches =
      allow.has(normLabel(route.route_long_name)) ||
      allow.has(normLabel(route.route_short_name)) ||
      allow.has(normLabel(route.route_id));
    if (!matches) continue;
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }

  for (const [routeId, trips] of tripsByRoute.entries()) {
    const route = gtfs.routesById.get(routeId);
    const routeName =
      (route.route_long_name || route.route_short_name || "").trim() ||
      `Train ${routeId}`;

    // Representative trip = the one serving the most stations (full corridor),
    // so seasonal/partial runs don't truncate the drawn route.
    let best = null;
    let bestStations = [];
    for (const t of trips) {
      const stations = stationsForTrip(t.trip_id, gtfs);
      if (stations.length > bestStations.length) {
        best = t;
        bestStations = stations;
      }
    }
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
      stations: bestStations,
    };
  }

  log(`built ${Object.keys(trains).length} ${operator} sleeper route(s)`);
  return trains;
}
