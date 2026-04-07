// lib/sncf-fetcher.js
// Fetches SNCF Intercités de Nuit polylines from the official GTFS open data feed.

import polyline from "@mapbox/polyline";
import { unzipSync } from "fflate";

// Multiple candidate URLs tried in order — opendatasoft FTP may restrict server IPs.
const SNCF_GTFS_URLS = [
  "https://eu.ftp.opendatasoft.com/sncf/plandata/export-intercites-gtfs-last.zip",
  // Consolidated SNCF GTFS (TGV + Intercités + TER — larger but more reliable access)
  "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip",
];

// Exact trip_short_name values from Back-on-Track view_ontd_map for IC Nuit trains.
const SNCF_IC_NUIT_NUMBERS = [
  "IC Nuit 5787", "IC Nuit 5792",  // Paris ↔ Briançon
  "IC Nuit 5781", "IC Nuit 5772",  // Paris ↔ Nice
  "IC Nuit 3754", "IC Nuit 3755",  // Paris ↔ Rodez/Albi
  "IC Nuit 5737", "IC Nuit 5738",  // Paris ↔ Cerbère
  "IC Nuit 3970", "IC Nuit 3971",  // Paris ↔ Latour-de-Carol
  "IC Nuit 3789", "IC Nuit 3790",  // Paris ↔ Aurillac
  "IC Nuit 3750", "IC Nuit 3751",  // Paris ↔ Toulouse
  "IC Nuit 3731", "IC Nuit 3740",  // Paris ↔ Tarbes (Le Pyrénéen weekday)
];

/**
 * Parse a GTFS CSV file (Uint8Array or string) into an array of row objects.
 * Handles Windows-style line endings.
 */
function parseCsv(input) {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

/** Extract numeric part from BoT train name, e.g. "IC Nuit 5787" → "5787". */
function extractTrainNumber(botName) {
  const m = (botName || "").match(/\d+/);
  return m ? m[0] : null;
}

/**
 * Download the SNCF GTFS and return a diagnostic snapshot — used by /api/seed-sncf?debug=1.
 * Does NOT store anything. Returns sample rows so we can see the actual field formats.
 */
export async function inspectSNCFGtfs() {
  const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; sleeper-train-map/1.0)",
    "Accept": "*/*",
    "Referer": "https://ressources.data.sncf.com/",
  };

  let response = null;
  let usedUrl = null;
  for (const url of SNCF_GTFS_URLS) {
    try {
      response = await fetch(url, { headers: fetchHeaders });
      if (response.ok) { usedUrl = url; break; }
    } catch { /* try next */ }
  }
  if (!response?.ok) throw new Error(`All SNCF GTFS URLs failed (status: ${response?.status})`);

  const buffer = await response.arrayBuffer();
  const files = unzipSync(new Uint8Array(buffer));

  const fileList = Object.keys(files);
  const routesRows = files["routes.txt"] ? parseCsv(files["routes.txt"]) : [];
  const tripsRows  = files["trips.txt"]  ? parseCsv(files["trips.txt"])  : [];

  // Find any rows that look like night trains
  const nightRoutes = routesRows.filter((r) =>
    (r.route_long_name || "").toLowerCase().includes("nuit") ||
    (r.route_short_name || "").toLowerCase().includes("nuit") ||
    (r.route_long_name || "").toLowerCase().includes("night")
  );

  // Sample of trip_short_name values for the night routes (or first 20 trips if none found)
  const nightRouteIds = new Set(nightRoutes.map((r) => r.route_id));
  const sampleTrips = tripsRows
    .filter((t) => nightRouteIds.size === 0 || nightRouteIds.has(t.route_id))
    .slice(0, 30)
    .map((t) => ({
      route_id: t.route_id,
      trip_short_name: t.trip_short_name,
      trip_headsign: t.trip_headsign,
      shape_id: t.shape_id,
    }));

  return {
    usedUrl,
    files: fileList,
    routeCount: routesRows.length,
    tripCount: tripsRows.length,
    nightRoutes: nightRoutes.slice(0, 20),
    sampleTrips,
    // Raw first 5 rows of routes.txt for format inspection
    routesSample: routesRows.slice(0, 5),
  };
}

/**
 * Download SNCF Intercités GTFS and extract encoded polylines for all IC Nuit trains.
 *
 * Strategy:
 *   1. Use shapes.txt if present (accurate track geometry).
 *   2. Fall back to stop sequence from stop_times.txt + stops.txt.
 *
 * Returns an object keyed by BoT trip_short_name:
 *   { "IC Nuit 5787": { polyline: "<encoded>", coordinateCount: N }, ... }
 */
export async function fetchSNCFNightTrainPolylines() {
  // Try each URL in order; opendatasoft may block data-centre IPs on some routes.
  const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)",
    "Accept": "*/*",
    "Referer": "https://ressources.data.sncf.com/",
  };

  let response = null;
  for (const url of SNCF_GTFS_URLS) {
    try {
      response = await fetch(url, { headers: fetchHeaders });
      if (response.ok) break;
      console.warn(`[sncf-fetcher] ${url} returned ${response.status}, trying next`);
    } catch (err) {
      console.warn(`[sncf-fetcher] ${url} failed: ${err.message}, trying next`);
    }
  }
  if (!response?.ok) {
    throw new Error(`All SNCF GTFS URLs failed (last status: ${response?.status ?? "network error"})`);
  }

  const buffer = await response.arrayBuffer();
  const files = unzipSync(new Uint8Array(buffer));

  const routesRows   = files["routes.txt"]    ? parseCsv(files["routes.txt"])    : [];
  const tripsRows    = files["trips.txt"]      ? parseCsv(files["trips.txt"])     : [];
  const hasShapes    = Boolean(files["shapes.txt"]);
  const shapesRows   = hasShapes               ? parseCsv(files["shapes.txt"])    : [];
  const stopsRows    = files["stops.txt"]      ? parseCsv(files["stops.txt"])     : [];
  const stopTimesRows = !hasShapes && files["stop_times.txt"]
    ? parseCsv(files["stop_times.txt"]) : [];

  // Build: numeric string → BoT name  (e.g. "5787" → "IC Nuit 5787")
  const numberToBotName = new Map();
  for (const botName of SNCF_IC_NUIT_NUMBERS) {
    const num = extractTrainNumber(botName);
    if (num && !numberToBotName.has(num)) numberToBotName.set(num, botName);
  }

  // Find IC Nuit route_ids from routes.txt (long_name or short_name contains "nuit")
  const icNuitRouteIds = new Set();
  for (const row of routesRows) {
    if (
      (row.route_long_name || "").toLowerCase().includes("nuit") ||
      (row.route_short_name || "").toLowerCase().includes("nuit")
    ) {
      icNuitRouteIds.add(row.route_id);
    }
  }

  // Map numeric train number → first matching trip (trip_id + shape_id)
  const trainNumberToTrip = new Map();
  for (const row of tripsRows) {
    const tripNum = (row.trip_short_name || "").trim();
    if (!tripNum) continue;
    const inNuitRoute = icNuitRouteIds.size === 0 || icNuitRouteIds.has(row.route_id);
    if (!inNuitRoute) continue;
    if (numberToBotName.has(tripNum) && !trainNumberToTrip.has(tripNum)) {
      trainNumberToTrip.set(tripNum, { trip_id: row.trip_id, shape_id: row.shape_id || "" });
    }
  }

  const results = {};

  if (hasShapes && shapesRows.length > 0) {
    // Build shape_id → sorted [lat, lon] array
    const shapeCoords = new Map();
    for (const row of shapesRows) {
      const sid = row.shape_id;
      if (!sid) continue;
      const lat = parseFloat(row.shape_pt_lat);
      const lon = parseFloat(row.shape_pt_lon);
      const seq = parseInt(row.shape_pt_sequence, 10);
      if (isNaN(lat) || isNaN(lon)) continue;
      if (!shapeCoords.has(sid)) shapeCoords.set(sid, []);
      shapeCoords.get(sid).push({ seq, lat, lon });
    }
    for (const [sid, pts] of shapeCoords) {
      pts.sort((a, b) => a.seq - b.seq);
      shapeCoords.set(sid, pts.map((p) => [p.lat, p.lon]));
    }

    for (const [trainNum, { shape_id }] of trainNumberToTrip) {
      const botName = numberToBotName.get(trainNum);
      if (!botName) continue;
      const coords = shapeCoords.get(shape_id);
      if (!coords || coords.length < 2) continue;
      results[botName] = { polyline: polyline.encode(coords), coordinateCount: coords.length };
    }
  } else {
    // Fallback: ordered stop sequence
    const stopCoords = new Map();
    for (const row of stopsRows) {
      const lat = parseFloat(row.stop_lat);
      const lon = parseFloat(row.stop_lon);
      if (!isNaN(lat) && !isNaN(lon)) stopCoords.set(row.stop_id, [lat, lon]);
    }

    const tripStops = new Map();
    for (const row of stopTimesRows) {
      const tid = row.trip_id;
      if (!tid) continue;
      if (!tripStops.has(tid)) tripStops.set(tid, []);
      tripStops.get(tid).push({ seq: parseInt(row.stop_sequence, 10), stop_id: row.stop_id });
    }

    for (const [trainNum, { trip_id }] of trainNumberToTrip) {
      const botName = numberToBotName.get(trainNum);
      if (!botName) continue;
      const stops = tripStops.get(trip_id);
      if (!stops || stops.length < 2) continue;
      stops.sort((a, b) => a.seq - b.seq);
      const coords = stops.map((s) => stopCoords.get(s.stop_id)).filter(Boolean);
      if (coords.length < 2) continue;
      results[botName] = { polyline: polyline.encode(coords), coordinateCount: coords.length };
    }
  }

  return results;
}
