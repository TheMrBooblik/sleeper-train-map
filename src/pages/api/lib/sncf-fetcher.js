// lib/sncf-fetcher.js
// Fetches SNCF Intercités de Nuit polylines from the official GTFS open data feed.
//
// The SNCF Intercités GTFS has:
//   - route_long_name like "Paris Austerlitz - Nice" or "Paris - Toulouse"
//   - trip_headsign = internal stop ID (NOT a city name — unusable for matching)
//   - NO shapes.txt → polylines are built from stop_times.txt + stops.txt

import polyline from "@mapbox/polyline";
import { unzipSync } from "fflate";

// Multiple candidate URLs tried in order.
const SNCF_GTFS_URLS = [
  "https://eu.ftp.opendatasoft.com/sncf/plandata/export-intercites-gtfs-last.zip",
  "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip",
];

const PARIS = [48.8443, 2.3637]; // Paris Austerlitz
const PARIS_KM  = 30;  // within 30 km → "starts near Paris"
const STITCH_KM = 25;  // within 25 km → "these segments connect"

/** Haversine distance in km between two [lat, lon] points. */
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// IC Nuit route definitions.
// `cities`: keywords (accent-stripped, lowercase) that appear in route_long_name for this line.
// `key` / `altKey`: BoT trip_short_name values that will get this polyline.
const IC_NUIT_ROUTES = [
  { cities: ["briancon", "briançon"],                                    key: "IC Nuit 5787", altKey: "IC Nuit 5792" },
  { cities: ["nice"],                                                    key: "IC Nuit 5781", altKey: "IC Nuit 5772" },
  { cities: ["rodez", "albi"],                                           key: "IC Nuit 3754", altKey: "IC Nuit 3755" },
  { cities: ["cerbere", "cerbère", "portbou", "port-bou", "port bou"],  key: "IC Nuit 5737", altKey: "IC Nuit 5738" },
  { cities: ["latour-de-carol", "latour de carol", "enveitg"],           key: "IC Nuit 3970", altKey: "IC Nuit 3971" },
  { cities: ["aurillac"],                                                key: "IC Nuit 3789", altKey: "IC Nuit 3790" },
  { cities: ["toulouse"],                                                key: "IC Nuit 3750", altKey: "IC Nuit 3751" },
  { cities: ["tarbes"],                                                  key: "IC Nuit 3731", altKey: "IC Nuit 3740" },
];

/** Normalize: lowercase + strip accents. */
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Parse a GTFS CSV (Uint8Array or string) into an array of row objects.
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

async function downloadGtfs() {
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
      console.warn(`[sncf-fetcher] ${url} → ${response.status}, trying next`);
    } catch (err) {
      console.warn(`[sncf-fetcher] ${url} failed: ${err.message}`);
    }
  }
  if (!response?.ok) {
    throw new Error(`All SNCF GTFS URLs failed (last status: ${response?.status ?? "network error"})`);
  }
  console.log(`[sncf-fetcher] Downloaded from ${usedUrl}`);
  const buffer = await response.arrayBuffer();
  return { files: unzipSync(new Uint8Array(buffer)), usedUrl };
}

/**
 * Download SNCF Intercités GTFS and extract polylines for IC Nuit trains.
 *
 * Matching: route_long_name contains the terminal city name (e.g. "Paris Austerlitz - Nice").
 * Polylines: built from stop_times.txt + stops.txt ordered stop sequence (no shapes.txt).
 *
 * Returns { "IC Nuit 5787": { polyline: "<encoded>", coordinateCount: N }, ... }
 */
export async function fetchSNCFNightTrainPolylines() {
  const { files } = await downloadGtfs();

  const routesRows = files["routes.txt"]    ? parseCsv(files["routes.txt"])    : [];
  const tripsRows  = files["trips.txt"]     ? parseCsv(files["trips.txt"])     : [];
  const stopsRows  = files["stops.txt"]     ? parseCsv(files["stops.txt"])     : [];

  // stop_times.txt can be large — only parse when needed (no shapes.txt present)
  const hasShapes = Boolean(files["shapes.txt"]);
  const shapesRows = hasShapes ? parseCsv(files["shapes.txt"]) : [];

  console.log(`[sncf-fetcher] ${routesRows.length} routes, ${tripsRows.length} trips, shapes=${hasShapes}`);

  // ── Match routes by terminal city in route_long_name ─────────────────────────
  // IC Nuit trains connect Paris to a terminal city. The route_long_name must contain
  // "paris" to exclude unrelated lines (e.g. "Toulouse - Hendaye").
  // We use includes() rather than startsWith() to handle reversed names like
  // "Cerbère - Paris Austerlitz" that some GTFS exports produce.
  const routeIdToRouteDef = new Map();
  for (const row of routesRows) {
    const longName = norm(row.route_long_name);
    if (!longName.includes("paris")) continue; // must include Paris as one endpoint
    for (const routeDef of IC_NUIT_ROUTES) {
      if (routeDef.cities.some((c) => longName.includes(norm(c)))) {
        routeIdToRouteDef.set(row.route_id, routeDef);
        break;
      }
    }
  }
  console.log(`[sncf-fetcher] Matched ${routeIdToRouteDef.size} GTFS routes to IC Nuit lines`);

  // Collect ALL trips per IC Nuit line so we can pick the best representative.
  const tripsByBotKey = new Map(); // botKey → [{ trip_id, shape_id }]
  for (const trip of tripsRows) {
    const routeDef = routeIdToRouteDef.get(trip.route_id);
    if (!routeDef) continue;
    if (!tripsByBotKey.has(routeDef.key)) tripsByBotKey.set(routeDef.key, []);
    tripsByBotKey.get(routeDef.key).push({ trip_id: trip.trip_id, shape_id: trip.shape_id || "" });
  }
  console.log(`[sncf-fetcher] Collected trips for ${tripsByBotKey.size} IC Nuit lines`);

  // ── Build polylines ───────────────────────────────────────────────────────────
  const results = {};

  if (hasShapes && shapesRows.length > 0) {
    // Rare case: shapes.txt is present — use shape with the most points per route.
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
    for (const [botKey, trips] of tripsByBotKey) {
      // Pick the shape with the most points (longest/fullest route)
      let best = null;
      for (const { shape_id } of trips) {
        const coords = shapeCoords.get(shape_id);
        if (coords && (!best || coords.length > best.length)) best = coords;
      }
      if (best?.length >= 2) {
        results[botKey] = { polyline: polyline.encode(best), coordinateCount: best.length };
      }
    }
  } else {
    // Standard case: build from stop_times.txt ordered stop sequence.
    const stopTimesRows = files["stop_times.txt"] ? parseCsv(files["stop_times.txt"]) : [];
    console.log(`[sncf-fetcher] ${stopTimesRows.length} stop_times rows`);

    // Build stop coord map with parent-station fallback.
    // Some GTFS exports use child platform stops (no own lat/lon) that inherit
    // coordinates from a parent_station entry.
    const parentOf = new Map(); // child stop_id → parent stop_id
    const stopCoords = new Map(); // stop_id → [lat, lon]
    for (const row of stopsRows) {
      if (row.parent_station) parentOf.set(row.stop_id, row.parent_station);
      const lat = parseFloat(row.stop_lat);
      const lon = parseFloat(row.stop_lon);
      if (!isNaN(lat) && !isNaN(lon) && (lat !== 0 || lon !== 0)) {
        stopCoords.set(row.stop_id, [lat, lon]);
      }
    }
    for (const [childId, parentId] of parentOf) {
      if (!stopCoords.has(childId) && stopCoords.has(parentId)) {
        stopCoords.set(childId, stopCoords.get(parentId));
      }
    }

    // Collect all trip_ids we need to inspect
    const neededTripIds = new Set(
      Array.from(tripsByBotKey.values()).flatMap((trips) => trips.map((t) => t.trip_id))
    );

    const tripStops = new Map(); // trip_id → [{seq, stop_id}]
    for (const row of stopTimesRows) {
      const tid = row.trip_id;
      if (!neededTripIds.has(tid)) continue;
      if (!tripStops.has(tid)) tripStops.set(tid, []);
      tripStops.get(tid).push({ seq: parseInt(row.stop_sequence, 10), stop_id: row.stop_id });
    }

    for (const [botKey, trips] of tripsByBotKey) {
      // Select the trip that reaches the FARTHEST point from Paris Austerlitz.
      // "Most stops" is a wrong criterion: a short daytime service Paris→Toulouse
      // may have MORE intermediate stops than the night express Paris→Latour-de-Carol,
      // causing us to pick a trip that doesn't reach the terminal city.
      let bestTripStops = null;
      let bestDist = -1;
      for (const { trip_id } of trips) {
        const stops = tripStops.get(trip_id);
        if (!stops?.length) continue;
        const sorted = [...stops].sort((a, b) => a.seq - b.seq);
        // Check both endpoints (trip may be stored in either direction)
        for (const endpoint of [sorted[0], sorted[sorted.length - 1]]) {
          const coord = stopCoords.get(endpoint.stop_id);
          if (!coord) continue;
          const dist = haversineKm(coord, PARIS);
          if (dist > bestDist) { bestDist = dist; bestTripStops = sorted; }
        }
      }
      if (!bestTripStops) {
        console.warn(`[sncf-fetcher] No stop_times for ${botKey}`);
        continue;
      }
      const coords = bestTripStops.map((s) => stopCoords.get(s.stop_id)).filter(Boolean);
      if (coords.length >= 2) {
        results[botKey] = { polyline: polyline.encode(coords), coordinateCount: coords.length };
      }
    }
  }

  // ── Normalise direction + stitch split-train segments ─────────────────────
  // Some IC Nuit trains split at Toulouse: IC 3750 owns Paris→Toulouse in GTFS,
  // IC 3970 owns only Toulouse→Latour-de-Carol. We must prepend IC 3750's
  // polyline to IC 3970's to get the full Paris→Latour-de-Carol route.
  //
  // Pass 1: normalise all polylines so index 0 = the Paris end (the end closer
  //         to Paris Austerlitz). This makes the direction consistent for stitching.
  // Pass 2: any route that still doesn't start near Paris gets a prefix prepended
  //         from the neighbour whose last point is closest to its first point.

  // Decode all built polylines so we can measure distances
  const decodedCoords = new Map(); // botKey → [[lat, lon], ...]
  for (const [key, val] of Object.entries(results)) {
    decodedCoords.set(key, polyline.decode(val.polyline));
  }

  // Pass 1 — normalise direction
  for (const [botKey, coords] of decodedCoords) {
    const startDist = haversineKm(coords[0], PARIS);
    const endDist   = haversineKm(coords[coords.length - 1], PARIS);
    if (endDist < startDist) {
      const reversed = [...coords].reverse();
      results[botKey] = { polyline: polyline.encode(reversed), coordinateCount: reversed.length };
      decodedCoords.set(botKey, reversed);
      console.log(`[sncf-fetcher] Reversed direction for ${botKey}`);
    }
  }

  // Pass 2 — stitch: process in order of distance-from-Paris so that a stitched
  // result (Paris→Toulouse) is ready before it's needed as a prefix for
  // Paris→Toulouse→Latour-de-Carol.
  const sortedKeys = Array.from(decodedCoords.keys()).sort((a, b) =>
    haversineKm(decodedCoords.get(a)[0], PARIS) - haversineKm(decodedCoords.get(b)[0], PARIS)
  );

  for (const botKey of sortedKeys) {
    const coords = decodedCoords.get(botKey);
    if (haversineKm(coords[0], PARIS) <= PARIS_KM) continue; // already starts near Paris

    // Find the neighbour whose last point is closest to this route's first point
    let bestPrefix = null;
    let bestDist = STITCH_KM;
    for (const [otherKey, otherCoords] of decodedCoords) {
      if (otherKey === botKey) continue;
      const dist = haversineKm(otherCoords[otherCoords.length - 1], coords[0]);
      if (dist < bestDist) { bestDist = dist; bestPrefix = otherCoords; }
    }

    if (bestPrefix) {
      const combined = [...bestPrefix, ...coords];
      results[botKey] = { polyline: polyline.encode(combined), coordinateCount: combined.length };
      decodedCoords.set(botKey, combined); // allow this to serve as prefix for further routes
      console.log(`[sncf-fetcher] Stitched ${botKey}: prepended ${bestPrefix.length}-pt prefix (total ${combined.length} stops)`);
    } else {
      console.warn(`[sncf-fetcher] ${botKey} starts ${Math.round(haversineKm(coords[0], PARIS))}km from Paris — no matching prefix found`);
    }
  }

  // Mirror each result to the altKey so initial-data can match on trip_short_name_1 too.
  for (const routeDef of IC_NUIT_ROUTES) {
    if (results[routeDef.key] && routeDef.altKey && !results[routeDef.altKey]) {
      results[routeDef.altKey] = results[routeDef.key];
    }
  }

  console.log(`[sncf-fetcher] Produced polylines for: ${Object.keys(results).join(", ")}`);
  return results;
}

/**
 * Diagnostic snapshot — used by /api/seed-sncf?debug=1. Does NOT store anything.
 */
export async function inspectSNCFGtfs() {
  const { files, usedUrl } = await downloadGtfs();
  const routesRows = files["routes.txt"] ? parseCsv(files["routes.txt"]) : [];
  const tripsRows  = files["trips.txt"]  ? parseCsv(files["trips.txt"])  : [];

  // Show ALL routes — there are only ~34 so it fits in one response
  const parisRoutes = routesRows.filter((r) => norm(r.route_long_name).includes("paris"));
  const matchedRoutes = parisRoutes.filter((r) => {
    const n = norm(r.route_long_name);
    return IC_NUIT_ROUTES.some((def) => def.cities.some((c) => n.includes(norm(c))));
  });
  const unmatchedParisRoutes = parisRoutes.filter((r) => !matchedRoutes.includes(r));

  return {
    usedUrl,
    files: Object.keys(files),
    routeCount: routesRows.length,
    tripCount: tripsRows.length,
    matchedRoutes,
    unmatchedParisRoutes,
    allRoutes: routesRows,
  };
}
