// scripts/scrape-data.mjs
// Standalone scraper: fetches Back-on-Track, NightJet/EuroNight, Czech Railways,
// and OSM relation geometries, then writes them to public/data/scraped/.
// Run with: node scripts/scrape-data.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import polyline from "@mapbox/polyline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "public", "data", "scraped");

const BASE_URL =
  "https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OSM_RELATION_IDS = ["18616102", "3779843", "8737075"];

const FETCH_TIMEOUT_MS = 15_000;

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

// ─── Helpers ──────────────────────────────────────────────────────────────

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id),
  );
}

function write(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify({ uploadedAt: new Date().toISOString(), data }),
  );
  console.log(`[scrape] wrote ${filename}`);
}

// ─── Back-on-Track ─────────────────────────────────────────────────────────

async function fetchBackontrack(type) {
  const res = await fetch(`${BASE_URL}/${type}.json`, {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${type}: ${res.status}`);
  return res.json();
}

// ─── OSM / Overpass ────────────────────────────────────────────────────────

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

// ─── NightJet / EuroNight ─────────────────────────────────────────────────

function normalizeNJTrain(data, date, operator = "Nightjet") {
  const stops = Array.isArray(data?.route?.stops) ? data.route.stops : [];
  const stations = stops
    .map((s) => {
      const [lat, lon] = s?.station?.coords || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const name =
        s?.station?.name?.de || s?.station?.name?.int || s?.station?.name?.en;
      return {
        id: s?.station?.eva || s?.station?.evaMeta || null,
        name,
        location: { latitude: lat, longitude: lon },
        arrival: s?.arr ? new Date(s.arr).toISOString() : null,
        departure: s?.dep ? new Date(s.dep).toISOString() : null,
        pickup: !!s?.pickup,
        dropoff: !!s?.dropoff,
      };
    })
    .filter(Boolean);

  return {
    lineName: data?.trainNumber,
    operator,
    date,
    stations,
    polyline: data?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source: "nightjet-com",
  };
}

async function fetchSingleTrain(trainNumber, date) {
  const encoded = encodeURIComponent(trainNumber);
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encoded}/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[nj] upstream ${res.status} for ${trainNumber}`);
      return null;
    }
    const data = await res.json();
    if (!data?.route?.stops?.length) return null;
    const operator = data.partnerTrain ? "EuroNight" : "Nightjet";
    return normalizeNJTrain(data, date, operator);
  } catch (e) {
    console.warn(`[nj] fetch failed for ${trainNumber}: ${e.message}`);
    return null;
  }
}

async function fetchNJTrainNumbers(date) {
  const NJ_COUNTRIES = [80, 81, 83, 84, 85, 88];
  const pairs = [];
  for (const from of NJ_COUNTRIES)
    for (const to of NJ_COUNTRIES) pairs.push([from, to]);

  const njNumbers = new Set();
  await Promise.all(
    pairs.map(async ([from, to]) => {
      const url = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`;
      try {
        const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const trains = await res.json();
        if (!Array.isArray(trains)) return;
        trains.forEach((t) => {
          if (t?.trainNumber && !t.partnerTrain) njNumbers.add(t.trainNumber);
        });
      } catch (e) {
        console.warn(`[nj] country ${from}/${to} failed: ${e.message}`);
      }
    }),
  );
  return Array.from(njNumbers);
}

async function fetchPartnerTrainNumbers(date, max = 25) {
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((t) => t?.trainNumber).filter(Boolean).slice(0, max);
  } catch (e) {
    console.warn(`[nj] partner fetch failed: ${e.message}`);
    return [];
  }
}

// ─── Czech Railways ────────────────────────────────────────────────────────

function extractTrainNumbers(trips, prefix) {
  if (!trips || typeof trips !== "object") return [];
  const seen = new Set();
  const re = new RegExp(`^\\s*${prefix}\\s+(\\d+)`, "i");
  for (const trip of Object.values(trips)) {
    const name = (trip.trip_short_name || "").toString().trim();
    const match = name.match(re);
    if (match) seen.add(match[1]);
  }
  return Array.from(seen);
}

function parseCDTrainHTML(html, trainNumber, trainType) {
  const strategies = [
    () => {
      const m = html.match(/var\s+model\s*=\s*([\s\S]+?);\s*new\s+TrainDetail/);
      if (m) {
        const model = JSON.parse(m[1]);
        return model?.trainDetailTimetable?.route;
      }
    },
    () => {
      const m = html.match(/"trainDetailTimetable"\s*:\s*\{[^}]*"route"\s*:\s*(\[[\s\S]+?\])\s*\}/);
      if (m) return JSON.parse(m[1]);
    },
    () => {
      const m = html.match(/trainDetailTimetable\s*:\s*\{[^}]*route\s*:\s*(\[[\s\S]+?\])\s*\}/);
      if (m) return JSON.parse(m[1]);
    },
  ];

  for (const strategy of strategies) {
    try {
      const route = strategy();
      if (Array.isArray(route) && route.length > 0) {
        const stops = route
          .map((s) => ({ name: s.name || s.stationName || null, arrival: s.timeArr || null, departure: s.timeDep || null }))
          .filter((s) => s.name);
        if (stops.length > 0) {
          return { trainNumber: String(trainNumber), trainLabel: `${trainType} ${trainNumber}`, fetchedAt: new Date().toISOString(), stops };
        }
      }
    } catch {
      // try next strategy
    }
  }
  return null;
}

async function fetchCDTrain(trainNumber, trainType = "EC") {
  const url = `https://www.cd.cz/en/vlak/${trainNumber}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "train-map/1.0 (timetable-display)", Accept: "text/html" },
    });
    if (!res.ok) {
      console.warn(`[cd] HTTP ${res.status} for ${trainType} ${trainNumber}`);
      return null;
    }
    const html = await res.text();
    const result = parseCDTrainHTML(html, trainNumber, trainType);
    if (!result) console.warn(`[cd] parse failed for ${trainType} ${trainNumber}`);
    return result;
  } catch (e) {
    console.warn(`[cd] fetch failed for ${trainType} ${trainNumber}: ${e.message}`);
    return null;
  }
}

// ─── Chinese Railways ─────────────────────────────────────────────────────

function buildChineseTrains() {
  const configPath = path.join(__dirname, "chinese-routes-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const trains = {};

  for (const route of config) {
    const stations = route.stations.map((s) => ({
      name: s.name,
      location: { latitude: s.lat, longitude: s.lon },
      arrival: null,
      departure: null,
      pickup: true,
      dropoff: true,
    }));
    const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
    if (positions.length < 2) continue;

    const encoded = polyline.encode(positions);
    trains[route.lineName] = { lineName: route.lineName, operator: route.operator, polyline: encoded, stations };

    if (route.returnLineName) {
      const reversed = [...stations].reverse();
      const revPositions = reversed.map((s) => [s.location.latitude, s.location.longitude]);
      trains[route.returnLineName] = {
        lineName: route.returnLineName,
        operator: route.operator,
        polyline: polyline.encode(revPositions),
        stations: reversed,
      };
    }
  }

  return trains;
}

// ─── Italian Railways (Trenitalia ICN) — Viaggiatreno API ─────────────────

const VIAGGIATRENO_BASE = "http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";

async function fetchItalianTrain(trainNumber) {
  let autoText;
  try {
    const autoRes = await fetchWithTimeout(
      `${VIAGGIATRENO_BASE}/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`,
      { headers: { "User-Agent": "train-map/1.0" } },
    );
    if (!autoRes.ok) return null;
    autoText = await autoRes.text();
  } catch {
    return null;
  }

  // Parse: "795 - TORINO PORTA NUOVA - 18/05/26|795-S00219-1779055200000\n..."
  const entries = autoText.trim().split("\n").filter(Boolean).map((line) => {
    const pipeIdx = line.indexOf("|");
    if (pipeIdx === -1) return null;
    const key = line.slice(pipeIdx + 1).trim();
    const parts = key.split("-");
    if (parts.length < 3) return null;
    const stationCode = parts[1];
    const timestamp = parseInt(parts[2], 10);
    if (!stationCode || !Number.isFinite(timestamp)) return null;
    return { stationCode, timestamp };
  }).filter(Boolean);

  if (!entries.length) return null;

  // Fetch all sections; keep only ICN category, pick the one with most stops
  let best = null;
  for (const { stationCode, timestamp } of entries) {
    try {
      const res = await fetchWithTimeout(
        `${VIAGGIATRENO_BASE}/andamentoTreno/${stationCode}/${trainNumber}/${timestamp}`,
        { headers: { "User-Agent": "train-map/1.0", accept: "application/json" } },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.categoria !== "ICN") continue;
      const fermate = Array.isArray(data?.fermate) ? data.fermate : [];
      if (fermate.length < 2) continue;
      if (!best || fermate.length > best.fermate.length) {
        best = { data, fermate };
      }
    } catch {
      continue;
    }
  }

  if (!best) return null;

  const stationCodes = [...new Set(best.fermate.map((s) => s.id).filter(Boolean))];
  return { trainNumber, fermate: best.fermate, stationCodes };
}

async function fetchStationCoords(codes) {
  const coordMap = new Map();
  const CONCURRENCY = 10;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (code) => {
      try {
        const res = await fetchWithTimeout(
          `${VIAGGIATRENO_BASE}/dettaglioStazione/${code}/0`,
          { headers: { "User-Agent": "train-map/1.0" } },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Number.isFinite(data?.lat) && Number.isFinite(data?.lon)) {
          coordMap.set(code, { lat: data.lat, lon: data.lon });
        }
      } catch { /* skip */ }
    }));
  }
  return coordMap;
}

async function buildItalianTrains() {
  const configPath = path.join(__dirname, "italian-trains-config.json");
  const trainNumbers = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // Fetch all trains concurrently in batches
  const CONCURRENCY = 4;
  const rawTrains = [];
  for (let i = 0; i < trainNumbers.length; i += CONCURRENCY) {
    const batch = trainNumbers.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(batch.map((n) => fetchItalianTrain(n)));
    fetched.forEach((t, idx) => {
      if (t) rawTrains.push(t);
      else console.warn(`[icn] no ICN data for train ${batch[idx]}`);
    });
  }

  // Collect all unique station codes and batch-fetch coordinates
  const allCodes = [...new Set(rawTrains.flatMap((t) => t.stationCodes))];
  console.log(`[icn] fetching coordinates for ${allCodes.length} unique stations`);
  const coordMap = await fetchStationCoords(allCodes);

  // Build normalized trains
  const trains = {};
  for (const { trainNumber, fermate } of rawTrains) {
    const stations = fermate.map((s) => {
      const coords = coordMap.get(s.id);
      if (!coords) return null;
      return {
        name: titleCase(s.stazione),
        location: { latitude: coords.lat, longitude: coords.lon },
        arrival: s.arrivo_teorico ? new Date(s.arrivo_teorico).toISOString() : null,
        departure: s.partenza_teorica ? new Date(s.partenza_teorica).toISOString() : null,
      };
    }).filter(Boolean);

    if (stations.length < 2) {
      console.warn(`[icn] ICN ${trainNumber}: too few stations with coords (${stations.length})`);
      continue;
    }

    const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
    const lineName = `ICN ${trainNumber}`;
    trains[lineName] = {
      lineName,
      operator: "Trenitalia",
      polyline: polyline.encode(positions),
      stations,
    };
    console.log(`[icn] built ${lineName}: ${stations[0].name} → ${stations[stations.length - 1].name} (${stations.length} stops)`);
  }

  return trains;
}

function titleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/(?:^|\s|[-'(])(\p{L})/gu, (_, c) => _.slice(0, -1) + c.toUpperCase());
}

// ─── Georgian Railway international trains (scraped from railway.ge) ──────

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

async function fetchGRInternationalTrains() {
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

  // Strip scripts/styles, decode common HTML entities, tokenise by line
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&#8211;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const tokens = text.split("\n").map((s) => s.trim()).filter(Boolean);
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

// ─── Caucasus Railways (Georgian Railway, ADY, South Caucasus Railway) ───

function buildCaucasusTrains() {
  const configPath = path.join(__dirname, "caucasus-routes-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const trains = {};

  for (const route of config) {
    const stations = route.stations.map((s) => ({
      name: s.name,
      location: { latitude: s.lat, longitude: s.lon },
      arrival: null,
      departure: null,
      pickup: true,
      dropoff: true,
    }));
    const positions = stations.map((s) => [s.location.latitude, s.location.longitude]);
    if (positions.length < 2) continue;

    const encoded = polyline.encode(positions);
    trains[route.lineName] = {
      lineName: route.lineName,
      operator: route.operator,
      agency_id: route.agency_id,
      frequency: route.frequency || null,
      polyline: encoded,
      stations,
    };

    if (route.returnLineName) {
      const reversed = [...stations].reverse();
      const revPositions = reversed.map((s) => [s.location.latitude, s.location.longitude]);
      trains[route.returnLineName] = {
        lineName: route.returnLineName,
        operator: route.operator,
        agency_id: route.agency_id,
        frequency: route.frequency || null,
        polyline: polyline.encode(revPositions),
        stations: reversed,
      };
    }
  }

  return trains;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[scrape] starting — date: ${today}`);

  // Back-on-Track
  const [stops, view_ontd_map, trips] = await Promise.all([
    fetchBackontrack("stops"),
    fetchBackontrack("view_ontd_map"),
    fetchBackontrack("trips"),
  ]);
  write("backontrack-stops.json", stops);
  write("backontrack-trips.json", trips);

  // OSM relations
  for (const id of OSM_RELATION_IDS) {
    try {
      const data = await fetchOsmRelation([id]);
      write(`osm-${id}.json`, data);
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error(`[scrape] OSM ${id} failed: ${err.message}`);
    }
  }

  // NightJet / EuroNight
  let results = {};
  try {
    const [njNumbers, enNumbers] = await Promise.all([
      fetchNJTrainNumbers(today),
      fetchPartnerTrainNumbers(today),
    ]);
    const allNumbers = [...new Set([...njNumbers, ...enNumbers])];
    console.log(`[scrape] fetching ${allNumbers.length} NJ/EN trains`);

    const CONCURRENCY = 6;
    for (let i = 0; i < allNumbers.length; i += CONCURRENCY) {
      const batch = allNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchSingleTrain(n, today)));
      fetched.forEach((train) => {
        if (!train) return;
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

    write("nightjet-trains.json", { uploadedAt: today, trains: results });
    console.log(`[scrape] stored ${Object.keys(results).length} NJ/EN trains`);

    // Merge NJ polylines into view_ontd_map
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
    console.error("[scrape] NightJet scrape failed:", err.message);
  }

  // Synthetic routes for NJ trains not in Back-on-Track
  const botMatchedNJNumbers = new Set();
  Object.values(view_ontd_map).forEach((route) => {
    [route.trip_short_name_0, route.trip_short_name_1]
      .filter(Boolean)
      .forEach((n) => botMatchedNJNumbers.add(n.trim()));
  });

  const unmatchedNJ = Object.entries(results).filter(
    ([lineName, data]) =>
      !botMatchedNJNumbers.has(lineName) && data.polyline && data.stations?.length >= 2,
  );

  const syntheticPaired = new Set();
  unmatchedNJ.forEach(([lineName, data]) => {
    if (syntheticPaired.has(lineName)) return;

    const origin = data.stations[0].name;
    const dest = data.stations[data.stations.length - 1].name;

    const reversePair = unmatchedNJ.find(
      ([k, v]) =>
        k !== lineName &&
        !syntheticPaired.has(k) &&
        v.stations?.[0]?.name === dest &&
        v.stations?.[v.stations.length - 1]?.name === origin,
    );

    const safeId = lineName.replace(/\s+/g, "_");
    const entry = {
      route_id: `nj_standalone_${safeId}`,
      agency_id: "ÖBB",
      trip_short_name_0: lineName,
      origin_trip_0: origin,
      destination_trip_0: dest,
      via_0: data.stations.slice(1, -1).map((s) => s.name).join(" - "),
      route_long_name: `${origin} – ${dest}`,
      nj_polyline: data.polyline,
      is_active: "Y",
    };

    if (reversePair) {
      const [revName, revData] = reversePair;
      entry.trip_short_name_1 = revName;
      entry.origin_trip_1 = revData.stations[0].name;
      entry.destination_trip_1 = revData.stations[revData.stations.length - 1].name;
      entry.via_1 = revData.stations.slice(1, -1).map((s) => s.name).join(" - ");
      syntheticPaired.add(revName);
    }

    syntheticPaired.add(lineName);
    view_ontd_map[entry.route_id] = entry;
    console.log(`[scrape] synthetic route: ${entry.route_id} (${origin} – ${dest})`);
  });

  write("backontrack-view_ontd_map.json", view_ontd_map);

  // Czech Railways
  try {
    const ecNumbers = extractTrainNumbers(trips, "EC");
    const enNumbers = extractTrainNumbers(trips, "EN");
    const CONCURRENCY = 6;
    const cdResults = {};

    for (let i = 0; i < ecNumbers.length; i += CONCURRENCY) {
      const batch = ecNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchCDTrain(n, "EC")));
      fetched.forEach((train) => { if (train) cdResults[train.trainNumber] = train; });
    }
    for (let i = 0; i < enNumbers.length; i += CONCURRENCY) {
      const batch = enNumbers.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(batch.map((n) => fetchCDTrain(n, "EN")));
      fetched.forEach((train) => { if (train) cdResults[train.trainNumber] = train; });
    }

    write("cd-trains.json", { uploadedAt: today, trains: cdResults });
    console.log(`[scrape] stored ${Object.keys(cdResults).length} CD trains`);
  } catch (err) {
    errors.push({ source: "cd", error: err.message });
    console.error("[scrape] CD scrape failed:", err.message);
  }

  // Chinese Railways (static curated config — no network request needed)
  try {
    const crResults = buildChineseTrains();
    write("chinese-trains.json", { uploadedAt: today, trains: crResults });
    console.log(`[scrape] stored ${Object.keys(crResults).length} CR trains`);
  } catch (err) {
    errors.push({ source: "chinese", error: err.message });
    console.error("[scrape] Chinese Railways build failed:", err.message);
  }

  // Italian Railways (Trenitalia ICN) — Viaggiatreno API
  try {
    const itResults = await buildItalianTrains();
    write("italian-trains.json", { uploadedAt: today, trains: itResults });
    console.log(`[scrape] stored ${Object.keys(itResults).length} Italian ICN trains`);
  } catch (err) {
    errors.push({ source: "italian", error: err.message });
    console.error("[scrape] Italian ICN scrape failed:", err.message);
  }

  // Caucasus Railways — static config merged with live data from railway.ge
  try {
    const staticTrains = buildCaucasusTrains();
    const grScraped = await fetchGRInternationalTrains();
    const caucasusResults = { ...staticTrains, ...grScraped };
    write("caucasus-trains.json", { uploadedAt: today, trains: caucasusResults });
    console.log(`[scrape] stored ${Object.keys(caucasusResults).length} Caucasus trains`);
  } catch (err) {
    errors.push({ source: "caucasus", error: err.message });
    console.error("[scrape] Caucasus build failed:", err.message);
  }

  console.log(`[scrape] done. errors: ${errors.length}`);
  if (errors.length) console.error("[scrape] errors:", errors);
}

main().catch((err) => {
  console.error("[scrape] fatal:", err);
  process.exit(1);
});
