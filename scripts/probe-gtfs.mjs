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
// the sandbox), so output is capped and each feed's allowlist block is printed
// LAST — a tail of the log still carries the part you paste.
//
// --source also closes the other half of the loop. Drafting an allowlist is only
// the first question; the second is whether the one now committed resolves
// against the live feed, and without this the first answer would come from the
// nightly scrape after a merge. So --source runs the entry's real allowlist
// through gtfs-sleeper's own buildSleeperTrains and prints the trains it built.
//
//   node scripts/probe-gtfs.mjs                        # sweep the catalogue's
//                                                      # auth-free GTFS feeds
//   node scripts/probe-gtfs.mjs --url https://…/feed.zip
//   node scripts/probe-gtfs.mjs --source amtrak        # feedUrl from the registry,
//                                                      # and run its real allowlist
//   node scripts/probe-gtfs.mjs --verify-allowlists    # every committed allowlist
//                                                      # against its live feed
//   node scripts/probe-gtfs.mjs --dir ./unzipped-feed  # skip the download
//   node scripts/probe-gtfs.mjs --url … --min-hours 4 --limit 60

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadGtfs,
  loadGtfsDir,
  buildSleeperTrains,
  readCsv,
  stationNameCanonicalizer,
} from "./lib/gtfs.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { resolveCanonicalStationName } from "../src/pages/api/lib/primitives.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// How much stop_times.txt this probe will read into memory. Sized to clear any
// single operator's feed by a wide margin (SNCF's whole national rail timetable
// is 39 000 trips) while stopping a country's complete multimodal dataset.
const MAX_STOP_TIMES_BYTES = 400e6;

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
  secs === null
    ? "?"
    : `${Math.floor(secs / 3600)}h${String(Math.round((secs % 3600) / 60)).padStart(2, "0")}`;

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
export function isOvernightCandidate(
  { dep, arr },
  { minHours = 5, eveningFrom = EVENING_FROM_SECONDS } = {},
) {
  if (!Number.isFinite(dep) || !Number.isFinite(arr)) return false;
  if (arr >= 24 * 3600) return true;
  // The other way a feed says "next day": reset at midnight, so the arrival is
  // EARLIER in the day than the departure. This half was missing, and it is the
  // half that hides a night train rather than merely mistiming it — Entur
  // writes Oslo S 23:03 → Bergen 06:23 as 06:23, so arr - dep came out
  // NEGATIVE and every Norwegian night train read as no night train at all.
  // Guarding only the hours-≥-24 notation left exactly the bug this function
  // exists to prevent, pointing the other way.
  if (arr < dep) return true;
  return arr - dep >= minHours * 3600 && dep >= eveningFrom;
}

/**
 * One run per route, chosen the way the CONSUMER chooses it.
 *
 * gtfs-sleeper matches an allowlist against representativeTrip() in
 * scripts/lib/gtfs.mjs, which takes the trip with the MOST STATIONS. This probe
 * originally took the longest by duration — a different trip on any route that
 * groups several services, and SNCF groups plenty (one route there is named
 * "Paris - Latour-de-Carol" while its longest trip runs to Albi). Since the
 * endpoints printed here become {from,to} allowlist entries, choosing
 * differently from the adapter yields a config that silently matches nothing.
 *
 * `longest` rides along so a route whose fullest trip is a DAYTIME working can
 * still be flagged — there the allowlist would match and get a day train.
 *
 * Pure: takes plain GTFS tables, so a test can pin the alignment.
 *
 * @param {Array<{trip_id:string, route_id:string}>} trips
 * @param {Map<string, Array<{arrival:string, departure:string}>>} stopTimesByTrip
 * @returns {Map<string, object>} route_id → run, each carrying `.longest`
 */
// Does this run pass midnight, by either notation a feed may use for it?
// Mirrors crossesMidnight in gtfs.mjs, which is what the adapter's named
// entries are filtered on.
function isOvernight({ dep, arr }) {
  return arr >= 24 * 3600 || arr < dep;
}

export function selectRouteRuns(trips, stopTimesByTrip) {
  const best = new Map();
  for (const trip of trips ?? []) {
    const sts = stopTimesByTrip?.get(trip.trip_id);
    if (!sts || sts.length < 2) continue;
    const dep = toSeconds(sts[0].departure ?? sts[0].arrival);
    const arr = toSeconds(sts[sts.length - 1].arrival ?? sts[sts.length - 1].departure);
    if (dep === null || arr === null) continue;
    // Modulo a day, so a midnight-resetting feed reports a real duration
    // instead of a negative one — which also kept `longest` from ever picking
    // a night train on such a feed.
    const length = arr >= dep ? arr - dep : arr + 24 * 3600 - dep;
    const run = { trip, sts, dep, arr, length };
    const prev = best.get(trip.route_id);
    if (!prev) {
      best.set(trip.route_id, { ...run, longest: run, overnight: isOvernight(run) ? run : null });
      continue;
    }
    const longest = run.length > prev.longest.length ? run : prev.longest;
    // The fullest trip that actually runs through the night, kept separately
    // from the representative. On a national operator the night train is one
    // trip inside a line that also runs thirty day services, so the
    // representative is a day train and the night train is invisible — which
    // is exactly how Entur's F4 Oslo–Bergen, F6 Dovrebanen and F7
    // Nordlandsbanen read as "no night trains in this feed" twice over.
    const overnight =
      isOvernight(run) && (!prev.overnight || sts.length > prev.overnight.sts.length)
        ? run
        : prev.overnight;
    // Strictly greater, like representativeTrip's `>`: the first trip wins a
    // tie, and both iterate trips.txt in file order.
    best.set(
      trip.route_id,
      sts.length > prev.sts.length
        ? { ...run, longest, overnight }
        : { ...prev, longest, overnight },
    );
  }
  return best;
}

/**
 * Every GTFS feed in the research catalogue that needs no credentials — the
 * tier that can be built without waiting on anyone.
 *
 * This is the no-argument default because that is exactly what a
 * `pull_request`-triggered run gets: workflow inputs do not exist on that
 * event, and the useful question to ask with no input is "which of the open
 * feeds are real, and what is in them".
 *
 * @param {object} catalog data/sources/official-sources.json
 * @returns {Array<{operator:string, url:string, name:string}>}
 */
export function catalogueFeeds(catalog) {
  const out = [];
  for (const [operator, entry] of Object.entries(catalog?.operators ?? {})) {
    for (const src of entry?.sources ?? []) {
      if (!/gtfs/i.test(String(src?.format ?? ""))) continue;
      // Key-gated feeds need a scrape secret configured first; listing them
      // here would just produce a 401 per run.
      if (src?.auth && src.auth !== "none") continue;
      // Two kinds of URL the sweep has nothing left to learn from. A broken one
      // cannot start working until somebody edits the url — that is what broken
      // means here (a 406, or a documentation page where a zip should be) — and
      // `sweep: false` is for a source that works and is deliberately not used:
      // Entur's national aggregate is real, and re-downloading 3.5 GB every run
      // to print one "too big" line was three quarters of the sweep's time.
      if (src?.status === "broken") continue;
      if (src?.sweep === false) continue;
      if (!/^https?:\/\//.test(String(src?.url ?? ""))) continue;
      out.push({ operator, url: src.url, name: src.name ?? "GTFS" });
    }
  }
  return out;
}

/**
 * Download (or read) one feed and report what is in it.
 *
 * Returns false when the feed could not be fetched, rather than exiting — a
 * sweep must carry on to the next feed, since knowing which of several answer
 * is the whole point of running one.
 */
/**
 * Run a registry entry's committed allowlist through the adapter's own builder
 * and print what it produced. This is the check the nightly scrape would
 * otherwise be the first to perform: an entry that names a train the feed does
 * not carry, or spells a station differently, shows up here as an unmatched
 * line rather than as a missing route on the map a day later.
 */
export function reportAllowlist(entry, gtfs, limit = 40, rootDir = ROOT) {
  const configPath = entry?.params?.configPath;
  if (!configPath) return null;
  const full = path.join(rootDir, configPath);
  if (!fs.existsSync(full)) {
    console.log(`\n[probe-gtfs] ${entry.id}: ${configPath} does not exist yet`);
    return null;
  }

  let allowlist;
  try {
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    allowlist = Array.isArray(parsed) ? parsed : parsed?.routes;
    if (!Array.isArray(allowlist)) throw new Error("no routes array");
  } catch (err) {
    console.error(`\n[probe-gtfs] ${entry.id}: ${configPath} unreadable: ${err.message}`);
    return null;
  }

  const stats = {};
  let trains;
  try {
    trains = buildSleeperTrains({
      gtfs,
      allowlist,
      agency: entry.params?.agency || entry.id,
      operator: entry.params?.operator || entry.label,
      stats,
      stationRenames: entry.synthetic?.stationRenames,
      canonicalizeName: stationNameCanonicalizer(
        entry.params,
        resolveCanonicalStationName,
      ),
      log: (msg) => console.log(`  ${msg}`),
    });
  } catch (err) {
    console.error(`\n[probe-gtfs] ${entry.id}: buildSleeperTrains threw: ${err.message}`);
    return { built: [], unmatched: allowlist.map(String), threw: err.message };
  }

  const keys = Object.keys(trains);
  console.log(
    `\n[probe-gtfs] ${entry.id}: ${configPath} → ${keys.length} train(s) ` +
      `from ${allowlist.length} allowlist entr${allowlist.length === 1 ? "y" : "ies"}`,
  );
  for (const key of keys.slice(0, limit)) {
    const t = trains[key];
    const first = t.stations[0];
    const last = t.stations[t.stations.length - 1];
    console.log(
      `  ${key.padEnd(20)} ${String(t.stations.length).padStart(3)} stops  ` +
        `${(first.departure || "—").padStart(5)}→${(last.arrival || "—").padStart(5)}  ` +
        `${(t.frequency || "?").padEnd(24)}  ${first.name} → ${last.name}`,
    );
    // A via station only becomes a map dot under a name the payload already
    // knows, so the stop list is the part worth reading, not just the count.
    const via = t.stations.slice(1, -1).map((st) => st.name);
    if (via.length) console.log(`    via ${via.join(" - ")}`);
  }
  if (keys.length > limit) console.log(`  … ${keys.length - limit} more (raise --limit)`);

  // What each named entry swept up, which is the question a frequency of
  // "Daily" raises and nothing in the train list can answer. A named entry
  // matches on endpoints plus "runs past midnight" and nothing else, so a
  // corridor carrying two overnight trains gives both of them to whichever
  // entry names it — and the union then reports the days of both. If the
  // trains column shows one number per entry, that is not happening; if it
  // shows several, the entry is not addressing one train.
  if (stats.namedMatches && Object.keys(stats.namedMatches).length) {
    console.log(`\n[probe-gtfs] ${entry.id}: what each named entry matched`);
    console.log(
      `  ${"entry".padEnd(20)} ${"trips".padStart(5)} ${"svcs".padStart(5)}  ` +
        `${"dates".padEnd(21)} feed trip_short_name(s)`,
    );
    for (const [name, m] of Object.entries(stats.namedMatches)) {
      const span = m.firstDate ? `${m.firstDate}–${m.lastDate}` : "(none)";
      const names = m.shortNames.length ? m.shortNames.join(",") : "(feed carries none)";
      const flag = m.shortNames.length > 1 ? " ← several trains" : "";
      console.log(
        `  ${name.padEnd(20)} ${String(m.trips).padStart(5)} ${String(m.services).padStart(5)}  ` +
          `${span.padEnd(21)} ${names}${flag}`,
      );
    }
  }

  // The whole reason to run this before merging.
  if (stats.unmatched?.length) {
    console.log(
      `\n[probe-gtfs] ${entry.id}: ${stats.unmatched.length} allowlist entr` +
        `${stats.unmatched.length === 1 ? "y" : "ies"} matched NOTHING in the feed:`,
    );
    stats.unmatched.forEach((raw) => console.log(`  ✗ ${raw}`));
  } else {
    console.log(`[probe-gtfs] ${entry.id}: every allowlist entry matched`);
  }

  return { built: keys, unmatched: stats.unmatched ?? [] };
}

/**
 * The registry entries --verify-allowlists can actually check: the ones whose
 * trains come out of buildSleeperTrains. European Sleeper reads GTFS too, but
 * through its own date-expanded adapter, so running its file through this
 * builder would report a drift that does not exist.
 */
export function allowlistVerifiableSources(registry) {
  return (registry ?? []).filter(
    (e) =>
      e?.enabled &&
      e.adapter === "gtfs-sleeper" &&
      e.params?.configPath &&
      (e.params?.feedUrl || e.endpoint),
  );
}

async function probeFeed({ url, localDir = null, minHours = 5, limit = 40, entry = null }) {
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
      console.error(
        `[probe-gtfs] download failed [${cause.code ?? err.code ?? err.name}]: ${err.message}`,
      );
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    }
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  console.log(`[probe-gtfs] ${((Date.now() - t0) / 1000).toFixed(1)}s — tables: ${files.join(", ")}`);
  // No shapes.txt means the adapter must fall back to OSM geometry, which is
  // the single biggest cost difference between two otherwise identical feeds.
  console.log(
    `[probe-gtfs] shapes.txt: ${
      files.includes("shapes.txt") ? "present" : "NO — geometry would come from route-geometry.mjs"
    }`,
  );

  // Sizes before parsing, because loadGtfsDir reads stop_times.txt entirely
  // into memory and a national multimodal feed is a different order of
  // magnitude from a single operator's. The sweep is the default on every PR
  // now, so one oversized catalogue entry hanging it would take the probe down
  // for everything else — and "too big for the generic path" is itself the
  // finding, the one that says use the per-operator file instead.
  const sizes = files.map((f) => [f, fs.statSync(path.join(dir, f)).size]);
  console.log(
    `[probe-gtfs] sizes: ${sizes
      .map(([f, n]) => `${f} ${(n / 1e6).toFixed(1)} MB`)
      .join(", ")}`,
  );
  // Two ceilings, because the two files fail differently. An oversized
  // shapes.txt costs only geometry, and loadGtfsDir skips it (station chains
  // are the fallback, and SNCF has no shapes at all) — the feed is still fully
  // usable. An oversized stop_times.txt is the timetable itself, so there is
  // nothing to report and the feed is skipped.
  const stopTimesBytes = sizes.find(([f]) => f === "stop_times.txt")?.[1] ?? 0;
  if (stopTimesBytes > MAX_STOP_TIMES_BYTES) {
    console.log(
      `[probe-gtfs] NOT PARSED: stop_times.txt is ${(stopTimesBytes / 1e6).toFixed(0)} MB, over the ` +
        `${(MAX_STOP_TIMES_BYTES / 1e6).toFixed(0)} MB ceiling this probe reads into memory.\n` +
        "             The URL is right — the feed is simply a whole country's worth of\n" +
        "             every mode. Point the source at a per-operator file if one exists,\n" +
        "             or raise the ceiling deliberately for a one-off look.",
    );
    if (!localDir) fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  const gtfs = loadGtfsDir(dir);
  if (gtfs.shapesSkipped) {
    console.log(
      `[probe-gtfs] shapes.txt SKIPPED: ${(gtfs.shapesBytes / 1e6).toFixed(0)} MB is past the ` +
        "parse ceiling, so geometry here would be the station chain.\n" +
        "             Stops and times are unaffected — this feed is still usable.",
    );
  }
  console.log(
    `[probe-gtfs] ${gtfs.routesById.size} routes, ${gtfs.trips.length} trips, ` +
      `${gtfs.stopsById.size} stops, ${gtfs.calendarById.size} calendar services`,
  );

  const best = selectRouteRuns(gtfs.trips, gtfs.stopTimesByTrip);

  const candidates = [];
  for (const [routeId, r] of best) {
    const repIsNight = isOvernightCandidate(r, { minHours, eveningFrom });
    const anyIsNight =
      isOvernightCandidate(r.longest, { minHours, eveningFrom }) || Boolean(r.overnight);
    if (!repIsNight && !anyIsNight) continue;
    const route = gtfs.routesById.get(routeId) ?? {};
    // Report the night train when the route has one, even though the adapter's
    // representative is a day train: the endpoints and times of the train being
    // looked for are the useful thing to print, and dayTrainWarning still says
    // that a plain name or pair entry here would select the day train instead.
    const shown = repIsNight ? r : (r.overnight ?? r);
    candidates.push({
      short: (route.route_short_name || "").trim(),
      long: (route.route_long_name || "").trim(),
      from: gtfs.stopsById.get(shown.sts[0].stop_id)?.name ?? shown.sts[0].stop_id,
      to: gtfs.stopsById.get(shown.sts[shown.sts.length - 1].stop_id)?.name ?? "?",
      dep: shown.dep, arr: shown.arr, length: shown.length, stops: shown.sts.length,
      days: daysOf(gtfs.calendarById.get(shown.trip.service_id)),
      crossesMidnight: shown.arr >= 24 * 3600 || shown.arr < shown.dep,
      // The fullest trip is a daytime working and only some other trip on this
      // route runs overnight: an allowlist entry here matches the day train.
      dayTrainWarning: !repIsNight && anyIsNight,
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
        "             --min-hours.",
    );
  }

  // "Nothing found" has two very different causes — the heuristic missed the
  // trains, or the trains are not in this file — and only the route list tells
  // them apart. Entur's rb_vyg feed answered that in one glance: 24 routes, all
  // Oslo-area commuter lines, no F-line, so the night trains live under another
  // codespace and no amount of --min-hours would have found them.
  if (candidates.length <= 1) {
    const agencies = [
      ...new Set(
        readCsv(path.join(dir, "agency.txt"))
          .map((a) => a.agency_name)
          .filter(Boolean),
      ),
    ];
    if (agencies.length) {
      console.log(
        `[probe-gtfs] what this feed DOES carry — ${agencies.length} agenc${
          agencies.length === 1 ? "y" : "ies"
        }: ${agencies.slice(0, 12).join(", ")}${agencies.length > 12 ? ", …" : ""}`,
      );
    }
    const routeLabels = [...gtfs.routesById.values()]
      .map((r) =>
        [r.route_short_name, r.route_long_name].filter(Boolean).join(" ").trim() || r.route_id,
      )
      .sort();
    console.log(
      `[probe-gtfs] ${routeLabels.length} route(s): ${routeLabels.slice(0, limit).join(" | ")}` +
        (routeLabels.length > limit ? ` | … ${routeLabels.length - limit} more` : ""),
    );
  }

  for (const c of candidates.slice(0, limit)) {
    console.log(
      `  ${(c.short || "—").padEnd(10)} ${dur(c.length).padStart(6)}  ` +
        `${hhmm(c.dep)}→${hhmm(c.arr)}${c.crossesMidnight ? "+1" : "  "}  ` +
        `${String(c.stops).padStart(3)} stops  ${(c.days || "?").padEnd(8)}  ` +
        `${c.from} → ${c.to}${c.long ? `  [${c.long}]` : ""}` +
        `${c.dayTrainWarning ? "   ! fullest trip is a DAY train" : ""}`,
    );
  }
  if (candidates.length > limit) console.log(`  … ${candidates.length - limit} more (raise --limit)`);

  // Printed last, so a truncated log still ends with the part you paste.
  // gtfs-sleeper's allowlist takes route NAMES, or {from,to} endpoint pairs for
  // feeds whose route names are not stable identifiers.
  if (candidates.length > 0) {
    const usable = candidates.filter((c) => !c.dayTrainWarning).slice(0, limit);
    const names = [...new Set(usable.map((c) => c.long || c.short).filter(Boolean))];
    console.log(`\n[probe-gtfs] draft allowlist for data/sources/<operator>-sleepers.json:`);
    console.log(JSON.stringify({ routes: names }, null, 2));
    // Route names are not always usable: SNCF calls half of them "INCONNU" and
    // gives others a long name that contradicts the trip's own endpoints,
    // because one route groups several services. gtfs-sleeper also accepts
    // {from,to} pairs, matched against the representative trip's endpoints —
    // which is exactly what is printed above, so this form always works.
    console.log(`\n[probe-gtfs] …or as endpoint pairs, for a feed whose route names are unusable:`);
    console.log(JSON.stringify({ routes: usable.map((c) => ({ from: c.from, to: c.to })) }, null, 2));
    console.log(
      "\n[probe-gtfs] Review it before committing — this heuristic finds overnight\n" +
        "             RUNS, and a feed may class a daytime long-distance service the\n" +
        "             same way. Keep only the ones that genuinely carry sleepers.",
    );
  }

  // After the draft block, because an entry that already has an allowlist does
  // not need one drafted — but seeing both together is how you tell a missing
  // train from a misspelled one.
  if (entry) reportAllowlist(entry, gtfs, limit);

  if (!localDir) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

async function main() {
  const sourceId = arg("source");
  // An already-unzipped feed: lets you inspect one you downloaded by hand, and
  // lets the parsing half be exercised without any network at all.
  const localDir = arg("dir");
  let url = arg("url");
  const minHours = Number(arg("min-hours", "5"));
  const limit = Number(arg("limit", "40"));

  let entry = null;
  if (sourceId) {
    entry = loadRegistry().find((e) => e.id === sourceId) ?? null;
    if (!entry) {
      console.error(`[probe-gtfs] no registry source with id "${sourceId}"`);
      process.exit(1);
    }
    // --url wins, so a candidate feed can be tried against a committed
    // allowlist before the registry points at it.
    url ??= entry.params?.feedUrl ?? entry.endpoint ?? null;
    if (!url) {
      console.error(`[probe-gtfs] source "${sourceId}" declares no params.feedUrl`);
      process.exit(1);
    }
  }

  // Every committed allowlist against its live feed. This is the question a PR
  // asks — "does the allowlist I just wrote, or the one I did not touch, still
  // match the feed?" — and it is the one `gtfs-sleeper`'s own 0-of-N guard only
  // asks at 3 AM, after a merge. Naming one feed still wins over it: the flag
  // is a default for "nothing named", not an override of what you did name.
  if (!url && !localDir && process.argv.includes("--verify-allowlists")) {
    const entries = allowlistVerifiableSources(loadRegistry());
    console.log(
      `[probe-gtfs] verifying ${entries.length} committed allowlist(s) against their live feeds`,
    );
    let ok = 0;
    for (const e of entries) {
      console.log(`\n${"=".repeat(72)}\n== ${e.id} — ${e.label}\n${"=".repeat(72)}`);
      if (await probeFeed({ url: e.params.feedUrl ?? e.endpoint, minHours, limit, entry: e })) {
        ok++;
      }
    }
    console.log(`\n[probe-gtfs] ${ok}/${entries.length} feed(s) downloaded and parsed`);
    return;
  }

  // Nothing named: sweep the catalogue's open feeds.
  if (!url && !localDir) {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(ROOT, "data/sources/official-sources.json"), "utf8"),
    );
    const feeds = catalogueFeeds(catalog);
    console.log(`[probe-gtfs] no feed named — sweeping ${feeds.length} auth-free GTFS feed(s) from the catalogue`);
    let ok = 0;
    for (const feed of feeds) {
      console.log(`\n${"=".repeat(72)}\n== ${feed.operator} — ${feed.name}\n${"=".repeat(72)}`);
      if (await probeFeed({ url: feed.url, minHours, limit })) ok++;
    }
    console.log(`\n[probe-gtfs] ${ok}/${feeds.length} feed(s) downloaded and parsed`);
    // Not a failure: an unreachable feed is a finding, and the sweep reported it.
    return;
  }

  if (!(await probeFeed({ url, localDir, minHours, limit, entry }))) process.exit(1);
}

// Importing this file must not fire a download: the test suite imports the
// pure helpers above.
if (process.argv[1] && process.argv[1].endsWith("probe-gtfs.mjs")) {
  main().catch((err) => {
    console.error("[probe-gtfs] fatal:", err);
    process.exit(1);
  });
}
