// scripts/adapters/railway-ge.mjs
// Georgian Railway international trains (#371/#372 Tbilisi–Yerevan) scraped
// from railway.ge. Station coordinates resolved from OSM Overpass with a
// hardcoded per-station fallback. Used by the caucasus adapter; not registered
// as a standalone source.

import { execSync } from "node:child_process";
import polyline from "@mapbox/polyline";
import { fetchWithTimeout, OVERPASS_ENDPOINTS } from "../lib/scrape-helpers.mjs";
import { htmlToText } from "../lib/html-text.mjs";

// Fallback coords for stations the Overpass query may miss.
// Keyed by lowercase station name as it appears on railway.ge.
const GR_STATION_COORDS_FALLBACK = {
  "tbilisi - passenger station": { lat: 41.7211, lon: 44.7997 },
  "tbilisi-junction station":    { lat: 41.7148, lon: 44.8070 },
  "ponichala":                   { lat: 41.6461, lon: 44.9071 },
  "marabda":                     { lat: 41.5463, lon: 44.8032 },
  "marneuli":                    { lat: 41.4817, lon: 44.8118 },
  "shulaveri":                   { lat: 41.3692, lon: 44.8420 },
  "sadakhlo":                    { lat: 41.2453, lon: 44.8078 },
  "airum":                       { lat: 41.1095, lon: 44.8736 },
  "sanain":                      { lat: 41.1780, lon: 44.6993 },
  "shagal":                      { lat: 41.0860, lon: 44.5537 },
  "pampak":                      { lat: 40.9943, lon: 44.6219 },
  "vanadzor":                    { lat: 40.8093, lon: 44.4884 },
  "giumr":                       { lat: 40.7921, lon: 43.8487 },
  "gyumri":                      { lat: 40.7921, lon: 43.8487 },
  "armavir":                     { lat: 40.1542, lon: 44.0382 },
  "yerevan":                     { lat: 40.1554, lon: 44.5078 },
};

// Resolve station coordinates from OSM Overpass for the Georgia/Armenia/Azerbaijan region.
// Falls back to GR_STATION_COORDS_FALLBACK per-station when OSM has no match.
async function resolveGRStationCoords(stationNames) {
  const overpassQuery = `
    [out:json][timeout:30];
    (
      node["railway"="station"](38,40,44,51);
      node["railway"="halt"](38,40,44,51);
      node["railway"="stop"](38,40,44,51);
    );
    out body;
  `;

  let osmNodes = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: overpassQuery,
      });
      if (res.ok) {
        osmNodes = (await res.json()).elements;
        break;
      }
    } catch { /* try next endpoint */ }
  }

  if (!osmNodes) {
    console.warn("[gr] Overpass failed — using hardcoded station coords");
    return { ...GR_STATION_COORDS_FALLBACK };
  }

  // Build index: normalised name → {lat, lon}
  const index = new Map();
  for (const node of osmNodes) {
    const tags = node.tags || {};
    for (const tag of ["name:en", "name", "alt_name"]) {
      if (tags[tag]) index.set(tags[tag].toLowerCase().trim(), { lat: node.lat, lon: node.lon });
    }
  }

  const result = {};
  for (const rawName of stationNames) {
    const key = rawName.toLowerCase().replace(/\s+/g, " ").trim();
    if (index.has(key)) {
      result[key] = index.get(key);
      continue;
    }
    // Partial match: OSM name contains the key or key contains OSM name
    let found = null;
    for (const [osmKey, coords] of index) {
      if (osmKey.includes(key) || key.includes(osmKey)) { found = coords; break; }
    }
    if (found) {
      result[key] = found;
    } else {
      const fallback = GR_STATION_COORDS_FALLBACK[key];
      if (fallback) result[key] = fallback;
      else console.warn(`[gr] no coords found for station: "${rawName}"`);
    }
  }

  console.log(`[gr] resolved ${Object.keys(result).length}/${stationNames.length} station coords from OSM`);
  return result;
}

export async function fetchGRInternationalTrains() {
  const url = "https://www.railway.ge/en/passenger-traffic/international-trains/";
  let html;
  try {
    // Use curl — Node.js TLS rejects railway.ge's cert chain; curl uses system CA bundle
    html = execSync(`curl -sL --max-time 20 "${url}"`, { timeout: 25000 }).toString();
    if (!html || html.length < 1000) throw new Error("empty or truncated response");
  } catch (e) {
    console.warn(`[gr] fetch failed: ${e.message}`);
    return {};
  }

  // Strip to readable text and tokenise by line (shared helper).
  const tokens = htmlToText(html).split("\n");
  const trains = {};

  // Table header pattern: Arrival / Stopping time / Departure (repeated twice)
  const headerIdx = tokens.findIndex(
    (t, i) =>
      t === "Arrival" &&
      tokens[i + 1] === "Stopping time" &&
      tokens[i + 2] === "Departure",
  );
  if (headerIdx === -1) {
    console.warn("[gr] timetable header not found — skipping international scrape");
    return trains;
  }

  // Pass 1: collect raw station names so we can batch-resolve coords via OSM
  const rawStationNames = [];
  {
    let j = headerIdx + 6;
    while (j + 6 < tokens.length) {
      if (!/^[\d:_–\-]+$/.test(tokens[j])) { j++; continue; }
      const name = tokens[j + 3];
      if (name) rawStationNames.push(name);
      j += 7;
    }
  }

  const coordMap = await resolveGRStationCoords(rawStationNames);

  // Pass 2: build station objects using the resolved coord map
  // Row format: arr371, stopTime371, dep371, stationName, arr372, stopTime372, dep372
  // Terminus values are "_" (no arrival at origin, no departure at destination)
  let i = headerIdx + 6;
  const stationsFwd = []; // #371 Tbilisi → Yerevan
  const stationsRev = []; // #372 Yerevan → Tbilisi

  while (i + 6 < tokens.length) {
    const t0 = tokens[i];
    // Detect section dividers (e.g. "Armenian Railway") — not a time-like token
    if (!/^[\d:_–\-]+$/.test(t0)) { i++; continue; }

    const arr371 = tokens[i];
    const dep371 = tokens[i + 2];
    const stationName = tokens[i + 3];
    const arr372 = tokens[i + 4];
    const dep372 = tokens[i + 6];
    i += 7;

    if (!stationName) continue;
    const key = stationName.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.includes("junction")) continue; // skip technical junction stop near Tbilisi
    const coords = coordMap[key];
    if (!coords) {
      console.warn(`[gr] no coords for: "${stationName}"`);
      continue;
    }

    const displayName = key === "tbilisi - passenger station" ? "Tbilisi" : stationName;

    const toTime = (t) => (t && t !== "_" && t !== "-" && t !== "–" ? t : null);
    const a371 = toTime(arr371);
    const d371 = toTime(dep371);
    const a372 = toTime(arr372);
    const d372 = toTime(dep372);

    stationsFwd.push({
      name: displayName,
      location: { latitude: coords.lat, longitude: coords.lon },
      arrival: a371 !== d371 ? a371 : null,
      departure: d371,
      pickup: true,
      dropoff: true,
    });
    stationsRev.push({
      name: displayName,
      location: { latitude: coords.lat, longitude: coords.lon },
      arrival: a372 !== d372 ? a372 : null,
      departure: d372,
      pickup: true,
      dropoff: true,
    });
  }

  if (stationsFwd.length >= 2) {
    const fwdPos = stationsFwd.map((s) => [s.location.latitude, s.location.longitude]);
    trains["GR 371"] = {
      lineName: "GR 371",
      operator: "Georgian Railway / South Caucasus Railway",
      agency_id: "SCR",
      frequency: "Mon, Wed, Fri, Sun",
      polyline: polyline.encode(fwdPos),
      stations: stationsFwd,
    };
  }
  if (stationsRev.length >= 2) {
    const revStations = [...stationsRev].reverse();
    const revPos = revStations.map((s) => [s.location.latitude, s.location.longitude]);
    trains["GR 372"] = {
      lineName: "GR 372",
      operator: "Georgian Railway / South Caucasus Railway",
      agency_id: "SCR",
      frequency: "Mon, Wed, Fri, Sun",
      polyline: polyline.encode(revPos),
      stations: revStations,
    };
  }

  console.log(`[gr] scraped ${Object.keys(trains).length} international trains from railway.ge`);
  return trains;
}
