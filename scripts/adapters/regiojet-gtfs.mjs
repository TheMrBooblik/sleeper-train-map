// scripts/adapters/regiojet-gtfs.mjs
// RegioJet night trains — the nightly refresh, from RegioJet's own GTFS.
//
// RegioJet publishes two feeds on its booking system's host and keeps them
// current ("We are always trying to keep it as updated as possible"):
//
//   params.feeds[].url
//     interstate     https://ybus.sa.cz/gtfe/google_transit.zip
//     international  https://ybus.sa.cz/gtfe/international/google_transit.zip
//
// Both are read and merged (scripts/lib/regiojet.mjs explains how a night
// train is recognised and described). They are small — ~400 KB of tables
// each — so each is downloaded, unzipped and read whole.
//
// The feed's shapes.txt is the station chain, so a train's line is borrowed
// from track the repo already has (params.siblingTracks). It is drawn only on
// a row this source creates: Back-on-Track's RegioJet rows keep their
// hand-traced corridors (the enrichment does not set polylines).
//
// Never fatal for the map: a feed that cannot be fetched is logged and the
// other is still read; when neither can be, the trains are rebuilt from last
// night's file (for up to 30 days) and the run returns a warning so
// source-health.json records it.
//
// REGIOJET_GTFS=path[,path] reads zips or unzipped directories already on
// disk instead (in params.feeds order) — how the feed is inspected from a
// sandbox that cannot reach ybus.sa.cz.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import polyline from "@mapbox/polyline";
import { readCsv } from "../lib/gtfs.mjs";
import { HONEST_USER_AGENT } from "../lib/http-block.mjs";
import { buildRegiojetTrains, makeStationNamer, mergeFeeds, pathKm } from "../lib/regiojet.mjs";
import { fillRjFareCalendars } from "../lib/rj-fares.mjs";
import STATION_ALIASES from "../../data/overrides/station-aliases.json" with { type: "json" };

const DOWNLOAD_TIMEOUT_MS = 120_000;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The tables of one feed, from a directory of .txt files. */
export function readFeedDir(dir) {
  const read = (f) => readCsv(path.join(dir, f));
  return {
    routes: read("routes.txt"),
    trips: read("trips.txt"),
    stops: read("stops.txt"),
    stopTimes: read("stop_times.txt"),
    calendar: read("calendar.txt"),
    calendarDates: read("calendar_dates.txt"),
    shapes: read("shapes.txt"),
  };
}

/** One feed's tables, from a URL or from a zip/directory on disk. */
export async function loadFeed({ url, local = null, fetchImpl = fetch, log = () => {} }) {
  if (local && fs.existsSync(local) && fs.statSync(local).isDirectory()) return readFeedDir(local);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regiojet-gtfs-"));
  try {
    let zipPath = local;
    if (!zipPath) {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": HONEST_USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const zip = Buffer.from(await res.arrayBuffer());
      if (zip.length < 1_000 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error(`not a zip (${zip.length} bytes)`);
      zipPath = path.join(dir, "feed.zip");
      fs.writeFileSync(zipPath, zip);
      log(`${new URL(url).pathname}: ${(zip.length / 1e3).toFixed(0)} KB`);
    }
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
    return readFeedDir(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lines to borrow track from where the feed's shapes are only the station
 * chain. Each entry is a path relative to the repo, in any of the shapes the
 * repo already commits track in:
 *   - a plain [[lat, lon], …] array (public/data/*Polyline.json, the
 *     hand-traced corridors — RegioJet's own Praha–Čop and Praha–Przemyśl
 *     among them);
 *   - a trains file whose trains carry an encoded `polyline` (ČD, Nightjet);
 *   - the PKP GTFS bundle, whose trains carry `rail_segments` of positions
 *     (Leo Express and PKP between Ostrava, Kraków and Przemyśl).
 * A missing or unreadable file lends nothing.
 */
export function siblingLines(rootDir, files = [], log = () => {}) {
  const out = [];
  const points = (list) => (Array.isArray(list) ? list.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : []);
  const push = (pts) => {
    if (pts.length >= 3) out.push(pts);
  };
  for (const file of files ?? []) {
    const doc = readJsonSafe(path.join(rootDir, file));
    if (!doc) {
      log(`${file}: unreadable — no lines borrowed from it`);
      continue;
    }
    if (Array.isArray(doc)) {
      push(points(doc));
      continue;
    }
    if (doc.byTrainKey) {
      for (const t of Object.values(doc.byTrainKey)) for (const seg of t?.rail_segments ?? []) push(points(seg?.positions));
      continue;
    }
    const trains = doc?.data?.trains ?? doc?.trains ?? {};
    for (const t of Object.values(trains)) {
      if (typeof t?.polyline === "string" && t.polyline) push(polyline.decode(t.polyline));
    }
  }
  return out;
}

const resolveAlias = (name) => STATION_ALIASES[String(name ?? "").toLowerCase().trim()] ?? name;

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, params.configPath), "utf8"));
  const previousFile = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped", entry.output));
  const previous = previousFile?.data?.trains ?? previousFile?.trains ?? {};
  const fetchImpl = ctx.fetch ?? fetch;
  const warnings = [];

  const locals = String(process.env.REGIOJET_GTFS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(ctx.rootDir, p));
  const loaded = [];
  for (const [i, f] of (params.feeds ?? []).entries()) {
    const local = locals.length ? locals[i] ?? null : null;
    if (locals.length && !local) continue;
    try {
      const tables = await loadFeed({ url: f.url, local, fetchImpl, log });
      log(`${f.id}: ${tables.routes.length} route(s), ${tables.trips.length} trip(s)${local ? ` from ${path.relative(ctx.rootDir, local)}` : ""}`);
      loaded.push({ id: f.id, tables });
    } catch (err) {
      warnings.push(`${f.id}: ${err.message}`);
      log(`${f.id}: ${err.message} — not read tonight`);
    }
  }
  const feed = loaded.length ? mergeFeeds(loaded) : null;
  if (!feed) warnings.push("no feed could be read — trains rebuilt from last night's file");

  const botStops = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped/backontrack-stops.json"));
  const stops = Array.isArray(botStops?.data) ? botStops.data : Array.isArray(botStops) ? botStops : Object.values(botStops?.data ?? {});
  const nameStop = makeStationNamer({ stops, resolveAlias, stationNames: config.stationNames, matchKm: config.matchKm ?? 3 });
  const donors = siblingLines(ctx.rootDir, params.siblingTracks, log);

  const trains = buildRegiojetTrains({ config, feed, nameStop, donors, previous, today: ctx.today, log });
  if (!Object.keys(trains).length) throw new Error(`no night train built (${warnings.join("; ") || "none in the feeds"})`);

  // Fares: every night of the next six weeks from RegioJet's booking API
  // (scripts/lib/rj-fares.mjs). A fare failure costs the fares, not the trains.
  if (params.fares?.enabled !== false) {
    try {
      const stats = await fillRjFareCalendars(trains, previous, {
        today: ctx.today,
        fetchImpl: ctx.fetch ?? undefined,
        log: console.log,
        ...(params.fares?.days ? { days: params.fares.days } : {}),
        ...(params.fares?.requestsPerRun ? { requests: params.fares.requestsPerRun } : {}),
        ...(params.fares?.nearDays != null ? { nearDays: params.fares.nearDays } : {}),
      });
      if (stats.blocked) warnings.push(`fares: blocked (${stats.blocked.reason})`);
      else if (stats.stopped) warnings.push("fares: stopped after repeated failures");
    } catch (err) {
      warnings.push(`fares: ${err.message}`);
      log(warnings.at(-1));
    }
  }
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const b = t.stations.at(-1);
    log(
      `${t.lineName}: ${a.name} ${a.departure} → ${b.name} ${b.arrival} (+${b.arrivalDay}), ${t.stations.length} stops, ${t.frequency ?? "days unknown"}, ` +
        `line ${Math.round(pathKm(polyline.decode(t.polyline)))} km ${JSON.stringify(t.geometry)}${t.deviations?.length ? `, ${t.deviations.length} night(s) off the usual timetable` : ""}`,
    );
  }
  ctx.write(entry.output, { uploadedAt: ctx.today, feeds: loaded.map((f) => f.id), trains });
  log(`stored ${Object.keys(trains).length} train(s)`);
  return warnings.length ? { warning: warnings.join("; ") } : undefined;
}
