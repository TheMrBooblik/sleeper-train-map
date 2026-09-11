// scripts/probe-gtfs.mjs
// What is actually inside a GTFS feed, and which of its routes are night trains.
//
// Every remaining GTFS operator on the integration board is blocked on the same
// step: `gtfs-sleeper` needs a curated allowlist (data/sources/*-sleepers.json)
// of the routes that carry sleeping cars, and nobody can write one without
// seeing the feed's own route names. The dev sandbox has egress to no external
// host, so this runs from CI ("Probe GTFS feed" workflow) where it is open.
//
// Deliberately generic rather than one probe per operator: SNCF, VR, ZSSK, the
// Swedish national feed and MÁV all need exactly this, and a per-operator script
// would be the same code five times.
//
// The job LOG is the delivery channel (a workflow artifact is not reachable from
// the sandbox), so output is capped and the allowlist block is printed LAST —
// a tail of the log still carries the part you paste.
//
//   node scripts/probe-gtfs.mjs --url https://…/feed.zip
//   node scripts/probe-gtfs.mjs --source amtrak        # feedUrl from the registry
//   node scripts/probe-gtfs.mjs --dir ./unzipped-feed  # skip the download
//   node scripts/probe-gtfs.mjs --url … --min-hours 4 --limit 60

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadGtfs, loadGtfsDir } from "./lib/gtfs.mjs";
import { loadRegistry } from "./lib/registry.mjs";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** "25:10:00" → 90600. GTFS encodes past-midnight times as hours ≥ 24. */
export function toSeconds(hhmmss) {
  // String(), not `|| ""`: a feed column that arrives as a number would throw
  // on .trim(), and a probe that crashes on one odd row tells you nothing about
  // the other nine hundred.
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(hhmmss ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const hhmm = (secs) =>
  secs === null
    ? "??:??"
    : `${String(Math.floor(secs / 3600) % 24).padStart(2, "0")}:${String(
        Math.floor((secs % 3600) / 60),
      ).padStart(2, "0")}`;

const dur = (secs) =>
  secs === null ? "?" : `${Math.floor(secs / 3600)}h${String(Math.round((secs % 3600) / 60)).padStart(2, "0")}`;

/** Weekday letters from a calendar.txt row, or "" when the feed has none. */
export function daysOf(cal) {
  if (!cal) return "";
  const flags = [
    ["Mo", cal.monday], ["Tu", cal.tuesday], ["We", cal.wednesday],
    ["Th", cal.thursday], ["Fr", cal.friday], ["Sa", cal.saturday],
    ["Su", cal.sunday],
  ];
  const on = flags.filter(([, v]) => String(v) === "1").map(([d]) => d);
  return on.length === 7 ? "daily" : on.join("");
}

export const EVENING_FROM_SECONDS = 16 * 3600;

/**
 * Is this run a night train?
 *
 * Two signals, because feeds disagree on how to say it. The literal one is an
 * arrival at hours ≥ 24 — GTFS's own way of writing "next day", and proof on
 * its face. The fallback is a long run leaving in the evening, for feeds that
 * reset the clock at midnight instead and so lose the +1.
 *
 * Pure, so tests can pin the wrap-around case rather than trusting a live feed.
 *
 * @param {{dep:number, arr:number}} run seconds since the service day's midnight
 */
export function isOvernightCandidate({ dep, arr }, { minHours = 5, eveningFrom = EVENING_FROM_SECONDS } = {}) {
  if (!Number.isFinite(dep) || !Number.isFinite(arr)) return false;
  if (arr >= 24 * 3600) return true;
  return arr - dep >= minHours * 3600 && dep >= eveningFrom;
}

async function main() {
  const sourceId = arg("source");
  // An already-unzipped feed: lets you inspect one you downloaded by hand, and
  // lets the parsing half be exercised without any network at all.
  const localDir = arg("dir");
  let url = arg("url");
  if (!url && sourceId) {
    const entry = loadRegistry().find((e) => e.id === sourceId);
    url = entry?.params?.feedUrl ?? entry?.endpoint ?? null;
    if (!url) {
      console.error(`[probe-gtfs] source "${sourceId}" declares no params.feedUrl`);
      process.exit(1);
    }
  }
  if (!url && !localDir) {
    console.error("[probe-gtfs] need --url <feed.zip>, --source <registry id> or --dir <unzipped feed>");
    process.exit(1);
  }

  // An overnight train is one whose arrival runs past midnight — GTFS says so
  // literally, with hours ≥ 24 — or that simply runs a long way through the
  // night. Both, because some feeds reset the clock at midnight instead.
  const minHours = Number(arg("min-hours", "5"));
  const limit = Number(arg("limit", "40"));
  const eveningFrom = EVENING_FROM_SECONDS;

  const dir = localDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-probe-"));
  const t0 = Date.now();
  if (localDir) {
    console.log(`[probe-gtfs] reading ${localDir}`);
  } else {
    console.log(`[probe-gtfs] GET ${url}`);
    try {
      await downloadGtfs(url, dir);
    } catch (err) {
      // Which layer broke: HTTP status, DNS (ENOTFOUND), the host refusing
      // (UND_ERR_CONNECT_TIMEOUT) or TLS — they need different fixes.
      const cause = err.cause ?? {};
      console.error(`[probe-gtfs] download failed [${cause.code ?? err.code ?? err.name}]: ${err.message}`);
      process.exit(1);
    }
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  console.log(`[probe-gtfs] ${((Date.now() - t0) / 1000).toFixed(1)}s — tables: ${files.join(", ")}`);
  // No shapes.txt means the adapter must fall back to OSM geometry, which is
  // the single biggest cost difference between two otherwise identical feeds.
  console.log(`[probe-gtfs] shapes.txt: ${files.includes("shapes.txt") ? "YES (real track geometry)" : "NO — geometry would come from route-geometry.mjs"}`);

  const gtfs = loadGtfsDir(dir);
  console.log(
    `[probe-gtfs] ${gtfs.routesById.size} routes, ${gtfs.trips.length} trips, ` +
      `${gtfs.stopsById.size} stops, ${gtfs.calendarById.size} calendar services`,
  );

  // One representative trip per route: the longest, which is the through
  // service rather than a short working.
  const best = new Map();
  for (const trip of gtfs.trips) {
    const sts = gtfs.stopTimesByTrip.get(trip.trip_id);
    if (!sts || sts.length < 2) continue;
    const dep = toSeconds(sts[0].departure ?? sts[0].arrival);
    const arr = toSeconds(sts[sts.length - 1].arrival ?? sts[sts.length - 1].departure);
    if (dep === null || arr === null) continue;
    const length = arr - dep;
    const prev = best.get(trip.route_id);
    if (!prev || length > prev.length) {
      best.set(trip.route_id, { trip, sts, dep, arr, length });
    }
  }

  const candidates = [];
  for (const [routeId, r] of best) {
    if (!isOvernightCandidate(r, { minHours, eveningFrom })) continue;
    const crossesMidnight = r.arr >= 24 * 3600;
    const route = gtfs.routesById.get(routeId) ?? {};
    candidates.push({
      short: (route.route_short_name || "").trim(),
      long: (route.route_long_name || "").trim(),
      from: gtfs.stopsById.get(r.sts[0].stop_id)?.name ?? r.sts[0].stop_id,
      to: gtfs.stopsById.get(r.sts[r.sts.length - 1].stop_id)?.name ?? "?",
      dep: r.dep, arr: r.arr, length: r.length, stops: r.sts.length,
      days: daysOf(gtfs.calendarById.get(r.trip.service_id)),
      crossesMidnight,
    });
  }
  candidates.sort((a, b) => b.length - a.length);

  console.log(
    `\n[probe-gtfs] ${candidates.length} overnight candidate route(s) ` +
      `(arrival past midnight, or ≥${minHours}h leaving after ${hhmm(eveningFrom)})`,
  );
  if (candidates.length === 0) {
    console.log(
      "[probe-gtfs] none. Either the feed carries no night trains, or it resets\n" +
        "             times at midnight and runs shorter legs — retry with a lower\n" +
        "             --min-hours, and check the route names above by hand.",
    );
  }

  for (const c of candidates.slice(0, limit)) {
    console.log(
      `  ${(c.short || "—").padEnd(10)} ${dur(c.length).padStart(6)}  ` +
        `${hhmm(c.dep)}→${hhmm(c.arr)}${c.crossesMidnight ? "+1" : "  "}  ` +
        `${String(c.stops).padStart(3)} stops  ${(c.days || "?").padEnd(8)}  ` +
        `${c.from} → ${c.to}${c.long ? `  [${c.long}]` : ""}`,
    );
  }
  if (candidates.length > limit) console.log(`  … ${candidates.length - limit} more (raise --limit)`);

  // Printed last, so a truncated log still ends with the part you paste.
  // gtfs-sleeper's allowlist takes route NAMES, or {from,to} endpoint pairs for
  // feeds whose route names are not stable identifiers.
  const names = [...new Set(candidates.map((c) => c.long || c.short).filter(Boolean))];
  console.log(`\n[probe-gtfs] draft allowlist for data/sources/<operator>-sleepers.json:`);
  console.log(JSON.stringify({ routes: names.slice(0, limit) }, null, 2));
  console.log(
    "\n[probe-gtfs] Review it before committing — this heuristic finds overnight\n" +
      "             RUNS, and a feed may class a daytime long-distance service the\n" +
      "             same way. Keep only the ones that genuinely carry sleepers.",
  );

  if (!localDir) fs.rmSync(dir, { recursive: true, force: true });
}

// Importing this file must not fire a download: the test suite imports the
// pure helpers above.
if (process.argv[1] && process.argv[1].endsWith("probe-gtfs.mjs")) {
  main().catch((err) => {
    console.error("[probe-gtfs] fatal:", err);
    process.exit(1);
  });
}
