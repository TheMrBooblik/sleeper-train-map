// scripts/scrape-data.mjs
// Standalone scraper: fetches Back-on-Track, NightJet/EuroNight, Czech Railways,
// and OSM relation geometries, then writes them to public/data/scraped/.
// Run with: node scripts/scrape-data.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// ─── Italian Railways ─────────────────────────────────────────────────────

function extractFSTrainNumbers(trips) {
  const seen = new Set();
  const re = /\bIC\s+Notte\s+(\d+)/i;
  for (const trip of Object.values(trips ?? {})) {
    if (trip?.agency_id !== "FS") continue;
    const m = (trip.trip_short_name || "").match(re);
    if (m) seen.add(m[1]);
  }
  return Array.from(seen);
}

async function fetchViaggiatrenoTrain(trainNumber, dateMs) {
  try {
    const autoUrl = `https://www.viaggiatreno.it/viaggiatreno/rest/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`;
    const autoRes = await fetchWithTimeout(autoUrl, {
      headers: { "User-Agent": "train-map/1.0", Accept: "text/plain" },
    });
    if (!autoRes.ok) {
      console.warn(`[it] autocomplete ${autoRes.status} for ${trainNumber}`);
      return null;
    }
    const text = await autoRes.text();
    const firstLine = text.trim().split("\n")[0];
    const originId = firstLine.split("|")[1]?.trim();
    if (!originId) {
      console.warn(`[it] no origin ID for ${trainNumber}`);
      return null;
    }

    const trainUrl = `https://www.viaggiatreno.it/viaggiatreno/rest/andamentoTreno/${originId}/${trainNumber}/${dateMs}`;
    const trainRes = await fetchWithTimeout(trainUrl, {
      headers: { "User-Agent": "train-map/1.0", Accept: "application/json" },
    });
    if (!trainRes.ok) {
      console.warn(`[it] train ${trainRes.status} for IC Notte ${trainNumber}`);
      return null;
    }
    const data = await trainRes.json();
    const fermate = Array.isArray(data?.fermate) ? data.fermate : [];
    const stations = fermate
      .filter((f) => f.lat && f.lng && f.lat !== 0 && f.lng !== 0)
      .map((f) => ({
        name: f.stazione,
        location: { latitude: f.lat, longitude: f.lng },
        arrival: f.programmataArrivo ?? null,
        departure: f.programmataPartenza ?? null,
        pickup: true,
        dropoff: true,
      }));
    if (stations.length < 2) {
      console.warn(`[it] too few stops for IC Notte ${trainNumber}`);
      return null;
    }
    return { lineName: `IC Notte ${trainNumber}`, stations };
  } catch (e) {
    console.warn(`[it] fetch failed for IC Notte ${trainNumber}: ${e.message}`);
    return null;
  }
}

async function fetchItalianRailwayNetwork() {
  const query = `
    [out:json][timeout:90];
    (way["railway"="rail"](35.5,6.7,47.1,18.5););
    (._;>);
    out;
  `;
  let response = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "train-map/1.0" },
        body: query,
      });
      if (response.ok) break;
    } catch {
      // try next endpoint
    }
  }
  if (!response?.ok) throw new Error("All Overpass endpoints failed for Italian railway network");
  return response.json();
}

function buildRailwayGraph(elements) {
  const nodes = new Map();
  const adj = new Map();
  const grid = new Map();

  for (const el of elements) {
    if (el.type === "node") {
      nodes.set(el.id, { lat: el.lat, lon: el.lon });
      adj.set(el.id, new Set());
      const cellKey = `${(el.lat / 0.05) | 0},${(el.lon / 0.05) | 0}`;
      if (!grid.has(cellKey)) grid.set(cellKey, []);
      grid.get(cellKey).push(el.id);
    }
  }
  for (const el of elements) {
    if (el.type === "way" && Array.isArray(el.nodes)) {
      for (let i = 0; i < el.nodes.length - 1; i++) {
        const a = el.nodes[i];
        const b = el.nodes[i + 1];
        if (adj.has(a) && adj.has(b)) {
          adj.get(a).add(b);
          adj.get(b).add(a);
        }
      }
    }
  }
  return { nodes, adj, grid };
}

function nearestNode(graph, lat, lon) {
  const { nodes, grid } = graph;
  const baseR = (lat / 0.05) | 0;
  const baseC = (lon / 0.05) | 0;
  let best = null;
  let bestDist = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const cell = grid.get(`${baseR + dr},${baseC + dc}`);
      if (!cell) continue;
      for (const id of cell) {
        const n = nodes.get(id);
        const d = (n.lat - lat) ** 2 + (n.lon - lon) ** 2;
        if (d < bestDist) { bestDist = d; best = id; }
      }
    }
  }
  return best;
}

function routeSegment(graph, fromCoord, toCoord) {
  const { nodes, adj } = graph;
  const startId = nearestNode(graph, fromCoord[0], fromCoord[1]);
  const endId = nearestNode(graph, toCoord[0], toCoord[1]);
  if (!startId || !endId || startId === endId) return null;

  const prev = new Map([[startId, null]]);
  const queue = [startId];
  let found = false;
  let visited = 0;
  const MAX_VISITED = 5000;

  outer: while (queue.length > 0) {
    const curr = queue.shift();
    for (const nb of (adj.get(curr) || [])) {
      if (!prev.has(nb)) {
        prev.set(nb, curr);
        if (nb === endId) { found = true; break outer; }
        if (++visited >= MAX_VISITED) break outer;
        queue.push(nb);
      }
    }
  }
  if (!found) return null;

  const path = [];
  let cur = endId;
  while (cur !== null) {
    const n = nodes.get(cur);
    path.push([n.lat, n.lon]);
    cur = prev.get(cur);
  }
  path.reverse();
  return path;
}

function buildTrackPolyline(graph, stationCoords) {
  const result = [];
  for (let i = 0; i < stationCoords.length - 1; i++) {
    const seg = routeSegment(graph, stationCoords[i], stationCoords[i + 1]);
    const points = seg ?? [stationCoords[i], stationCoords[i + 1]];
    for (const pt of points) {
      if (
        result.length === 0 ||
        result[result.length - 1][0] !== pt[0] ||
        result[result.length - 1][1] !== pt[1]
      ) {
        result.push(pt);
      }
    }
  }
  return result;
}

async function buildItalianTrains(trips, today) {
  const numbers = extractFSTrainNumbers(trips);
  const dateMs = new Date(today).getTime();
  console.log(`[it] fetching ${numbers.length} IC Notte trains from Viaggiatreno`);

  console.log("[it] fetching Italian railway network from Overpass...");
  const networkElements = await fetchItalianRailwayNetwork();
  console.log(`[it] building railway graph from ${networkElements.elements?.length ?? 0} elements`);
  const graph = buildRailwayGraph(networkElements.elements ?? []);

  const trains = {};
  const CONCURRENCY = 4;
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const batch = numbers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((n) => fetchViaggiatrenoTrain(n, dateMs)));
    results.forEach((train) => {
      if (!train) return;
      const coords = train.stations.map((s) => [s.location.latitude, s.location.longitude]);
      const trackCoords = buildTrackPolyline(graph, coords);
      trains[train.lineName] = {
        lineName: train.lineName,
        operator: "FS",
        polyline: polyline.encode(trackCoords),
        stations: train.stations,
      };
    });
  }
  return { uploadedAt: today, trains };
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

  // Italian Railways (IC Notte via Viaggiatreno + Overpass graph routing)
  try {
    const itResults = await buildItalianTrains(trips, today);
    write("italian-trains.json", itResults);
    console.log(`[scrape] stored ${Object.keys(itResults.trains).length} IT trains`);
  } catch (err) {
    errors.push({ source: "italian", error: err.message });
    console.error("[scrape] Italian Railways build failed:", err.message);
  }

  console.log(`[scrape] done. errors: ${errors.length}`);
  if (errors.length) console.error("[scrape] errors:", errors);
}

main().catch((err) => {
  console.error("[scrape] fatal:", err);
  process.exit(1);
});
