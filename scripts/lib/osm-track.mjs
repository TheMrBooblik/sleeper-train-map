// scripts/lib/osm-track.mjs
// OpenStreetMap's railway network for a country, from a committed cache
// refreshed weekly from Overpass one tile at a time. Thailand's `srt` and
// Vietnam's `vnr` sources route their trains along it (scripts/lib/rail-graph.mjs).
//
// Asked as tiles rather than one country-sized query: the first SRT branch run
// had both public Overpass servers refuse the whole bbox at once (502, 500),
// which a busy server does to a heavy query. Each tile keeps its own date, so
// a tile Overpass refuses tonight keeps last week's copy and is asked again
// tomorrow while the others refresh (track rarely moves); a tile never once
// answered leaves its corner to whatever the source falls back on. Ways are
// merged by id, as a way crossing a tile edge comes back whole in both.
//
// With `params.stations`, each tile also keeps the railway stations and halts
// OSM maps in it (name, Vietnamese/English names, position): Vietnam's
// timetable names its stations and carries no position, so this is where the
// positions come from (`loadOsmTrack(...).stations`).

import fs from "node:fs";
import path from "node:path";
import polyline from "@mapbox/polyline";
import { HONEST_USER_AGENT } from "./http-block.mjs";
import { trackFromOverpass } from "./rail-graph.mjs";
import { OVERPASS_ENDPOINTS } from "./scrape-helpers.mjs";

const TRACK_QUERY = (bbox) =>
  `[out:json][timeout:180];way["railway"="rail"][!"service"](${bbox.join(",")});out geom;`;
const TRACK_AND_STATIONS_QUERY = (bbox) =>
  `[out:json][timeout:180];(way["railway"="rail"][!"service"](${bbox.join(",")});node["railway"~"^(station|halt)$"](${bbox.join(",")}););out geom;`;
const MAX_AGE_DAYS = 7;
const TILE_DEG = 3;
const ATTEMPTS = 3;
const ENDPOINTS = [...OVERPASS_ENDPOINTS, "https://overpass.private.coffee/api/interpreter"];
// The whole refresh, every tile and retry: past it the cache (or the source's
// own fallback) draws tonight.
const BUDGET_MS = 20 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** [south, west, north, east] cut into equal tiles of at most `deg` degrees a side. */
export function bboxTiles([s, w, n, e], deg = TILE_DEG) {
  const rows = Math.max(1, Math.ceil((n - s) / deg - 1e-9));
  const cols = Math.max(1, Math.ceil((e - w) / deg - 1e-9));
  const r = (v) => Math.round(v * 1e4) / 1e4;
  const tiles = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      tiles.push([r(s + ((n - s) * i) / rows), r(w + ((e - w) * j) / cols), r(s + ((n - s) * (i + 1)) / rows), r(w + ((e - w) * (j + 1)) / cols)]);
    }
  }
  return tiles;
}

async function overpassTile(bbox, { query, fetchImpl, log, deadline = Infinity, retryMs = 10_000 }) {
  let last = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (Date.now() > deadline) throw new Error(`out of time (${last ?? "no answer"})`);
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    if (attempt) await sleep(retryMs * attempt);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": HONEST_USER_AGENT },
        body: query(bbox),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.elements)) throw new Error("no elements");
      return json.elements;
    } catch (err) {
      last = `${new URL(url).host}: ${err.message}`;
      log(`OSM track tile ${bbox.join(",")}: ${last}`);
    }
  }
  throw new Error(last ?? "no answer");
}

/** An OSM station node → [name, name:vi, name:en, lat, lon], or null without a name. */
export function stationRecord(node) {
  const t = node?.tags ?? {};
  const name = t.name ?? t["name:vi"] ?? null;
  if (!name || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) return null;
  const round = (v) => Math.round(v * 1e5) / 1e5;
  return [name, t["name:vi"] ?? null, t["name:en"] ?? null, round(node.lat), round(node.lon)];
}

/**
 * The track network (an array of [lat, lon] polylines) or null when no tile
 * has ever answered. With `params.stations`, the array also carries
 * `.stations`: every station record the tiles hold ([] when none).
 *
 * @param {{ rootDir: string, today: string, params: { file: string, bbox: number[], maxAgeDays?: number, tileDeg?: number, budgetMs?: number, stations?: boolean }, fetchImpl?: Function, log?: Function, retryMs?: number }} opts
 */
export async function loadOsmTrack({ rootDir, today, params = {}, fetchImpl = fetch, log = () => {}, retryMs }) {
  if (!params.file || !Array.isArray(params.bbox)) throw new Error("loadOsmTrack needs params.file and params.bbox");
  const file = path.join(rootDir, "public/data/scraped", params.file);
  const cachedTiles = readJsonSafe(file)?.data?.tiles ?? {};
  const maxAge = params.maxAgeDays ?? MAX_AGE_DAYS;
  const withStations = !!params.stations;
  const ageOf = (t) => (t?.fetchedAt ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.fetchedAt}T00:00:00Z`)) / 86_400_000 : Infinity);
  // A tile cached before stations were asked for has to be asked again.
  const current = (t) => t && ageOf(t) <= maxAge && (!withStations || Array.isArray(t.stations));
  const deadline = Date.now() + (params.budgetMs ?? BUDGET_MS);
  const query = withStations ? TRACK_AND_STATIONS_QUERY : TRACK_QUERY;
  const tiles = {};
  let fetched = 0;
  let failed = 0;
  for (const bbox of bboxTiles(params.bbox, params.tileDeg ?? TILE_DEG)) {
    const key = bbox.join(",");
    const old = cachedTiles[key] ?? null;
    if (current(old)) {
      tiles[key] = old;
      continue;
    }
    try {
      const elements = await overpassTile(bbox, { query, fetchImpl, log, deadline, retryMs });
      const ways = elements.filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 2);
      const lines = trackFromOverpass({ elements: ways });
      tiles[key] = { fetchedAt: today, ways: ways.map((w, i) => [w.id, polyline.encode(lines[i])]) };
      if (withStations) {
        tiles[key].stations = elements.filter((e) => e.type === "node").map(stationRecord).filter(Boolean);
      }
      fetched++;
    } catch (err) {
      failed++;
      if (old) tiles[key] = old;
      log(`OSM track tile ${key}: ${err.message}${old ? ` — keeping the copy from ${old.fetchedAt}` : " — no copy yet"}`);
    }
  }
  if (fetched) fs.writeFileSync(file, JSON.stringify({ uploadedAt: new Date().toISOString(), data: { tiles } }));
  const byId = new Map();
  for (const t of Object.values(tiles)) for (const [id, enc] of t.ways ?? []) if (!byId.has(id)) byId.set(id, enc);
  const held = Object.keys(tiles).length;
  const stations = withStations ? Object.values(tiles).flatMap((t) => t.stations ?? []) : null;
  log(
    `OSM track: ${byId.size} ways${stations ? `, ${stations.length} stations` : ""} from ${held} tile(s) (${fetched} refreshed tonight, ${failed} refused${held - fetched ? `, ${held - fetched} from the cache` : ""})`,
  );
  if (!byId.size && !stations?.length) {
    log("OSM track: nothing yet");
    return null;
  }
  const lines = [...byId.values()].map((enc) => polyline.decode(enc));
  if (stations) lines.stations = stations;
  return lines;
}
