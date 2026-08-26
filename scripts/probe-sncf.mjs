// scripts/probe-sncf.mjs
// Reconnaissance for the SNCF (Intercités de Nuit) adapter. The dev sandbox has
// no egress to eu.ftp.opendatasoft.com, so this runs locally or from CI ("Probe
// SNCF source") where egress is open.
//
// Three rounds have run against the real feed and settled its shape. What they
// found, because each answer rules out an approach that would otherwise look
// reasonable:
//
//   • The train number is in trip_headsign. trip_short_name is empty on all
//     43,425 trips, so an allowlist keyed on it finds nothing — which is what
//     round 1 reported, misleadingly, for all sixteen numbers.
//   • Routes are TER/Intercités *lines* ("P53", "Bening - Sarreguemines"), not
//     named services, and one route_id bundles several corridors. Grouping by
//     route — what buildSleeperTrains() does — is structurally wrong here.
//   • Endpoint pairs cannot separate a night train from a TGV on the same city
//     pair. Nine corridors matched thirteen routes, four of them daytime TGV.
//
// What does work, and what this probe now measures: a trip crosses midnight
// (GTFS encodes after-midnight as 24:xx, so the test is exact) AND runs >= 7h,
// over route_type=2. The shortest real sleeper is 8h29 and the longest false
// positive 5h34, so the threshold has room on both sides. That yields the whole
// French night-train offer with no naming assumptions — see overnightTrips() in
// scripts/lib/gtfs.mjs, which is shared because CFR, MÁV and DELFI pose the
// same question.
//
// The disproved approaches are recorded in data/sources/sncf-sleepers.json
// under `disproved` rather than kept running here.
//
// Read-only: one GET of the published zip. Nothing else.
// Run: node scripts/probe-sncf.mjs [outputDir] [--fresh] [--fixture]
//   --fresh    re-download instead of reusing gtfs-data/sncf-probe-unpacked
//   --fixture  write tests/fixtures/sncf-gtfs/ for offline adapter work

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { downloadGtfs, readCsv, loadGtfsDir } from "./lib/gtfs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const outDir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
const hasFlag = (name) => flags.includes(name);

const FEED_URL =
  "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip";
const CONFIG_PATH = path.join(ROOT, "data", "sources", "sncf-sleepers.json");
// Same naming as gtfs-sleeper.mjs's own working dir, so .gitignore's
// `gtfs-data/*-unpacked/` already covers it.
const WORK_DIR = path.join(ROOT, "gtfs-data", "sncf-probe-unpacked");

const report = {
  feedUrl: FEED_URL,
  startedAt: new Date().toISOString(),
  steps: {},
};

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

// ── 0. Config ────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const trainNumbers = (config.trainNumbers ?? []).map(String);
console.log(`═══ config ═══`);
console.log(
  `  train numbers : ${trainNumbers.length} — ${trainNumbers.join(", ") || "(none)"}`,
);
console.log(`  corridors     : ${(config.corridors ?? []).length}`);
report.steps.config = {
  trainNumbers,
  corridors: config.corridors ?? [],
};
checkpoint();

// ── 1. Download ──────────────────────────────────────────────────────────────

console.log(`\n═══ download ═══\n  ${FEED_URL}`);
const t0 = Date.now();
const alreadyUnpacked = fs.existsSync(path.join(WORK_DIR, "trips.txt"));
try {
  if (alreadyUnpacked && !hasFlag("--fresh")) {
    // Re-running the probe to answer follow-up questions should not re-download
    // 58 MB. Pass --fresh to force it.
    console.log(`  reusing ${WORK_DIR} (pass --fresh to re-download)`);
  } else {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    await downloadGtfs(FEED_URL, WORK_DIR);
  }
  report.steps.download = {
    ok: true,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
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
  console.log(
    `  ${f.padEnd(24)} ${mb(bytes).padStart(10)}  ${rows === null ? "(too big to count)" : `${rows} rows`}`,
  );
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
report.steps.sizeVerdict = {
  stopTimesBytes: stopTimes?.bytes ?? null,
  feasible,
};
checkpoint();

// ── 3. Routes: is a night train a route, or a trip? ──────────────────────────

console.log(`\n═══ routes.txt ═══`);
const routes = readCsv(path.join(WORK_DIR, "routes.txt"));
console.log(`  ${routes.length} routes`);
const nightish = routes.filter((r) =>
  /nuit|night|intercit/i.test(
    `${r.route_long_name} ${r.route_short_name} ${r.route_id}`,
  ),
);
console.log(
  `  routes whose name mentions nuit/night/intercités: ${nightish.length}`,
);
for (const r of nightish.slice(0, 40)) {
  console.log(
    `    ${r.route_id} | short="${r.route_short_name}" | long="${r.route_long_name}" | type=${r.route_type}`,
  );
}
console.log(`\n  first 15 routes of any kind, for naming style:`);
for (const r of routes.slice(0, 15)) {
  console.log(
    `    ${r.route_id} | short="${r.route_short_name}" | long="${r.route_long_name}" | type=${r.route_type}`,
  );
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

// ── 4. Calendar style ────────────────────────────────────────────────────────

console.log(`\n═══ calendar ═══`);
const hasCalendar = fs.existsSync(path.join(WORK_DIR, "calendar.txt"));
const hasCalendarDates = fs.existsSync(
  path.join(WORK_DIR, "calendar_dates.txt"),
);
console.log(
  `  calendar.txt: ${hasCalendar ? "present" : "ABSENT"} | calendar_dates.txt: ${hasCalendarDates ? "present" : "absent"}`,
);
if (hasCalendar) {
  const cal = readCsv(path.join(WORK_DIR, "calendar.txt"));
  console.log(
    `  ${cal.length} service patterns; sample: ${JSON.stringify(cal[0] ?? null)}`,
  );
  report.steps.calendar = {
    style: "weekday-flags",
    count: cal.length,
    sample: cal[0] ?? null,
  };
} else {
  console.log(
    `  no calendar.txt — service days come from calendar_dates.txt only (date-expanded).`,
  );
  report.steps.calendar = { style: "dates-only" };
}
const hasShapes = fs.existsSync(path.join(WORK_DIR, "shapes.txt"));
console.log(
  `  shapes.txt: ${hasShapes ? "present — real track geometry" : "ABSENT — polylines fall back to the station chain"}`,
);
report.steps.shapes = { present: hasShapes };
checkpoint();

// ── 5. What DO the trip identifiers hold? ────────────────────────────────────
// Round 1 found none of the sixteen train numbers in trip_short_name, and the
// routes turned out to be TER/Intercités *lines* ("P53", "Bening -
// Sarreguemines") rather than named services — so neither the allowlist's
// endpoint pairs nor a train number can key this feed as it stands. Before
// writing an adapter we need to know what identifiers the feed actually
// carries.

function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"' && q && line[i + 1] === '"') {
      cur += '"';
      i += 1;
      continue;
    }
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === "," && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

async function streamCsv(file, onRow) {
  let headers = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = splitCsv(line.replace(/^﻿/, "")).map((h) => h.trim());
      continue;
    }
    const cells = splitCsv(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    onRow(row);
  }
  return headers;
}

console.log(`\n═══ trips.txt field survey ═══`);
const tripsById = new Map();
const shortNameSamples = new Set();
const headsignSamples = new Set();
let shortNameFilled = 0;
let headsignFilled = 0;
const tripHeaders = await streamCsv(path.join(WORK_DIR, "trips.txt"), (row) => {
  tripsById.set(row.trip_id, row);
  if (String(row.trip_short_name ?? "").trim()) {
    shortNameFilled += 1;
    if (shortNameSamples.size < 20) shortNameSamples.add(row.trip_short_name);
  }
  if (String(row.trip_headsign ?? "").trim()) {
    headsignFilled += 1;
    if (headsignSamples.size < 20) headsignSamples.add(row.trip_headsign);
  }
});
console.log(`  columns          : ${tripHeaders.join(", ")}`);
console.log(`  trips            : ${tripsById.size}`);
console.log(
  `  trip_short_name  : ${shortNameFilled} non-empty | samples: ${[...shortNameSamples].slice(0, 10).join(" · ") || "(all empty)"}`,
);
console.log(
  `  trip_headsign    : ${headsignFilled} non-empty | samples: ${[...headsignSamples].slice(0, 10).join(" · ") || "(all empty)"}`,
);
report.steps.tripFields = {
  columns: tripHeaders,
  trips: tripsById.size,
  shortNameFilled,
  shortNameSamples: [...shortNameSamples],
  headsignFilled,
  headsignSamples: [...headsignSamples],
};
checkpoint();

// ── 6. Find the night trains by what makes them night trains ─────────────────
// Feed-agnostic and far sturdier than any naming convention: a sleeper is a
// trip whose stop_times cross midnight. GTFS encodes after-midnight as 24:xx,
// 25:xx… so "any time >= 24:00:00" is an exact test, and it is the same signal
// every other national feed will offer (CFR, MÁV, DELFI…).

console.log(`\n═══ overnight trips (stop_times crossing 24:00) ═══`);
const stopsById = new Map();
await streamCsv(path.join(WORK_DIR, "stops.txt"), (row) => {
  stopsById.set(row.stop_id, {
    name: (row.stop_name || row.stop_id).trim(),
    lat: Number.parseFloat(row.stop_lat),
    lon: Number.parseFloat(row.stop_lon),
  });
});

const routesById2 = new Map(routes.map((r) => [r.route_id, r]));
const agg = new Map(); // trip_id → { minSeq, maxSeq, firstStop, lastStop, firstDep, lastArr, stops, crosses }
const toSecs = (t) => {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(String(t).trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};
await streamCsv(path.join(WORK_DIR, "stop_times.txt"), (row) => {
  const id = row.trip_id;
  const seq = Number.parseInt(row.stop_sequence, 10);
  if (!id || !Number.isFinite(seq)) return;
  let a = agg.get(id);
  if (!a) {
    a = { minSeq: Infinity, maxSeq: -Infinity, stops: 0, crosses: false };
    agg.set(id, a);
  }
  a.stops += 1;
  const arr = toSecs(row.arrival_time);
  const dep = toSecs(row.departure_time);
  if ((arr !== null && arr >= 86400) || (dep !== null && dep >= 86400))
    a.crosses = true;
  if (seq < a.minSeq) {
    a.minSeq = seq;
    a.firstStop = row.stop_id;
    a.firstDep = row.departure_time;
  }
  if (seq > a.maxSeq) {
    a.maxSeq = seq;
    a.lastStop = row.stop_id;
    a.lastArr = row.arrival_time;
  }
});

const overnight = [];
for (const [tripId, a] of agg) {
  if (!a.crosses) continue;
  const trip = tripsById.get(tripId);
  if (!trip) continue;
  const route = routesById2.get(trip.route_id);
  overnight.push({
    trip_id: tripId,
    route_id: trip.route_id,
    route_type: route?.route_type ?? null,
    route_short_name: route?.route_short_name ?? "",
    route_long_name: route?.route_long_name ?? "",
    trip_short_name: trip.trip_short_name ?? "",
    trip_headsign: trip.trip_headsign ?? "",
    service_id: trip.service_id ?? "",
    shape_id: trip.shape_id ?? "",
    origin: stopsById.get(a.firstStop)?.name ?? a.firstStop,
    destination: stopsById.get(a.lastStop)?.name ?? a.lastStop,
    departure: a.firstDep,
    arrival: a.lastArr,
    stops: a.stops,
  });
}
const rail = overnight.filter((o) => String(o.route_type) === "2");
console.log(
  `  trips crossing midnight: ${overnight.length} (of ${agg.size}) — rail (route_type=2): ${rail.length}`,
);
// Collapse to distinct corridors so the list is readable: same endpoints + times.
const corridorKey = (o) => `${o.origin} → ${o.destination} ${o.departure}`;
const distinct = new Map();
for (const o of rail) {
  const k = corridorKey(o);
  if (!distinct.has(k)) distinct.set(k, { ...o, tripCount: 0 });
  distinct.get(k).tripCount += 1;
}
console.log(`  distinct overnight rail corridors: ${distinct.size}`);
for (const o of [...distinct.values()]
  .sort((a, b) => b.tripCount - a.tripCount)
  .slice(0, 40)) {
  console.log(
    `    ${String(o.tripCount).padStart(4)}× ${o.origin} ${o.departure} → ${o.destination} ${o.arrival} | ${o.stops} stops | route "${o.route_long_name || o.route_short_name || o.route_id}" | short="${o.trip_short_name}" headsign="${o.trip_headsign}"`,
  );
}
report.steps.overnight = {
  crossingMidnight: overnight.length,
  rail: rail.length,
  distinctCorridors: distinct.size,
  corridors: [...distinct.values()].sort((a, b) => b.tripCount - a.tripCount),
};
save("overnight.json", report.steps.overnight);
checkpoint();

// ── 7. The nine corridors we actually want ──────────────────────────────────

console.log(`\n═══ the nine Back-on-Track corridors, found by endpoints ═══`);
const norm = (x) =>
  String(x || "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
const CORRIDOR_TARGETS = [
  { bot: "107", a: "paris austerlitz", b: "briancon" },
  { bot: "108", a: "paris austerlitz", b: "nice" },
  { bot: "109", a: "paris austerlitz", b: "albi" },
  { bot: "110", a: "paris austerlitz", b: "cerbere" },
  { bot: "111", a: "paris austerlitz", b: "tarbes" },
  { bot: "112", a: "paris austerlitz", b: "latour" },
  { bot: "119", a: "paris austerlitz", b: "rodez" },
  { bot: "262", a: "paris austerlitz", b: "aurillac" },
  { bot: "264", a: "paris austerlitz", b: "toulouse matabiau" },
];
const found = {};
for (const t of CORRIDOR_TARGETS) {
  const hits = rail.filter((o) => {
    const o1 = norm(o.origin);
    const o2 = norm(o.destination);
    return (
      (o1.includes(t.a) && o2.includes(t.b)) ||
      (o1.includes(t.b) && o2.includes(t.a))
    );
  });
  const byPattern = new Map();
  for (const h of hits) {
    const k = `${h.origin}|${h.destination}|${h.departure}|${h.trip_short_name}`;
    if (!byPattern.has(k)) byPattern.set(k, { ...h, dates: 0 });
    byPattern.get(k).dates += 1;
  }
  found[t.bot] = [...byPattern.values()];
  console.log(
    `\n  BoT ${t.bot} — ${t.a} ↔ ${t.b}: ${hits.length} overnight trip(s), ${byPattern.size} pattern(s)`,
  );
  for (const p of [...byPattern.values()].slice(0, 6)) {
    console.log(
      `      ${p.origin} ${p.departure} → ${p.destination} ${p.arrival} | ${p.stops} stops | ${p.dates} date(s) | short="${p.trip_short_name}" headsign="${p.trip_headsign}" | route "${p.route_long_name || p.route_short_name}" (${p.route_id})`,
    );
  }
  if (!hits.length) console.log(`      NOT FOUND as an overnight rail trip`);
}
report.steps.corridors = found;
save("corridors.json", found);

// One full stop list, so the adapter author can see what a night trip looks like.
const sample = Object.values(found).flat()[0] ?? null;
if (sample) {
  const seqs = [];
  await streamCsv(path.join(WORK_DIR, "stop_times.txt"), (row) => {
    if (row.trip_id !== sample.trip_id) return;
    seqs.push({
      seq: Number.parseInt(row.stop_sequence, 10),
      stop: stopsById.get(row.stop_id)?.name ?? row.stop_id,
      arr: row.arrival_time,
      dep: row.departure_time,
    });
  });
  seqs.sort((a, b) => a.seq - b.seq);
  console.log(
    `\n  full stop list for ${sample.trip_id} (${sample.origin} → ${sample.destination}):`,
  );
  for (const st of seqs)
    console.log(
      `      ${String(st.seq).padStart(3)} ${st.stop.padEnd(38)} ${st.arr} / ${st.dep}`,
    );
  report.steps.sampleTrip = { ...sample, stops: seqs };
  save("sample-trip.json", report.steps.sampleTrip);
}
checkpoint();

// ── 8. The definitive list: every French night train in the feed ────────────
// Round 2 established the two facts this step rests on. trip_short_name is
// empty on all 43,425 trips and the train number lives in trip_headsign — so
// round 1's "NOT FOUND" for all sixteen numbers was looking at the wrong
// field, and is not evidence the trains are absent. And crossing midnight
// alone is necessary but not sufficient: it also catches TER running an hour
// past midnight (Mulhouse → Strasbourg, 1h10) and late TGV. Duration
// separates them cleanly — the shortest real sleeper here is Toulouse → Paris
// at 8h35, the longest false positive is a Paris → Nice TGV at 5h34, so 7h
// sits in the gap with room on both sides.
//
// Applied together over route_type=2, this is the whole French night-train
// offer as the operator publishes it, with no naming assumptions at all. The
// cross-reference then answers the question the adapter turns on: does the
// feed still carry every number Back-on-Track claims, and does it carry any
// that Back-on-Track has missed?

const MIN_OVERNIGHT_SECONDS = 7 * 3600;

console.log(`\n═══ feed validity ═══`);
const feedInfo = readCsv(path.join(WORK_DIR, "feed_info.txt"))[0] ?? null;
console.log(`  ${feedInfo ? JSON.stringify(feedInfo) : "(no feed_info.txt)"}`);
report.steps.feedInfo = feedInfo;

console.log(
  `\n═══ every night train in the feed (crosses midnight, >= 7h, rail) ═══`,
);
const durationOf = (a) => {
  const dep = toSecs(a.firstDep);
  const arr = toSecs(a.lastArr);
  return dep === null || arr === null ? null : arr - dep;
};
const byHeadsign = new Map();
for (const [tripId, a] of agg) {
  if (!a.crosses) continue;
  const trip = tripsById.get(tripId);
  if (!trip) continue;
  const route = routesById2.get(trip.route_id);
  if (String(route?.route_type) !== "2") continue;
  const secs = durationOf(a);
  if (secs === null || secs < MIN_OVERNIGHT_SECONDS) continue;

  const number = String(trip.trip_headsign ?? "").trim() || "(no headsign)";
  let g = byHeadsign.get(number);
  if (!g) {
    g = {
      number,
      trips: 0,
      patterns: new Map(),
      routeNames: new Set(),
      maxStops: 0,
      minSecs: Infinity,
      maxSecs: 0,
    };
    byHeadsign.set(number, g);
  }
  g.trips += 1;
  g.maxStops = Math.max(g.maxStops, a.stops);
  g.minSecs = Math.min(g.minSecs, secs);
  g.maxSecs = Math.max(g.maxSecs, secs);
  if (route?.route_long_name) g.routeNames.add(route.route_long_name);
  const origin = stopsById.get(a.firstStop)?.name ?? a.firstStop;
  const destination = stopsById.get(a.lastStop)?.name ?? a.lastStop;
  const key = `${origin}|${destination}`;
  const pat = g.patterns.get(key) ?? {
    origin,
    destination,
    dates: 0,
    stops: a.stops,
    departure: a.firstDep,
    arrival: a.lastArr,
  };
  pat.dates += 1;
  // Keep the longest stop list seen for this endpoint pair, for reference; the
  // adapter should pick the MODAL one (most dates), which is why dates is kept.
  if (a.stops > pat.stops) pat.stops = a.stops;
  g.patterns.set(key, pat);
}

const hhmm = (secs) =>
  `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}`;
const nightTrains = [...byHeadsign.values()].sort((a, b) => b.trips - a.trips);
console.log(
  `  ${nightTrains.length} distinct headsign numbers, ${nightTrains.reduce((n, g) => n + g.trips, 0)} trips\n`,
);
for (const g of nightTrains) {
  const pats = [...g.patterns.values()].sort((a, b) => b.dates - a.dates);
  const main = pats[0];
  console.log(
    `    ${g.number.padEnd(8)} ${String(g.trips).padStart(3)} trips | ${hhmm(g.minSecs)}–${hhmm(g.maxSecs)} | ${main.origin} → ${main.destination} (${main.stops} stops, ${main.dates}/${g.trips} dates)${pats.length > 1 ? ` | +${pats.length - 1} other endpoint pair(s)` : ""} | route "${[...g.routeNames][0] ?? "—"}"`,
  );
}

// Cross-reference both ways against what Back-on-Track claims.
const feedNumbers = new Set(nightTrains.map((g) => g.number));
const missing = trainNumbers.filter((n) => !feedNumbers.has(n));
const extra = [...feedNumbers].filter(
  (n) => !trainNumbers.includes(n) && /^\d+$/.test(n),
);
console.log(
  `\n  Back-on-Track numbers the feed does NOT carry as a night train: ${missing.join(", ") || "(none)"}`,
);
console.log(
  `  night trains in the feed that Back-on-Track does not list      : ${extra.join(", ") || "(none)"}`,
);
console.log(
  `\n  VERDICT: ` +
    (missing.length === 0
      ? "every Back-on-Track number is present — enrich the nine rows in place, keyed by number."
      : `${missing.length} number(s) are stale in Back-on-Track. Those rows cannot be enriched by number; the feed's own numbering has to win, and the stale rows must be superseded (or disabled) so the map does not draw both.`),
);
report.steps.nightTrains = {
  minOvernightSeconds: MIN_OVERNIGHT_SECONDS,
  count: nightTrains.length,
  trains: nightTrains.map((g) => ({
    number: g.number,
    trips: g.trips,
    minSeconds: g.minSecs,
    maxSeconds: g.maxSecs,
    maxStops: g.maxStops,
    routeNames: [...g.routeNames],
    patterns: [...g.patterns.values()].sort((a, b) => b.dates - a.dates),
  })),
  missingFromFeed: missing,
  extraInFeed: extra,
};
save("night-trains.json", report.steps.nightTrains);
checkpoint();

// ── 9. Export a test fixture ────────────────────────────────────────────────
// The dev sandbox cannot reach eu.ftp.opendatasoft.com, so the adapter cannot
// be developed against the live feed there. Rather than iterate through a human
// on every run, slice the real feed down to the trips that matter and commit
// that — same idea as tests/fixtures/es-timetable/, which holds real European
// Sleeper markup.
//
// Real GTFS .txt files, not a bespoke JSON: loadGtfsDir() then reads the
// fixture unchanged, so verify-sncf exercises the actual code path instead of
// a mock of it. Rows are copied verbatim from the source files (filtered, never
// re-serialised) so the fixture cannot drift from the feed's own formatting.

if (hasFlag("--fixture")) {
  const fixtureDir = path.join(ROOT, "tests", "fixtures", "sncf-gtfs");
  console.log(`\n═══ export fixture → ${path.relative(ROOT, fixtureDir)} ═══`);

  const gtfsForFixture = loadGtfsDir(WORK_DIR);
  const { overnightTrips } = await import("./lib/gtfs.mjs");

  // Deliberately WITHOUT the duration filter. A fixture built from
  // overnightTrips() defaults would hold only trains that already pass the 7h
  // threshold, so verify-sncf could never prove the threshold excludes
  // anything — and the near-misses are the whole reason it exists. Take every
  // midnight-crossing rail trip, then partition.
  const allCrossing = overnightTrips({ gtfs: gtfsForFixture, minSeconds: 0 });

  const MIN_SECONDS = 7 * 3600;
  const wanted = new Set(trainNumbers);
  const positives = [];
  const negatives = [];
  for (const [number, entries] of allCrossing) {
    for (const e of entries) {
      if (e.seconds >= MIN_SECONDS) {
        // Allowlisted numbers only: the other long-distance night trains are
        // real, but a fixture is a test input, not an archive.
        if (wanted.has(number)) positives.push(e);
      } else {
        negatives.push(e);
      }
    }
  }

  // Spread the near-misses rather than taking the first N, so the fixture holds
  // both the 1h10 TER and the 5h34 TGV that bracket the threshold.
  negatives.sort((a, b) => b.seconds - a.seconds);
  const NEGATIVE_SAMPLE = 20;
  const step = Math.max(1, Math.floor(negatives.length / NEGATIVE_SAMPLE));
  const sampledNegatives = negatives
    .filter((_, i) => i % step === 0)
    .slice(0, NEGATIVE_SAMPLE);

  const keepTrips = new Set();
  const keepServices = new Set();
  const keepRoutes = new Set();
  const keepStops = new Set();
  for (const e of [...positives, ...sampledNegatives]) {
    keepTrips.add(e.trip.trip_id);
    keepServices.add(e.trip.service_id);
    keepRoutes.add(e.trip.route_id);
    for (const st of e.stopTimes) keepStops.add(st.stop_id);
  }
  // Parent stations too, or stops.txt loses the hierarchy loadGtfsDir reads.
  for (const id of [...keepStops]) {
    const parent = gtfsForFixture.stopsById.get(id)?.parent;
    if (parent) keepStops.add(parent);
  }

  const hhmmShort = (s) =>
    `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  const positiveNumbers = new Set(positives.map((e) => e.trip.trip_headsign));
  console.log(
    `  positives: ${positives.length} trips across ${positiveNumbers.size} allowlisted number(s)`,
  );
  console.log(
    `  negatives: ${sampledNegatives.length} near-miss trips sampled from ${negatives.length}` +
      (sampledNegatives.length
        ? ` (${hhmmShort(sampledNegatives[sampledNegatives.length - 1].seconds)}–${hhmmShort(sampledNegatives[0].seconds)})`
        : ""),
  );
  console.log(
    `  total: ${keepTrips.size} trips, ${keepRoutes.size} routes, ${keepStops.size} stops, ${keepServices.size} services`,
  );
  const missingFromFeed = trainNumbers.filter((n) => !positiveNumbers.has(n));
  if (missingFromFeed.length) {
    console.log(
      `  WARNING: allowlisted but not in the fixture: ${missingFromFeed.join(", ")}`,
    );
  }

  // Copy a table verbatim, keeping only rows whose `column` is in `keep`.
  async function sliceTable(file, column, keep) {
    const src = path.join(WORK_DIR, file);
    if (!fs.existsSync(src)) return null;
    const out = [];
    let headers = null;
    let index = -1;
    const rl = readline.createInterface({
      input: fs.createReadStream(src),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!headers) {
        headers = splitCsv(line.replace(/^﻿/, "")).map((h) => h.trim());
        index = headers.indexOf(column);
        out.push(line.replace(/^﻿/, ""));
        continue;
      }
      if (index === -1) continue;
      const cells = splitCsv(line);
      if (keep.has((cells[index] ?? "").trim())) out.push(line);
    }
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, file), out.join("\n") + "\n");
    return out.length - 1;
  }

  const written = {};
  written["trips.txt"] = await sliceTable("trips.txt", "trip_id", keepTrips);
  written["stop_times.txt"] = await sliceTable(
    "stop_times.txt",
    "trip_id",
    keepTrips,
  );
  written["routes.txt"] = await sliceTable(
    "routes.txt",
    "route_id",
    keepRoutes,
  );
  written["stops.txt"] = await sliceTable("stops.txt", "stop_id", keepStops);
  written["calendar_dates.txt"] = await sliceTable(
    "calendar_dates.txt",
    "service_id",
    keepServices,
  );
  // Small enough to take whole, and both carry feed-level context worth keeping.
  for (const file of ["agency.txt", "feed_info.txt"]) {
    const src = path.join(WORK_DIR, file);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.copyFileSync(src, path.join(fixtureDir, file));
    written[file] = "copied whole";
  }

  let bytes = 0;
  for (const f of fs.readdirSync(fixtureDir))
    bytes += fs.statSync(path.join(fixtureDir, f)).size;
  for (const [file, rows] of Object.entries(written)) {
    console.log(
      `    ${file.padEnd(20)} ${rows === null ? "(absent in feed)" : rows} rows`,
    );
  }
  console.log(
    `\n  fixture size: ${mb(bytes)} — commit tests/fixtures/sncf-gtfs/`,
  );
  report.steps.fixture = {
    written,
    bytes,
    positives: positives.length,
    positiveNumbers: [...positiveNumbers].sort(),
    negatives: sampledNegatives.length,
    negativeSecondsRange: sampledNegatives.length
      ? [
          sampledNegatives[sampledNegatives.length - 1].seconds,
          sampledNegatives[0].seconds,
        ]
      : null,
    trips: keepTrips.size,
    missingFromFeed,
  };
  checkpoint();
} else {
  console.log(
    `\n[probe] pass --fixture to also write tests/fixtures/sncf-gtfs/ for offline adapter work`,
  );
}

report.finishedAt = new Date().toISOString();
checkpoint();
console.log(
  outDir
    ? `\n[probe] report written to ${outDir}/report.json`
    : "\n[probe] pass an output dir to also save the report and snapshots",
);
