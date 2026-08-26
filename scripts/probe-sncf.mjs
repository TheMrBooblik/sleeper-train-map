// scripts/probe-sncf.mjs
// One-shot reconnaissance for the SNCF (Intercités de Nuit) adapter. The dev
// sandbox has no egress to eu.ftp.opendatasoft.com / ressources.data.sncf.com,
// so this runs from CI ("Probe SNCF source" workflow) where egress is open.
//
// Unlike the ONCF probe, the *source* is not in doubt — SNCF publishes an
// official GTFS export of the theoretical timetable for the next ~151 days,
// covering TGV, Intercités and TER. What is in doubt is its **shape**, and
// three specific unknowns decide whether the generic gtfs-sleeper adapter can
// drive it at all:
//
//   1. SIZE. This is a national feed, not one operator's handful of routes.
//      loadGtfsDir() reads every table into memory; if stop_times.txt is
//      hundreds of MB the nightly job cannot use it as-is and we need a
//      streaming pre-filter. Measured before anything is parsed, so an OOM
//      later still leaves this answer in the artifact.
//
//   2. ROUTE GRANULARITY. buildSleeperTrains() groups trips by route_id and
//      emits one train per route. That works when a route *is* a named service
//      (Amtrak's "California Zephyr"). If SNCF models the whole night offer as
//      one "Intercités de Nuit" route, all nine corridors collapse into one
//      representative trip and the generic matcher is unusable — the allowlist
//      would have to key on trip_short_name (the train number) instead.
//
//   3. CALENDAR STYLE. A date-expanded feed (one trip and one service_id per
//      operating date, calendar_dates.txt only) is what made European Sleeper
//      need its own adapter. calendar.txt with weekday flags is the easy case.
//
// It also dry-runs the real matcher against data/sources/sncf-sleepers.json and
// reports what each allowlist entry actually hit, including over-matches: nine
// corridors that all start at Paris will happily match a daytime TGV if
// endpoint pairs are the only signal.
//
// Read-only: one GET of the published zip. Nothing else.
// Run: node scripts/probe-sncf.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { downloadGtfs, readCsv, loadGtfsDir, buildSleeperTrains } from "./lib/gtfs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const outDir = process.argv[2] ?? null;

const FEED_URL =
  "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip";
const CONFIG_PATH = path.join(ROOT, "data", "sources", "sncf-sleepers.json");
// Same naming as gtfs-sleeper.mjs's own working dir, so .gitignore's
// `gtfs-data/*-unpacked/` already covers it.
const WORK_DIR = path.join(ROOT, "gtfs-data", "sncf-probe-unpacked");

const report = { feedUrl: FEED_URL, startedAt: new Date().toISOString(), steps: {} };

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  fs.writeFileSync(path.join(outDir, name), text);
}

// Save what we know so far, so a later OOM/crash still leaves a usable artifact.
function checkpoint() {
  save("report.json", report);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Count lines without holding the file in memory — these tables can be huge.
async function countLines(file) {
  let n = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const _line of rl) n += 1;
  return Math.max(0, n - 1); // minus the header
}

// Stream trips.txt looking for the known night-train numbers, again without
// loading it. Returns the matching rows plus the header index map.
async function scanTrips(file, wanted) {
  const hits = [];
  let headers = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!headers) {
      headers = line.replace(/^﻿/, "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      continue;
    }
    // Cheap pre-filter before paying for a CSV split.
    if (!wanted.some((n) => line.includes(n))) continue;
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
    const short = String(row.trip_short_name ?? "").trim();
    if (!wanted.includes(short)) continue; // substring hit elsewhere in the line
    hits.push(row);
  }
  return { headers, hits };
}

// ── 0. Config ────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const trainNumbers = (config.trainNumbers ?? []).map(String);
console.log(`═══ config ═══`);
console.log(`  allowlist entries : ${(config.routes ?? []).length}`);
console.log(`  train numbers     : ${trainNumbers.join(", ") || "(none)"}`);
report.steps.config = { routes: config.routes ?? [], trainNumbers };
checkpoint();

// ── 1. Download ──────────────────────────────────────────────────────────────

console.log(`\n═══ download ═══\n  ${FEED_URL}`);
const t0 = Date.now();
try {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  await downloadGtfs(FEED_URL, WORK_DIR);
  report.steps.download = { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(`  ok in ${report.steps.download.seconds}s`);
} catch (err) {
  report.steps.download = { ok: false, error: err.message };
  console.error(`  FAILED: ${err.message}`);
  checkpoint();
  console.error("\n[probe] cannot continue without the feed.");
  process.exit(0); // artifact still uploads
}

// ── 2. Size and table inventory (before parsing anything) ────────────────────

console.log(`\n═══ feed inventory ═══`);
const files = fs
  .readdirSync(WORK_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort();
const inventory = [];
for (const f of files) {
  const full = path.join(WORK_DIR, f);
  const bytes = fs.statSync(full).size;
  // Only count rows on tables small enough that it is quick; the big ones get
  // an estimate from bytes so we never trade minutes for a nice number.
  const rows = bytes < 200 * 1024 * 1024 ? await countLines(full) : null;
  inventory.push({ file: f, bytes, rows });
  console.log(`  ${f.padEnd(24)} ${mb(bytes).padStart(10)}  ${rows === null ? "(too big to count)" : `${rows} rows`}`);
}
report.steps.inventory = inventory;

const stopTimes = inventory.find((i) => i.file === "stop_times.txt");
const feasible = stopTimes ? stopTimes.bytes < 512 * 1024 * 1024 : false;
console.log(
  `\n  VERDICT on size: stop_times.txt is ${stopTimes ? mb(stopTimes.bytes) : "missing"} — ` +
    (feasible
      ? "loadGtfsDir() should cope; the generic adapter can read this in the nightly job."
      : "TOO BIG for loadGtfsDir(); the adapter needs a streaming pre-filter on trip_short_name."),
);
report.steps.sizeVerdict = { stopTimesBytes: stopTimes?.bytes ?? null, feasible };
checkpoint();

// ── 3. Routes: is a night train a route, or a trip? ──────────────────────────

console.log(`\n═══ routes.txt ═══`);
const routes = readCsv(path.join(WORK_DIR, "routes.txt"));
console.log(`  ${routes.length} routes`);
const nightish = routes.filter((r) =>
  /nuit|night|intercit/i.test(`${r.route_long_name} ${r.route_short_name} ${r.route_id}`),
);
console.log(`  routes whose name mentions nuit/night/intercités: ${nightish.length}`);
for (const r of nightish.slice(0, 40)) {
  console.log(`    ${r.route_id} | short="${r.route_short_name}" | long="${r.route_long_name}" | type=${r.route_type}`);
}
console.log(`\n  first 15 routes of any kind, for naming style:`);
for (const r of routes.slice(0, 15)) {
  console.log(`    ${r.route_id} | short="${r.route_short_name}" | long="${r.route_long_name}" | type=${r.route_type}`);
}
report.steps.routes = {
  count: routes.length,
  nightish: nightish.map((r) => ({
    route_id: r.route_id,
    route_short_name: r.route_short_name,
    route_long_name: r.route_long_name,
    route_type: r.route_type,
  })),
  sample: routes.slice(0, 15),
};
save("routes.txt", fs.readFileSync(path.join(WORK_DIR, "routes.txt"), "utf8"));
checkpoint();

// ── 4. Do our train numbers exist, and under which routes? ───────────────────

console.log(`\n═══ trips.txt — the nine Intercités de Nuit ═══`);
const { hits } = await scanTrips(path.join(WORK_DIR, "trips.txt"), trainNumbers);
console.log(`  trips whose trip_short_name is one of ours: ${hits.length}`);

const byNumber = {};
for (const h of hits) {
  const n = String(h.trip_short_name).trim();
  (byNumber[n] ??= []).push(h);
}
for (const n of trainNumbers) {
  const rows = byNumber[n] ?? [];
  if (!rows.length) {
    console.log(`    ${n.padEnd(6)} NOT FOUND`);
    continue;
  }
  const routeIds = [...new Set(rows.map((r) => r.route_id))];
  const shapes = [...new Set(rows.map((r) => r.shape_id).filter(Boolean))];
  console.log(
    `    ${n.padEnd(6)} ${String(rows.length).padStart(4)} trip(s) | routes: ${routeIds.slice(0, 3).join(", ")}${routeIds.length > 3 ? ` +${routeIds.length - 3}` : ""} | shape_ids: ${shapes.length}`,
  );
}
// One trip per operating date, or one trip per service pattern? This is the
// European Sleeper trap: a date-expanded feed needs its own adapter.
const tripsPerNumber = Object.values(byNumber).map((r) => r.length);
const maxTrips = tripsPerNumber.length ? Math.max(...tripsPerNumber) : 0;
console.log(
  `\n  VERDICT on granularity: max ${maxTrips} trips for a single train number — ` +
    (maxTrips > 20
      ? "looks DATE-EXPANDED (one trip per operating date), like the European Sleeper feed."
      : "looks pattern-based; the generic adapter's representativeTrip() is fine."),
);
report.steps.trips = {
  found: hits.length,
  byNumber: Object.fromEntries(
    Object.entries(byNumber).map(([n, rows]) => [
      n,
      {
        trips: rows.length,
        routeIds: [...new Set(rows.map((r) => r.route_id))],
        shapeIds: [...new Set(rows.map((r) => r.shape_id).filter(Boolean))].length,
        sample: rows[0],
      },
    ]),
  ),
  missing: trainNumbers.filter((n) => !byNumber[n]),
  dateExpanded: maxTrips > 20,
};
save("night-trips.json", report.steps.trips);
checkpoint();

// ── 5. Calendar style ────────────────────────────────────────────────────────

console.log(`\n═══ calendar ═══`);
const hasCalendar = fs.existsSync(path.join(WORK_DIR, "calendar.txt"));
const hasCalendarDates = fs.existsSync(path.join(WORK_DIR, "calendar_dates.txt"));
console.log(`  calendar.txt: ${hasCalendar ? "present" : "ABSENT"} | calendar_dates.txt: ${hasCalendarDates ? "present" : "absent"}`);
if (hasCalendar) {
  const cal = readCsv(path.join(WORK_DIR, "calendar.txt"));
  console.log(`  ${cal.length} service patterns; sample: ${JSON.stringify(cal[0] ?? null)}`);
  report.steps.calendar = { style: "weekday-flags", count: cal.length, sample: cal[0] ?? null };
} else {
  console.log(`  no calendar.txt — service days come from calendar_dates.txt only (date-expanded).`);
  report.steps.calendar = { style: "dates-only" };
}
const hasShapes = fs.existsSync(path.join(WORK_DIR, "shapes.txt"));
console.log(`  shapes.txt: ${hasShapes ? "present — real track geometry" : "ABSENT — polylines fall back to the station chain"}`);
report.steps.shapes = { present: hasShapes };
checkpoint();

// ── 6. Dry-run the real matcher ──────────────────────────────────────────────
// The point of the whole probe: would scripts/adapters/gtfs-sleeper.mjs, run
// unchanged against this feed and our committed allowlist, produce the nine
// corridors — and only those?

console.log(`\n═══ dry run: buildSleeperTrains() with the committed allowlist ═══`);
if (!feasible) {
  console.log(`  SKIPPED — stop_times.txt is too large to load; see the size verdict above.`);
  report.steps.dryRun = { skipped: "stop_times too large" };
} else {
  try {
    const gtfs = loadGtfsDir(WORK_DIR);
    const stats = {};
    const trains = buildSleeperTrains({
      gtfs,
      allowlist: config.routes ?? [],
      agency: "SNCF",
      operator: "SNCF",
      log: (m) => console.log(`    ${m}`),
      stats,
    });
    const built = Object.entries(trains).map(([name, t]) => ({
      name,
      stations: t.stations.length,
      origin: t.stations[0]?.name ?? null,
      destination: t.stations[t.stations.length - 1]?.name ?? null,
      frequency: t.frequency,
      polylineChars: t.polyline?.length ?? 0,
    }));
    console.log(`\n  built ${built.length} train(s) from ${stats.feedRouteCount} feed routes:`);
    for (const b of built) {
      console.log(`    ${b.name} — ${b.origin} → ${b.destination} (${b.stations} stops, ${b.frequency})`);
    }
    if (stats.unmatched?.length) {
      console.log(`\n  allowlist entries that matched nothing: ${stats.unmatched.join(", ")}`);
    }
    console.log(
      `\n  VERDICT: ${built.length === (config.routes ?? []).length ? "clean 1:1 match — the generic adapter works as-is." : "MISMATCH — expected " + (config.routes ?? []).length + " corridors, got " + built.length + ". Check for over-matched daytime services or collapsed routes above."}`,
    );
    report.steps.dryRun = { built, matched: stats.matched, unmatched: stats.unmatched, feedRouteCount: stats.feedRouteCount };
    save("dry-run.json", report.steps.dryRun);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    report.steps.dryRun = { error: err.message, stack: err.stack?.split("\n").slice(0, 5) };
  }
}

// ── 7. Would the Back-on-Track rows actually be superseded? ──────────────────
// The trap this probe exists to catch as much as the size one. dropBotRowsExact()
// (src/pages/api/lib/build-initial-data.mjs) compares Back-on-Track's
// trip_short_name against the KEYS of the trains dict. buildSleeperTrains keys
// by route name — Amtrak gets away with that because it has no Back-on-Track
// rows to dedup, but SNCF has nine. If the keys are route names and BoT says
// "IC Nuit 5789", nothing matches and the map ends up drawing both.

console.log(`\n═══ would Back-on-Track's nine rows be superseded? ═══`);
const BOT_TRAIN_NAMES = (config.corridors ?? []).flatMap((c) =>
  (c.trains ?? []).map((n) => `IC Nuit ${n}`),
);
const builtKeys = Object.keys(report.steps.dryRun?.built ? Object.fromEntries(report.steps.dryRun.built.map((b) => [b.name, b])) : {});
if (!builtKeys.length) {
  console.log(`  no trains built — cannot tell. Resolve the steps above first.`);
  report.steps.dedup = { skipped: true };
} else {
  const keySet = new Set(builtKeys);
  const wouldDrop = BOT_TRAIN_NAMES.filter((n) => keySet.has(n));
  const bare = new Set(builtKeys.map((k) => k.replace(/^IC\s+Nuit\s+/i, "").trim()));
  const wouldDropBare = trainNumbers.filter((n) => bare.has(n));
  console.log(`  trains dict keys look like: ${builtKeys.slice(0, 5).map((k) => JSON.stringify(k)).join(", ")}`);
  console.log(`  dedupStrategy "exact" would drop ${wouldDrop.length} of ${BOT_TRAIN_NAMES.length} BoT train numbers`);
  console.log(`  a bare-number strategy would drop ${wouldDropBare.length} of ${trainNumbers.length}`);
  console.log(
    `\n  VERDICT: ` +
      (wouldDrop.length
        ? `"exact" works — keys already carry BoT's numbering.`
        : wouldDropBare.length
          ? `needs a bare-number dedup strategy (like "icn" does for Trenitalia), or an enrich trainsByNumber config that upgrades the BoT rows in place instead of replacing them.`
          : `NEITHER works — the trains dict is keyed by route name, so buildSleeperTrains must be taught to key by trip_short_name before SNCF can supersede or enrich the Back-on-Track rows.`),
  );
  report.steps.dedup = { builtKeys, wouldDropExact: wouldDrop, wouldDropBare };
}
checkpoint();

report.finishedAt = new Date().toISOString();
checkpoint();
console.log(
  outDir
    ? `\n[probe] report written to ${outDir}/report.json — download the workflow artifact, then finish the sncf registry entry (and extend scripts/lib/gtfs.mjs if the dry run says the generic matcher is not enough) and flip enabled:true`
    : "\n[probe] pass an output dir to also save the report and snapshots",
);
