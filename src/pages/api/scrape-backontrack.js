// pages/api/scrape-backontrack.js
// Daily cron job: fetches Back-on-Track data + OSM relation geometries and stores in Vercel Blob.
// Vercel injects Authorization: Bearer <CRON_SECRET> automatically for cron invocations.

import polyline from "@mapbox/polyline";
import { unzipSync } from "fflate";
import { putBlobData, putOsmRelation, putNJTrains, putCDTrains, putSNCFTrains } from "./lib/blob-store";
import { fetchSingleTrain, fetchNJTrainNumbers, fetchPartnerTrainNumbers } from "./lib/train-fetcher";
import { fetchCDTrain, extractECNumbers } from "./lib/cd-fetcher";

const BASE_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// OSM relation IDs used by the frontend (hardcoded in useRoutePaths.js)
const OSM_RELATION_IDS = ["18616102"]; // European Sleeper 453

async function fetchBackontrack(type) {
  const response = await fetch(`${BASE_URL}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!response.ok) throw new Error(`Failed to fetch ${type}: ${response.status}`);
  return response.json();
}

async function fetchOsmRelation(ids) {
  const overpassQuery = `
    [out:json][timeout:30];
    (
      ${ids.map((id) => `relation(${id});`).join("\n      ")}
    );
    out geom;
  `;

  let response = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: overpassQuery,
      });
      if (response.ok) break;
    } catch {
      // try next endpoint
    }
  }
  if (!response?.ok) throw new Error("All Overpass endpoints failed");
  return response.json();
}

const SNCF_GTFS_URL =
  "https://eu.ftp.opendatasoft.com/sncf/plandata/export-intercites-gtfs-last.zip";

// Train numbers used in Back-on-Track data → key used for sncf_polyline lookup.
// Keys are exact trip_short_name values from BoT view_ontd_map.
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
 * Parse a GTFS CSV file (Uint8Array or string) into an array of objects.
 * Handles quoted fields and Windows-style line endings.
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
    // Simple split — SNCF GTFS doesn't use embedded commas in quoted fields for these files
    const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Extract the numeric train number from a BoT trip_short_name like "IC Nuit 5787".
 * Returns "5787" or null.
 */
function extractTrainNumber(botName) {
  const m = (botName || "").match(/\d+/);
  return m ? m[0] : null;
}

/**
 * Fetch SNCF Intercités GTFS and extract encoded polylines for IC Nuit trains.
 * Returns an object keyed by BoT trip_short_name, e.g.:
 *   { "IC Nuit 5787": { polyline: "<encoded>" }, ... }
 */
async function fetchSNCFNightTrainPolylines() {
  const response = await fetch(SNCF_GTFS_URL);
  if (!response.ok) {
    throw new Error(`SNCF GTFS fetch failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const files = unzipSync(new Uint8Array(buffer));

  // Parse the CSV files we need
  const routesRows = files["routes.txt"] ? parseCsv(files["routes.txt"]) : [];
  const tripsRows = files["trips.txt"] ? parseCsv(files["trips.txt"]) : [];
  const hasShapes = Boolean(files["shapes.txt"]);
  const shapesRows = hasShapes ? parseCsv(files["shapes.txt"]) : [];
  const stopsRows = files["stops.txt"] ? parseCsv(files["stops.txt"]) : [];
  const stopTimesRows = !hasShapes && files["stop_times.txt"]
    ? parseCsv(files["stop_times.txt"])
    : [];

  // Build lookup: train number string (e.g. "5787") → BoT name (e.g. "IC Nuit 5787")
  const numberToBotName = new Map();
  for (const botName of SNCF_IC_NUIT_NUMBERS) {
    const num = extractTrainNumber(botName);
    if (num && !numberToBotName.has(num)) {
      numberToBotName.set(num, botName);
    }
  }

  // Find IC Nuit route IDs from routes.txt
  // SNCF GTFS route_long_name typically looks like "PARIS AUSTERLITZ - BRIANCON" or similar
  const icNuitRouteIds = new Set();
  for (const row of routesRows) {
    const longName = (row.route_long_name || "").toLowerCase();
    const shortName = (row.route_short_name || "").toLowerCase();
    if (longName.includes("nuit") || shortName.includes("nuit")) {
      icNuitRouteIds.add(row.route_id);
    }
  }

  // Map trip_short_name (train number) → first trip_id + shape_id from this route set
  // trip_short_name in GTFS is typically just the number, e.g. "5787"
  const trainNumberToTrip = new Map(); // "5787" → { trip_id, shape_id }
  for (const row of tripsRows) {
    const tripNum = (row.trip_short_name || "").trim();
    if (!tripNum) continue;
    // Only consider trips in IC Nuit routes (or accept all if icNuitRouteIds is empty)
    const inNuitRoute = icNuitRouteIds.size === 0 || icNuitRouteIds.has(row.route_id);
    if (!inNuitRoute) continue;
    if (numberToBotName.has(tripNum) && !trainNumberToTrip.has(tripNum)) {
      trainNumberToTrip.set(tripNum, { trip_id: row.trip_id, shape_id: row.shape_id || "" });
    }
  }

  const results = {};

  if (hasShapes && shapesRows.length > 0) {
    // Build shape_id → sorted coordinate array
    const shapeCoords = new Map(); // shape_id → [{seq, lat, lon}]
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
    // Sort each shape by sequence and encode
    for (const [sid, pts] of shapeCoords) {
      pts.sort((a, b) => a.seq - b.seq);
      shapeCoords.set(sid, pts.map((p) => [p.lat, p.lon]));
    }

    for (const [trainNum, { shape_id }] of trainNumberToTrip) {
      const botName = numberToBotName.get(trainNum);
      if (!botName) continue;
      const coords = shapeCoords.get(shape_id);
      if (!coords || coords.length < 2) continue;
      results[botName] = { polyline: polyline.encode(coords) };
    }
  } else {
    // Fallback: build polyline from ordered stop sequence
    const stopCoords = new Map(); // stop_id → [lat, lon]
    for (const row of stopsRows) {
      const lat = parseFloat(row.stop_lat);
      const lon = parseFloat(row.stop_lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        stopCoords.set(row.stop_id, [lat, lon]);
      }
    }

    // Build trip_id → ordered stop_ids
    const tripStops = new Map(); // trip_id → [{seq, stop_id}]
    for (const row of stopTimesRows) {
      const tid = row.trip_id;
      if (!tid) continue;
      if (!tripStops.has(tid)) tripStops.set(tid, []);
      tripStops.get(tid).push({
        seq: parseInt(row.stop_sequence, 10),
        stop_id: row.stop_id,
      });
    }

    for (const [trainNum, { trip_id }] of trainNumberToTrip) {
      const botName = numberToBotName.get(trainNum);
      if (!botName) continue;
      const stops = tripStops.get(trip_id);
      if (!stops || stops.length < 2) continue;
      stops.sort((a, b) => a.seq - b.seq);
      const coords = stops
        .map((s) => stopCoords.get(s.stop_id))
        .filter(Boolean);
      if (coords.length < 2) continue;
      results[botName] = { polyline: polyline.encode(coords) };
    }
  }

  return results;
}

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const errors = [];

  // Fetch Back-on-Track datasets
  const [stops, view_ontd_map, trips] = await Promise.all([
    fetchBackontrack("stops"),
    fetchBackontrack("view_ontd_map"),
    fetchBackontrack("trips"),
  ]);
  // Store stops and trips immediately; view_ontd_map will be enriched with NJ/EN positions below.
  await Promise.all([
    putBlobData("stops", stops),
    putBlobData("trips", trips),
  ]);

  // Fetch and store OSM relation geometries
  for (const id of OSM_RELATION_IDS) {
    try {
      const data = await fetchOsmRelation([id]);
      await putOsmRelation(id, data);
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error(`[scrape-backontrack] OSM relation ${id} failed:`, err.message);
    }
  }

  // Scrape NightJet / EuroNight official API data
  const today = new Date().toISOString().slice(0, 10);
  let njCount = 0;
  try {
    // NJ train numbers from NightJet country-pair API (authoritative — BoT data can be outdated)
    // EN train numbers from NightJet partner endpoint
    const [njNumbers, enNumbers] = await Promise.all([
      fetchNJTrainNumbers(today),
      fetchPartnerTrainNumbers(today),
    ]);

    const allNumbers = [...new Set([...njNumbers, ...enNumbers])];
    const CONCURRENCY = 6;
    const results = {};

    for (let i = 0; i < allNumbers.length; i += CONCURRENCY) {
      const batch = allNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchSingleTrain(n, today)));
      fetched.forEach((train) => {
        if (!train) return;
        // Store the encoded polyline string — much smaller than decoded arrays.
        // Fall back to encoding station coords when the API doesn't provide a polyline.
        const fallbackPositions = train.stations
          .filter((s) => s.location?.latitude && s.location?.longitude)
          .map((s) => [s.location.latitude, s.location.longitude]);
        const encodedPolyline =
          train.polyline ||
          (fallbackPositions.length >= 2 ? polyline.encode(fallbackPositions) : null);
        if (!encodedPolyline) return;
        results[train.lineName] = {
          lineName: train.lineName,
          operator: train.operator,
          polyline: encodedPolyline,
          stations: train.stations,
        };
      });
    }

    await putNJTrains({ uploadedAt: today, trains: results });
    njCount = Object.keys(results).length;

    // Merge NJ/EN positions into view_ontd_map so initial-data can serve pre-enriched data
    Object.values(view_ontd_map).forEach((route) => {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = results[name.trim()];
        if (match?.polyline) {
          route.nj_polyline = match.polyline;
          break;
        }
      }
    });
  } catch (err) {
    errors.push({ source: "nightjet", error: err.message });
    console.error("[scrape-backontrack] NightJet scrape failed:", err.message);
  }

  // Store view_ontd_map now — enriched with nj_positions where available
  await putBlobData("view_ontd_map", view_ontd_map);

  // Scrape Czech Railways (cd.cz) EC train timetables
  let cdCount = 0;
  try {
    const ecNumbers = extractECNumbers(trips);
    const CONCURRENCY = 6;
    const cdResults = {};

    for (let i = 0; i < ecNumbers.length; i += CONCURRENCY) {
      const batch = ecNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchCDTrain(n)));
      fetched.forEach((train) => {
        if (!train) return;
        cdResults[train.trainNumber] = train;
      });
    }

    await putCDTrains({ uploadedAt: today, trains: cdResults });
    cdCount = Object.keys(cdResults).length;
  } catch (err) {
    errors.push({ source: "cd", error: err.message });
    console.error("[scrape-backontrack] CD scrape failed:", err.message);
  }

  // Scrape SNCF Intercités de Nuit GTFS polylines
  let sncfCount = 0;
  try {
    const sncfResults = await fetchSNCFNightTrainPolylines();
    await putSNCFTrains({ uploadedAt: today, trains: sncfResults });
    sncfCount = Object.keys(sncfResults).length;

    // Merge SNCF polylines into view_ontd_map so initial-data serves pre-enriched data
    Object.values(view_ontd_map).forEach((route) => {
      const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
      for (const name of names) {
        const match = sncfResults[name.trim()];
        if (match?.polyline) {
          route.sncf_polyline = match.polyline;
          break;
        }
      }
    });
    // Re-store view_ontd_map with SNCF polylines merged in
    await putBlobData("view_ontd_map", view_ontd_map);
  } catch (err) {
    errors.push({ source: "sncf", error: err.message });
    console.error("[scrape-backontrack] SNCF scrape failed:", err.message);
  }

  const uploadedAt = new Date().toISOString();
  console.log(`[scrape-backontrack] Done at ${uploadedAt}`);

  res.status(200).json({
    ok: true,
    backontrack: ["stops", "view_ontd_map", "trips"],
    osmRelations: OSM_RELATION_IDS,
    nightjet: njCount,
    cd: cdCount,
    sncf: sncfCount,
    uploadedAt,
    errors,
  });
}
