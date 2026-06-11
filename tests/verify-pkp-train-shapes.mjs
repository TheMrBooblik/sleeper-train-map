#!/usr/bin/env node
/**
 * Validates public/data/gtfs/pkpTrainShapes.json + the automatic GTFS merge
 * logic (no server, no browser). Run: node tests/verify-pkp-train-shapes.mjs
 *
 * Covers:
 *  - bundle has geometry + per-station timetables + service calendar
 *  - endpoint matching rejects wrong-corridor shapes from reused train numbers
 *    (Przemyśl↔Świnoujście and Praha↔Warszawa collisions) while keeping the
 *    legitimate routes — all without any hardcoded per-route exceptions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pkpEntryForRoute } from "../src/lib/pkpTrainKeyExtract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const p = path.join(root, "public", "data", "gtfs", "pkpTrainShapes.json");

const data = JSON.parse(fs.readFileSync(p, "utf8"));
const byTrainKey = data.byTrainKey || {};

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// 1) Geometry: 16170 (Warszawa↔Szklarska Poręba) must have a real polyline.
const k16170 = byTrainKey["16170"]?.positions;
if (!Array.isArray(k16170) || k16170.length < 50) {
  fail("byTrainKey[16170].positions should have 50+ points");
}

// 2) Stops are objects with names + the bundle carries timetable/calendar data.
const sampleStops = byTrainKey["16170"]?.stops;
if (!Array.isArray(sampleStops) || !sampleStops[0]?.name) {
  fail("byTrainKey[16170].stops should be objects with a name");
}
const withCalendar = Object.values(byTrainKey).filter((e) => e.days).length;
if (withCalendar < 1) {
  fail("Expected at least one train with a derived service calendar (days)");
}

// 2b) Replacement-bus terminus extension: trains whose final leg runs by bus
//     (e.g. Lębork↔Łeba while the line is closed for works) must reach the real
//     terminus in `stops` and carry a bus segment, so the merge can match the
//     Back-on-Track route to Łeba instead of stopping short at Lębork.
for (const [key, expectedTerminus] of [
  ["35190", "Łeba"], // Kraków → Łeba (Korsarz), bus on Lębork→Łeba
  ["403", "Łeba"], // Bohumín → Łeba (Wydmy), bus on Lębork→Łeba
]) {
  const e = byTrainKey[key];
  const last = e?.stops?.[e.stops.length - 1]?.name;
  if (last !== expectedTerminus) {
    fail(`byTrainKey[${key}] should end at ${expectedTerminus}, got ${last}`);
  }
  const reachesTerminus = e?.bus_segments?.some((s) => s.to === expectedTerminus);
  if (!reachesTerminus) {
    fail(`byTrainKey[${key}] should have a bus segment ending at ${expectedTerminus}`);
  }
}

// 3) Endpoint matching: legitimate routes resolve, collisions are rejected.
//    These mirror the real Back-on-Track route labels/endpoints.
const cases = [
  // label, origin, destination, expectedKeyOrNull
  ["IC 16170", "Warszawa Wschodnia", "Szklarska Poręba Górna", "16170"],
  ["IC 28170", "Chelm", "Świnoujście", "28170"],
  ["EC 460", "Praha hl.n.", "Gdynia Gł.", "460"],
  // Replacement-bus terminus: the rail shape ends at Lębork but the train runs
  // through to Łeba by bus, so endpoint matching must resolve against Łeba.
  ["TLK 35190", "Kraków Gł.", "Łeba", "35190"],
  ["TLK 53190", "Łeba", "Kraków Gł.", "53190"],
  ["TLK 403", "Bohumín", "Łeba", "403"],
  ["TLK 402", "Łeba", "Bohumín", "402"],
  // Collisions: the reused number maps to a different corridor → must reject.
  ["EN 430 / IC 28170", "Przemyśl Gł.", "Świnoujście", null], // 28170 = Chełm corridor
  ["EN 443 / IC 406", "Praha hl.n.", "Warszawa Wschodnia", null], // 406 = München corridor
];

for (const [label, origin, dest, expected] of cases) {
  const entry = pkpEntryForRoute(label, byTrainKey, origin, dest);
  const got =
    entry &&
    Object.keys(byTrainKey).find((k) => byTrainKey[k] === entry);
  if (expected === null) {
    if (entry) fail(`"${label}" (${origin}→${dest}) should NOT match (got ${got})`);
  } else {
    if (got !== expected)
      fail(`"${label}" (${origin}→${dest}) expected ${expected}, got ${got}`);
  }
}

// 4) Compound labels (e.g. "TLK 35190/50191") stitch a main corridor leg and a
//    peninsula spur leg at their shared junction (Gdynia), so the line reaches
//    Hel along the coastal railway instead of as a straight chord. The result
//    is a synthetic entry (not keyed in byTrainKey), so assert its shape.
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function pathKm(positions) {
  let total = 0;
  for (let i = 1; i < positions.length; i += 1) {
    total += haversineKm(positions[i - 1], positions[i]);
  }
  return total;
}

const stitchCases = [
  // label, origin, destination, expectedLastStop
  ["TLK 35190/50191", "Kraków Gł.", "Hel", "Hel"],
  ["TLK 55190/53190", "Hel", "Kraków Gł.", "Kraków Główny"],
  ["TLK 403/50171", "Bohumín", "Hel", "Hel"],
  ["TLK 55170/402", "Hel", "Bohumín", "Bohumín"],
];

for (const [label, origin, dest, expectedLast] of stitchCases) {
  const e = pkpEntryForRoute(label, byTrainKey, origin, dest);
  if (!e) fail(`"${label}" (${origin}→${dest}) should stitch, got null`);
  const last = e.stops[e.stops.length - 1]?.name;
  if (last !== expectedLast) {
    fail(`"${label}" should end at ${expectedLast}, got ${last}`);
  }
  // Two rail legs (main corridor + spur), joined at the junction.
  if (!(e.rail_segments?.length >= 2)) {
    fail(`"${label}" should have >= 2 rail segments, got ${e.rail_segments?.length}`);
  }
  // The full stitched corridor must be real track, not a straight chord: lots of
  // points and a long path (the Kraków/Bohumín → Hel run is ~750 km).
  if (!(e.positions.length > 1000)) {
    fail(`"${label}" too few points (${e.positions.length}) — chord fallback?`);
  }
  if (!(pathKm(e.positions) > 300)) {
    fail(`"${label}" path only ${pathKm(e.positions).toFixed(0)} km — chord fallback?`);
  }
}

console.log(
  "pkpTrainShapes.json OK —",
  Object.keys(byTrainKey).length,
  "train keys,",
  withCalendar,
  "with calendar; collision detection + Hel compound stitch passed",
);
