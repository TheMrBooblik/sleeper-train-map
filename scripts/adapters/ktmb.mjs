// scripts/adapters/ktmb.mjs
// KTM Berhad (Malaysia) night trains — the nightly refresh.
//
//   1. data.gov.my's GTFS Static for KTMB (params.feedUrl, the government's
//      open transport API, no key; it answers with a redirect to the zip on
//      S3): the timetable — every stop with its time and position. A small
//      feed (~230 KB), read whole.
//   2. KITS (online.ktmb.com.my), KTMB's own ticket shop, searched the way its
//      page searches before login, one search per train between its two ends,
//      `params.kits.dateOffsetDays` ahead: confirms the train is on sale that
//      night at the feed's times, and reads its "Min. fare". Per-class fares
//      (a berth against a seat) are shown only after login, which this map
//      does not do, so KITS's figure is kept on the train as `kitsMinFare` —
//      the cheapest place in any class — and is never published as a berth's
//      price.
//   3. OpenStreetMap's railway network (the feed ships no shapes), from the
//      weekly tiled Overpass cache (scripts/lib/osm-track.mjs).
//
// scripts/lib/ktmb.mjs decides what is kept and builds the trains file. Never
// fatal for the map: when the feed cannot be read the trains are rebuilt from
// last night's file (for up to 30 days), and a KITS failure costs only the
// confirmation. Either returns a warning so source-health.json records it.
// The "Probe KTMB source" workflow (label a PR `run-probes`) prints what both
// answer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readCsv } from "../lib/gtfs.mjs";
import { HONEST_USER_AGENT } from "../lib/http-block.mjs";
import { loadOsmTrack } from "../lib/osm-track.mjs";
import { makeKitsClient, parseTripRows } from "../lib/ktmb-kits.mjs";
import { buildKtmbTrains, makeStationNamer, nightTrips, serviceDays, serviceEnd } from "../lib/ktmb.mjs";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DATE_OFFSET_DAYS = 7;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The feed's tables, from a zip URL (redirects followed) or a directory/zip on disk. */
export async function loadKtmbFeed({ url, local = null, fetchImpl = fetch, log = () => {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktmb-gtfs-"));
  try {
    let src = local;
    if (!src) {
      const res = await fetchImpl(url, { headers: { "User-Agent": HONEST_USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const zip = Buffer.from(await res.arrayBuffer());
      if (zip.length < 1_000 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error(`not a zip (${zip.length} bytes)`);
      src = path.join(dir, "feed.zip");
      fs.writeFileSync(src, zip);
      log(`GTFS: ${(zip.length / 1e3).toFixed(0)} KB from ${new URL(res.url || url).host}`);
    }
    let tables = src;
    if (fs.statSync(src).isFile()) {
      execFileSync("unzip", ["-o", "-q", src, "-d", dir]);
      tables = dir;
    }
    const read = (f) => (fs.existsSync(path.join(tables, f)) ? readCsv(path.join(tables, f)) : []);
    const stopTimesByTrip = new Map();
    for (const st of read("stop_times.txt")) {
      if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
      stopTimesByTrip.get(st.trip_id).push(st);
    }
    return {
      routes: read("routes.txt"),
      trips: read("trips.txt"),
      stopsById: new Map(read("stops.txt").map((s) => [s.stop_id, s])),
      calendar: read("calendar.txt"),
      stopTimesByTrip,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One KITS search per train, between its two ends: on sale that night, at what times, from what fare. */
export async function confirmOnKits({ trains, client, travelDate, log }) {
  const out = new Map();
  for (const t of trains.values()) {
    const from = t.stops[0].id;
    const to = t.stops.at(-1).id;
    try {
      const { html } = await client.search({ from, to, date: travelDate });
      const row = parseTripRows(html).find((r) => r.number === t.number);
      if (!row) {
        log(`KITS ${t.number}: not in the ${t.stops[0].name} → ${t.stops.at(-1).name} results for ${travelDate}`);
        continue;
      }
      out.set(t.number, row);
    } catch (err) {
      if (client.blocked) throw err;
      log(`KITS ${t.number}: ${err.message}`);
    }
  }
  return out;
}

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, params.configPath), "utf8"));
  const previousFile = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped", entry.output));
  const previous = previousFile?.data?.trains ?? previousFile?.trains ?? {};
  const offset = params.kits?.dateOffsetDays ?? DEFAULT_DATE_OFFSET_DAYS;
  const travelDate = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const fetchImpl = ctx.fetch ?? fetch;
  const warnings = [];

  // 1. The timetable.
  let feedTrains = null;
  try {
    const local = process.env.KTMB_GTFS_ZIP ? path.resolve(ctx.rootDir, process.env.KTMB_GTFS_ZIP) : null;
    const feed = await loadKtmbFeed({ url: params.feedUrl, local, fetchImpl, log });
    const namer = makeStationNamer(config.stationNames);
    const { trains, skipped } = nightTrips(feed, config, namer);
    for (const t of trains.values()) {
      t.frequency = serviceDays([t.serviceId], feed.calendar);
      t.validUntil = serviceEnd([t.serviceId], feed.calendar);
      if (t.validUntil && t.validUntil < ctx.today) {
        warnings.push(`GTFS: ${t.number}'s calendar ended ${t.validUntil}; data.gov.my has not republished it`);
      }
    }
    log(`GTFS: ${trains.size} night train(s) on ${[...(config.routes ?? [])].join(", ")}: ${[...trains.keys()].join(", ") || "none"}; left out ${skipped.join(", ") || "nothing"}`);
    if (!trains.size) throw new Error(`no night train on ${config.routes?.join(", ")} in the feed`);
    feedTrains = trains;
  } catch (err) {
    warnings.push(`GTFS: ${err.message} — trains rebuilt from last night's file`);
    log(warnings.at(-1));
  }

  // 2. KITS: on sale, at the feed's times?
  if (feedTrains && params.kits?.enabled !== false) {
    const client = makeKitsClient({ fetchImpl, log, ...(params.kits?.spacingMs != null ? { spacingMs: params.kits.spacingMs } : {}) });
    try {
      const rows = await confirmOnKits({ trains: feedTrains, client, travelDate, log });
      for (const t of feedTrains.values()) {
        const row = rows.get(t.number);
        if (!row) continue;
        const first = t.stops[0];
        const last = t.stops.at(-1);
        const clock = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const agrees = row.departure === clock(first.depMin) && row.arrival === clock(last.arrMin);
        t.kits = { travelDate, departure: row.departure, arrival: row.arrival, minFare: row.minFare, agrees };
        log(
          `KITS ${row.service} ${t.number} on ${travelDate}: ${row.departure} → ${row.arrival}${row.nextDay ? ` +${row.nextDay}` : ""}, min. fare ${row.minFare != null ? `MYR ${row.minFare}` : "—"}${agrees ? "" : ` — the feed says ${clock(first.depMin)} → ${clock(last.arrMin)}`}`,
        );
      }
    } catch (err) {
      warnings.push(`KITS: ${err.message}`);
      log(warnings.at(-1));
    }
    log(`KITS: ${client.requests} request(s)`);
  }

  // 3. Track.
  const osmTrack = await loadOsmTrack({ rootDir: ctx.rootDir, today: ctx.today, params: params.osmTrack, fetchImpl, log });

  const trains = buildKtmbTrains({ config, feedTrains, osmTrack, previous, today: ctx.today, travelDate, log });
  for (const t of Object.values(trains)) {
    const live = feedTrains?.get(t.trainNo);
    if (live?.kits) t.kits = live.kits;
  }
  if (!Object.keys(trains).length) throw new Error(`no trains built (${warnings.join("; ") || "nothing kept"})`);
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const b = t.stations.at(-1);
    log(`${t.lineName}: ${a.name} ${a.departure} → ${b.name} ${b.arrival} (+${b.arrivalDay}), ${t.stations.length} stops, ${t.frequency ?? "days unknown"}, line ${JSON.stringify(t.geometry)}`);
  }
  ctx.write(entry.output, { uploadedAt: ctx.today, travelDate, trains });
  log(`stored ${Object.keys(trains).length} train(s)`);
  return warnings.length ? { warning: warnings.join("; ") } : undefined;
}
