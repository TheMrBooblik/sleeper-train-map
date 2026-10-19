// scripts/adapters/srt.mjs
// State Railway of Thailand night trains — the nightly refresh.
//
//   1. Namtang (the Ministry of Transport's national GTFS, params.feedUrl, with
//      the Mobility Database mirror as fallback): station positions, the full
//      stop list of most long-distance trains, their track. Only the SRT rows
//      are read, streamed out of the 41 MB zip — its fare tables are 64 MB of
//      Bangkok buses.
//   2. D-Ticket (SRT's booking site): one search per corridor and direction,
//      `params.dateOffsetDays` ahead — the trains, their departure and arrival
//      times, then each overnight train's coaches with the fare of every
//      berth. These are the calls the site's own search page makes before
//      anyone logs in; its captcha guards login and seat booking, never this.
//
// scripts/lib/srt.mjs decides what is kept (overnight, sells a berth) and
// builds the trains file. Never fatal for the map: when D-Ticket cannot be
// reached the trains are rebuilt from last night's file (times and fares as
// they were), and the run returns a warning so source-health.json records
// that tonight confirmed nothing. A block (detectBlock) stops the D-Ticket pass
// for the night — this map never works around one.
//
// D-Ticket answers some GitHub runner addresses and times out on others, so a
// connect timeout gets one retry after a pause. The "Probe SRT source" workflow
// (label a PR `run-probes`) prints what the live site answers.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { streamZipCsv } from "../lib/gtfs.mjs";
import { HONEST_USER_AGENT, detectBlock } from "../lib/http-block.mjs";
import { trackFromOverpass } from "../lib/rail-graph.mjs";
import { OVERPASS_ENDPOINTS } from "../lib/scrape-helpers.mjs";
import polyline from "@mapbox/polyline";
import {
  berthFares,
  buildSrtTrains,
  makeStationNamer,
  namtangTrains,
  parseTrips,
  pickCorridorTrains,
  stationPositions,
} from "../lib/srt.mjs";

const REQUEST_SPACING_MS = 1_200;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_PAUSE_MS = 30_000;
const DEFAULT_DATE_OFFSET_DAYS = 7;
// A download that stalls must cost its address, not the night: the first
// branch run hung for 20 minutes on one. The mirror is tried next.
const DOWNLOAD_TIMEOUT_MS = 180_000;
// The whole D-Ticket pass, however slow the host is tonight: what was read by
// then is kept, every other train comes from last night's file.
const DTICKET_BUDGET_MS = 12 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTimeout = (err) => /TIMEOUT|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(String(err?.cause?.code ?? err?.message ?? err));

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ─── Namtang ────────────────────────────────────────────────────────────────

async function downloadWithTimeout(url, dest, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function fetchNamtang(params, zipPath, log) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  for (const url of [params.feedUrl, ...(params.fallbackUrls ?? [])].filter(Boolean)) {
    try {
      await downloadWithTimeout(url, zipPath);
      const size = fs.statSync(zipPath).size;
      if (size < 1e6) throw new Error(`only ${size} bytes`);
      log(`Namtang GTFS: ${(size / 1e6).toFixed(0)} MB from ${new URL(url).host}`);
      return url;
    } catch (err) {
      log(`Namtang GTFS from ${new URL(url).host} failed: ${err.message}`);
    }
  }
  return null;
}

/** The SRT slice of the Namtang zip, streamed. */
export async function loadNamtang(zipPath) {
  const routes = [];
  await streamZipCsv(zipPath, "routes.txt", (r) => {
    if (r.agency_id === "SRT") routes.push(r);
  });
  const routeIds = new Set(routes.map((r) => r.route_id));
  const trips = [];
  await streamZipCsv(zipPath, "trips.txt", (t) => trips.push(t), {
    keep: { column: "route_id", test: (v) => routeIds.has(v) },
  });
  const tripIds = new Set(trips.map((t) => t.trip_id));
  const stopTimesByTrip = new Map();
  await streamZipCsv(
    zipPath,
    "stop_times.txt",
    (s) => {
      if (!stopTimesByTrip.has(s.trip_id)) stopTimesByTrip.set(s.trip_id, []);
      stopTimesByTrip.get(s.trip_id).push(s);
    },
    { keep: { column: "trip_id", test: (v) => tripIds.has(v) } },
  );
  const stopIds = new Set([...stopTimesByTrip.values()].flat().map((s) => s.stop_id));
  const stopsById = new Map();
  await streamZipCsv(zipPath, "stops.txt", (s) => stopsById.set(s.stop_id, s), {
    keep: { column: "stop_id", test: (v) => stopIds.has(v) },
  });
  const shapeIds = new Set(trips.map((t) => t.shape_id).filter(Boolean));
  const points = new Map();
  await streamZipCsv(
    zipPath,
    "shapes.txt",
    (p) => {
      if (!points.has(p.shape_id)) points.set(p.shape_id, []);
      points.get(p.shape_id).push([Number(p.shape_pt_sequence), Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
    },
    { keep: { column: "shape_id", test: (v) => shapeIds.has(v) } },
  );
  const shapesById = new Map(
    [...points].map(([id, pts]) => [id, pts.sort((a, b) => a[0] - b[0]).map(([, lat, lon]) => [lat, lon])]),
  );
  return { routes, trips, stopTimesByTrip, stopsById, shapesById };
}

// ─── OpenStreetMap track ────────────────────────────────────────────────────

// Every railway line in and around Thailand (Padang Besar is in Malaysia),
// service sidings left out. Asked as tiles rather than one country-sized
// query: the first branch run had both public Overpass servers refuse the
// whole bbox at once (502, 500), which a busy server does to a heavy query.
const OSM_TRACK_QUERY = (bbox) =>
  `[out:json][timeout:180];way["railway"="rail"][!"service"](${bbox.join(",")});out geom;`;
const OSM_TRACK_MAX_AGE_DAYS = 7;
const OSM_TILE_DEG = 3;
const OSM_ATTEMPTS = 3;
const OSM_ENDPOINTS = [...OVERPASS_ENDPOINTS, "https://overpass.private.coffee/api/interpreter"];
// The whole refresh, every tile and retry: past it the cache (or Namtang) draws tonight.
const OSM_BUDGET_MS = 20 * 60_000;

/** [south, west, north, east] cut into equal tiles of at most `deg` degrees a side. */
export function bboxTiles([s, w, n, e], deg = OSM_TILE_DEG) {
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

async function overpassTile(bbox, { fetchImpl, log, deadline = Infinity, retryMs = 10_000 }) {
  let last = null;
  for (let attempt = 0; attempt < OSM_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) throw new Error(`out of time (${last ?? "no answer"})`);
    const url = OSM_ENDPOINTS[attempt % OSM_ENDPOINTS.length];
    if (attempt) await sleep(retryMs * attempt);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": HONEST_USER_AGENT },
        body: OSM_TRACK_QUERY(bbox),
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

/**
 * The track network to route trains along, from a committed cache refreshed
 * weekly from Overpass one tile at a time. Each tile keeps its own date, so a
 * tile Overpass refuses tonight keeps last week's copy and is asked again
 * tomorrow while the others refresh (track rarely moves); a tile never once
 * answered leaves its corner to Namtang's shapes. Ways are merged by id, as
 * a way crossing a tile edge comes back whole in both.
 */
export async function loadOsmTrack({ rootDir, today, params = {}, fetchImpl = fetch, log = () => {}, retryMs }) {
  const file = path.join(rootDir, "public/data/scraped", params.file ?? "osm-srt-track.json");
  const cachedTiles = readJsonSafe(file)?.data?.tiles ?? {};
  const maxAge = params.maxAgeDays ?? OSM_TRACK_MAX_AGE_DAYS;
  const ageOf = (t) => (t?.fetchedAt ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.fetchedAt}T00:00:00Z`)) / 86_400_000 : Infinity);
  const deadline = Date.now() + (params.budgetMs ?? OSM_BUDGET_MS);
  const tiles = {};
  let fetched = 0;
  let failed = 0;
  for (const bbox of bboxTiles(params.bbox ?? [5.6, 97.3, 20.6, 106.0], params.tileDeg ?? OSM_TILE_DEG)) {
    const key = bbox.join(",");
    const old = cachedTiles[key] ?? null;
    if (old && ageOf(old) <= maxAge) {
      tiles[key] = old;
      continue;
    }
    try {
      const elements = await overpassTile(bbox, { fetchImpl, log, deadline, retryMs });
      const ways = elements.filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 2);
      const lines = trackFromOverpass({ elements: ways });
      tiles[key] = { fetchedAt: today, ways: ways.map((w, i) => [w.id, polyline.encode(lines[i])]) };
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
  log(`OSM track: ${byId.size} ways from ${held} tile(s) (${fetched} refreshed tonight, ${failed} refused${held - fetched ? `, ${held - fetched} from the cache` : ""})`);
  if (!byId.size) {
    log("OSM track: nothing yet — routing on Namtang's shapes only");
    return null;
  }
  return [...byId.values()].map((enc) => polyline.decode(enc));
}

// ─── D-Ticket ───────────────────────────────────────────────────────────────

/** A cookie-carrying client for D-Ticket, polite and strict. */
export function makeDTicketClient(base, { fetchImpl = fetch, spacingMs = REQUEST_SPACING_MS, log = () => {} } = {}) {
  const cookies = new Map();
  let blocked = null;
  let requests = 0;
  const remember = (res) => {
    const lines = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  async function once(relative, { form = null, json = false } = {}) {
    const headers = {
      "User-Agent": HONEST_USER_AGENT,
      Accept: json ? "application/json, text/javascript, */*; q=0.01" : "text/html,*/*;q=0.8",
      "Accept-Language": "en,th;q=0.8",
      Referer: new URL("home/Home", base).href,
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      body = new URLSearchParams(form).toString();
    }
    requests += 1;
    const res = await fetchImpl(new URL(relative, base).href, {
      method: form ? "POST" : "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    remember(res);
    const text = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: json });
    if (block) {
      blocked = block;
      throw new Error(`blocked: ${block.reason}`);
    }
    if (json) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${relative}: HTTP ${res.status}, not JSON`);
      }
    }
    return { status: res.status, text };
  }
  async function call(relative, opts) {
    if (blocked) throw new Error(`blocked: ${blocked.reason}`);
    await sleep(spacingMs);
    try {
      return await once(relative, opts);
    } catch (err) {
      if (blocked || !isTimeout(err)) throw err;
      log(`${relative}: ${err.cause?.code ?? err.message} — retrying once in ${RETRY_PAUSE_MS / 1000} s`);
      await sleep(RETRY_PAUSE_MS);
      return once(relative, opts);
    }
  }
  return {
    call,
    get blocked() {
      return blocked;
    },
    get requests() {
      return requests;
    },
  };
}

const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Every corridor, both directions: trips and each overnight trip's berth fares. */
export async function readDTicket({ config, client, travelDate, log, budgetMs = DTICKET_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;
  await client.call("home/Home");
  const stationsAnswer = await client.call("home/Home/getStation", { form: { LineId: "" }, json: true });
  if (stationsAnswer?.errorCode !== "S_SUCCESS" || !Array.isArray(stationsAnswer.data)) {
    throw new Error(`getStation answered ${stationsAnswer?.errorCode ?? "nothing"}`);
  }
  const idByName = new Map(stationsAnswer.data.map((s) => [String(s.stationNameEn ?? "").trim(), String(s.stationId)]));
  const origin = config.origin;
  const answers = [];
  let failures = 0;
  for (const far of config.corridors) {
    if (Date.now() > deadline) {
      log(`time budget spent — corridors from ${far} on are left for tomorrow`);
      break;
    }
    for (const [from, to] of [
      [origin, far],
      [far, origin],
    ]) {
      const start = idByName.get(from);
      const end = idByName.get(to);
      if (!start || !end) {
        log(`${from} → ${to}: not in D-Ticket's station list — skipped`);
        continue;
      }
      try {
        const date = ddmmyyyy(travelDate);
        await client.call("booking/booking", {
          form: {
            tripType: "1",
            provinceStart: start,
            provinceEnd: end,
            "date-start-picker": date,
            "date-start": date,
            "date-end-picker": "",
            "date-end": "",
            seatperson: "1",
            lineId: "0",
          },
        });
        const trips = parseTrips(
          await client.call("booking/booking/getTrip", {
            form: { tripType: "1", provinceStartId: start, provinceEndId: end, dateStart: date, dateEnd: "" },
            json: true,
          }),
        );
        if (!trips) throw new Error("getTrip: unreadable answer");
        const faresByTrip = new Map();
        for (const trip of trips.filter((t) => t.nights >= 1)) {
          const fares = berthFares(
            await client.call("booking/booking/getTrainCoach", {
              form: { tripId: trip.tripId, provinceStartId: start, provinceEndId: end },
              json: true,
            }),
            config.fareClasses,
          );
          if (fares) faresByTrip.set(trip.tripId, fares);
        }
        log(
          `${from} → ${to}: ${trips.length} train(s); overnight with a berth: ${
            trips.filter((t) => Object.keys(faresByTrip.get(t.tripId) ?? {}).length).map((t) => `${t.trainNo} ${t.departure}→${t.arrival}`).join(", ") || "none"
          }`,
        );
        answers.push({ from, to, trips, faresByTrip });
      } catch (err) {
        if (client.blocked) throw err;
        failures += 1;
        log(`${from} → ${to}: ${err.message}`);
        if (failures >= 5) throw new Error(`five corridors failed in a row (${err.message})`);
        continue;
      }
      failures = 0;
    }
  }
  return answers;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, params.configPath), "utf8"));
  const previousFile = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped", entry.output));
  const previous = previousFile?.data?.trains ?? previousFile?.trains ?? {};
  const offset = params.dateOffsetDays ?? DEFAULT_DATE_OFFSET_DAYS;
  const travelDate = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

  // 1. Namtang.
  const zipPath = process.env.SRT_GTFS_ZIP
    ? path.resolve(ctx.rootDir, process.env.SRT_GTFS_ZIP)
    : path.join(ctx.rootDir, "gtfs-data", "srt-namtang.zip");
  const feedUrl = process.env.SRT_GTFS_ZIP ? "local" : await fetchNamtang(params, zipPath, log);
  if (!feedUrl) throw new Error("Namtang GTFS could not be downloaded from any address");
  const namer = makeStationNamer(config.stationNames);
  const namtang = namtangTrains(await loadNamtang(zipPath), namer);
  if (!process.env.SRT_GTFS_ZIP) fs.rmSync(zipPath, { force: true });
  log(`Namtang: ${namtang.size} SRT train number(s), ${[...namtang.values()].filter((t) => t.stops.length >= 10).length} with a long-distance stop list`);

  // 2. D-Ticket.
  const client = makeDTicketClient(params.baseUrl, { fetchImpl: ctx.fetch ?? fetch, log });
  let found = null;
  let warning = null;
  try {
    const answers = await readDTicket({ config, client, travelDate, log });
    found = pickCorridorTrains(answers);
    if (!found.size) throw new Error("no overnight train with a berth on any corridor");
  } catch (err) {
    warning = `D-Ticket: ${err.message} — trains rebuilt from last night's file`;
    log(warning);
    found = null;
  }
  log(`D-Ticket: ${client.requests} request(s) for travel on ${travelDate}`);

  const osmTrack = await loadOsmTrack({ rootDir: ctx.rootDir, today: ctx.today, params: params.osmTrack, fetchImpl: ctx.fetch ?? fetch, log });

  const trains = buildSrtTrains({
    config,
    found,
    osmTrack,
    namtang,
    positions: stationPositions(namtang, config),
    previous,
    today: ctx.today,
    travelDate,
    log,
  });
  if (!Object.keys(trains).length) {
    throw new Error(`no trains built (${warning ?? "D-Ticket answered but nothing was kept"})`);
  }
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const b = t.stations[t.stations.length - 1];
    log(`${t.lineName}: ${a.name} ${a.departure} → ${b.name} ${b.arrival}, ${t.stations.length} stops, from ${t.fare ? `฿${t.fare.fromPrice}` : "—"}, line ${JSON.stringify(t.geometry)}`);
  }
  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    travelDate,
    feed: feedUrl === "local" ? "local" : new URL(feedUrl).host,
    trains,
  });
  log(`stored ${Object.keys(trains).length} train(s)`);
  return warning ? { warning } : undefined;
}
