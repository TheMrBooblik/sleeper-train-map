#!/usr/bin/env node
/**
 * Validates the serve-time projections /api/initial-data applies to the merged
 * payload (src/pages/api/lib/payload-projection.mjs). Run:
 *   node tests/verify-payload-projection.mjs
 *
 * The projections exist to shrink the map's first paint from ~1.4 MB gzip to
 * ~120 KB, and the way that goes wrong is silent: a station dropped here just
 * never gets a marker. So the central assertion is the inverse of the size one —
 * every station the renderer could have drawn must survive.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { normalizeStationNameForLookup } from "../src/lib/stationKey.mjs";
import { hydratePkpBundle } from "../src/lib/pkpTrainKeyExtract.js";
import {
  projectStopsToRoutes,
  stripDeadTripColumns,
  splitRouteGeometry,
  mergeRouteGeometry,
  routeStationKeys,
} from "../src/pages/api/lib/payload-projection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let failures = 0;
function fail(msg) {
  console.error("FAIL:", msg);
  failures += 1;
}
function ok(msg) {
  console.log("  ✓", msg);
}

const payload = JSON.parse(
  fs.readFileSync(
    path.join(root, "public", "data", "published", "initial-data.json"),
    "utf8",
  ),
).data;

const pkpBundle = hydratePkpBundle(
  JSON.parse(
    fs.readFileSync(
      path.join(root, "public", "data", "gtfs", "pkpTrainShapes.json"),
      "utf8",
    ),
  ),
);
const pkpStationNames = new Set();
for (const entry of Object.values(pkpBundle.byTrainKey ?? {})) {
  for (const stop of entry?.stops ?? []) {
    if (stop?.name) pkpStationNames.add(stop.name);
  }
}

const gz = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o)), { level: 6 }).length;
const kb = (n) => `${Math.round(n / 1024)} KB`;

// ─── 1. Stops projection keeps everything renderable ────────────────────────
console.log("1) stops projection");

const projected = projectStopsToRoutes(payload, pkpStationNames);

// useMapMarkers renders a stop only when cities[] has an entry for it, and
// cities is derived from exactly these route fields. So the renderable set and
// the kept set must be the same set — not merely overlapping.
const keys = routeStationKeys(payload.viewMap);
const renderable = payload.stops.filter((s) => {
  const id = s?.stop_id;
  return id && (keys.has(id) || keys.has(normalizeStationNameForLookup(id)));
});
const keptIds = new Set(projected.stops.map((s) => s.stop_id));
const dropped = renderable.filter((s) => !keptIds.has(s.stop_id));
if (dropped.length > 0) {
  fail(
    `${dropped.length} renderable stops dropped, e.g. ${dropped
      .slice(0, 5)
      .map((s) => s.stop_id)
      .join(", ")}`,
  );
} else {
  ok(`all ${renderable.length} route-referenced stops kept`);
}

// The browser-side PKP merge rewrites via_0 from the bundle's own stop list
// after this payload is built, so those stations need their coordinates too.
const missingPkp = [...pkpStationNames].filter((name) => {
  const key = normalizeStationNameForLookup(name);
  const inSource = payload.stops.some(
    (s) => s.stop_id === name || normalizeStationNameForLookup(s.stop_id) === key,
  );
  return inSource && !projected.stops.some((s) => s.stop_id === name ||
    normalizeStationNameForLookup(s.stop_id) === key);
});
if (missingPkp.length > 0) {
  fail(`PKP GTFS stations dropped: ${missingPkp.slice(0, 8).join(", ")}`);
} else {
  ok(`all ${pkpStationNames.size} PKP bundle stations kept where BoT has them`);
}

if (!(projected.stops.length < payload.stops.length / 5)) {
  fail(
    `projection barely shrank stops: ${payload.stops.length} → ${projected.stops.length}`,
  );
} else {
  ok(`stops ${payload.stops.length} → ${projected.stops.length}`);
}

// Nothing but `stops` may change.
if (projected.viewMap !== payload.viewMap || projected.trips !== payload.trips) {
  fail("projectStopsToRoutes must not touch viewMap or trips");
} else {
  ok("viewMap and trips untouched");
}

// ─── 2. Dead trip columns ───────────────────────────────────────────────────
console.log("2) dead trip columns");

const leaned = stripDeadTripColumns(payload);
const deadFields = new Set();
for (const trip of Object.values(leaned.trips)) {
  for (const field of Object.keys(trip)) {
    if (
      field === "" ||
      field.startsWith("Merged Doc ") ||
      field.startsWith("Document Merge Status") ||
      field.startsWith("Link to merged Doc")
    ) {
      deadFields.add(field);
    }
  }
}
if (deadFields.size > 0) {
  fail(`dead columns survived: ${[...deadFields].join(", ")}`);
} else {
  ok("ONTD_Chatbase export columns gone");
}

// Fields the app and SEO layer actually read must be intact.
const sampleKey = Object.keys(payload.trips)[0];
for (const field of [
  "route_id",
  "trip_short_name",
  "service_id",
  "via",
  "classes",
  "duration",
]) {
  if (!(field in leaned.trips[sampleKey])) {
    fail(`stripDeadTripColumns dropped a live field: ${field}`);
  }
}
if (Object.keys(leaned.trips).length !== Object.keys(payload.trips).length) {
  fail("stripDeadTripColumns changed the trip count");
} else {
  ok(`${Object.keys(leaned.trips).length} trips kept, live fields intact`);
}

// ─── 3. Geometry split round-trips ──────────────────────────────────────────
console.log("3) geometry split");

const { payload: lightened, geometry } = splitRouteGeometry(payload);

const stillCarryingGeometry = Object.entries(lightened.viewMap).filter(
  ([, r]) => r.nj_polyline_0 || r.nj_polyline_1 || r.nj_polyline,
);
if (stillCarryingGeometry.length > 0) {
  fail(`${stillCarryingGeometry.length} rows still carry polylines`);
} else {
  ok(`geometry lifted off ${Object.keys(geometry).length} routes`);
}

const restored = mergeRouteGeometry(lightened.viewMap, geometry);
const restoredKeys = Object.keys(restored);
if (restoredKeys.length !== Object.keys(payload.viewMap).length) {
  fail("merge changed the route count");
}
let mismatched = 0;
for (const key of restoredKeys) {
  const before = payload.viewMap[key];
  const after = restored[key];
  for (const field of ["nj_polyline_0", "nj_polyline_1", "nj_polyline"]) {
    if ((before[field] ?? null) !== (after[field] ?? null)) mismatched += 1;
  }
}
if (mismatched > 0) {
  fail(`${mismatched} polylines did not survive the split/merge round trip`);
} else {
  ok("split → merge restores every polyline");
}

// A route with no geometry must come back as the very same object, not a copy.
const bare = Object.keys(lightened.viewMap).find((k) => !geometry[k]);
if (bare && restored[bare] !== lightened.viewMap[bare]) {
  fail("mergeRouteGeometry copied a row that had no geometry to add");
} else if (bare) {
  ok("rows without geometry pass through untouched");
}

// ─── 4. What the first paint actually costs ─────────────────────────────────
console.log("4) first-paint size");

const firstPaint = splitRouteGeometry(
  stripDeadTripColumns(projectStopsToRoutes(payload, pkpStationNames)),
).payload;

const before = gz(payload);
const after = gz(firstPaint);
console.log(`  /api/initial-data: ${kb(before)} → ${kb(after)} gzip`);

// Generous ceiling: this guards against a regression that quietly puts the
// whole stops table (or the polylines) back on the critical path, not against
// the dataset growing.
const CEILING = 400 * 1024;
if (after > CEILING) {
  fail(`first paint payload ${kb(after)} gzip exceeds the ${kb(CEILING)} ceiling`);
} else {
  ok(`under the ${kb(CEILING)} ceiling`);
}

// ─── 5. The PKP bundle ships one copy of its geometry ───────────────────────
console.log("5) pkp bundle");

const rawBundle = JSON.parse(
  fs.readFileSync(
    path.join(root, "public", "data", "gtfs", "pkpTrainShapes.json"),
    "utf8",
  ),
);
const withPositions = Object.entries(rawBundle.byTrainKey ?? {}).filter(
  ([, e]) => e?.positions?.length,
);
if (withPositions.length > 0) {
  fail(
    `${withPositions.length} entries still ship positions (derivable from rail_segments)`,
  );
} else {
  ok("committed bundle carries rail_segments only");
}

let hydratedCount = 0;
for (const [key, entry] of Object.entries(pkpBundle.byTrainKey ?? {})) {
  const expected = (entry.rail_segments ?? []).reduce(
    (n, s) => n + (s.positions?.length ?? 0),
    0,
  );
  if (entry.positions?.length !== expected) {
    fail(`hydrate produced ${entry.positions?.length} points for ${key}, want ${expected}`);
  } else if (entry.positions.length !== entry.pointCount) {
    fail(
      `hydrated ${key} has ${entry.positions.length} points but pointCount says ${entry.pointCount}`,
    );
  } else {
    hydratedCount += 1;
  }
}
ok(`hydrate rebuilds positions for ${hydratedCount} trains, matching pointCount`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll payload projection checks passed.");
