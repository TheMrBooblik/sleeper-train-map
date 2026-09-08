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
import {
  pkpEntryForRoute,
  gtfsEntryForRoute,
  hydratePkpBundle,
} from "../src/lib/pkpTrainKeyExtract.js";
import { attachPkpGtfsPolylinesToViewMap } from "../src/lib/pkpGtfsMerge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const p = path.join(root, "public", "data", "gtfs", "pkpTrainShapes.json");

// The file ships rail_segments only; `positions` is rebuilt on read, the same
// way every other consumer of the bundle gets it.
const data = hydratePkpBundle(JSON.parse(fs.readFileSync(p, "utf8")));
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
  // Collision: the reused number maps to a different corridor and the partner
  // key is absent from the feed → must reject. The renderer then chains
  // station coords (OSM 8737075 is the Oświęcim corridor, not Katowice).
  ["EN 443 / IC 406", "Praha hl.n.", "Warszawa Wschodnia", null], // 406 = München corridor, 443 absent
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
  // Mid-corridor through-car switches (Back-on-Track's own route pages):
  // Przemyśl–Świnoujście cars ride the Berlin train ("Ursa") to Poznań, then
  // the Chełm–Świnoujście train ("Uznam") onward; the Bielsko-Biała cars ride
  // the Kołobrzeg train to Wrocław, then the Kraków–Świnoujście train.
  ["EN 430 / IC 28170", "Przemyśl Gł.", "Świnoujście", "Świnoujście"],
  ["IC 82170 / EC 431", "Świnoujście", "Przemyśl Gł.", "Przemyśl Główny"],
  ["TLK 48190/38194", "Bielsko-Biała Gł.", "Świnoujście", "Świnoujście"],
  ["TLK 83194/84190", "Świnoujście", "Bielsko-Biała Gł.", "Bielsko-Biała Główna"],
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

// 5) Leo Express Frankfurt↔Przemyśl sleeper: mkuran stores operational numbers
//    (currently 1248/1249; discovered from overnight LEO trips, not an allowlist).
//    Back-on-Track uses commercial labels LE 232/235. The bundle must carry the
//    full-corridor shapes, and gtfsEntryForRoute must attach them by endpoint city.
for (const key of ["1248", "1249"]) {
  const e = byTrainKey[key];
  if (!(e?.positions?.length > 1000)) {
    fail(`byTrainKey[${key}] should have a full-corridor polyline (1000+ pts)`);
  }
  const names = (e.stops || []).map((s) => s?.name || "");
  const hasFrankfurt = names.some((n) => /frankfurt/i.test(n));
  const hasPrzemysl = names.some((n) => /przemy/i.test(n));
  if (!hasFrankfurt || !hasPrzemysl) {
    fail(`byTrainKey[${key}] should span Frankfurt and Przemyśl, got ${names[0]} → ${names[names.length - 1]}`);
  }
  // Official terminus is Frankfurt Süd, not the airport Fernbahnhof.
  const frankfurtStop = names.find((n) => /frankfurt/i.test(n));
  if (!/süd|sud/i.test(frankfurtStop || "")) {
    fail(`byTrainKey[${key}] Frankfurt stop should be Süd, got ${frankfurtStop}`);
  }
}

const leWest = gtfsEntryForRoute(
  "LE 232",
  byTrainKey,
  "Przemyśl Gł.",
  "Frankfurt (Main) Flughafen Fernbahnhof",
  "LE",
);
if (!leWest) fail("LE 232 Przemyśl→Frankfurt should match by endpoints");
if (!/przemy/i.test(leWest.stops[0]?.name || "")) {
  fail(`LE 232 should be oriented Przemyśl→Frankfurt, started at ${leWest.stops[0]?.name}`);
}
if (!/frankfurt/i.test(leWest.stops[leWest.stops.length - 1]?.name || "")) {
  fail(`LE 232 should end in Frankfurt, got ${leWest.stops[leWest.stops.length - 1]?.name}`);
}

const leEast = gtfsEntryForRoute(
  "LE 235",
  byTrainKey,
  "Frankfurt (Main) Flughafen Fernbahnhof",
  "Przemyśl Gł.",
  "LE",
);
if (!leEast) fail("LE 235 Frankfurt→Przemyśl should match by endpoints");
if (!/frankfurt/i.test(leEast.stops[0]?.name || "")) {
  fail(`LE 235 should be oriented Frankfurt→Przemyśl, started at ${leEast.stops[0]?.name}`);
}

// Keyed PKP lookup must NOT steal the Leo Express shape via a global scan.
const pkpMiss = pkpEntryForRoute(
  "LE 232",
  byTrainKey,
  "Przemyśl Gł.",
  "Frankfurt (Main) Flughafen Fernbahnhof",
);
if (pkpMiss) fail("pkpEntryForRoute (no endpoint fallback) should not match LE 232");

const merged = attachPkpGtfsPolylinesToViewMap(
  {
    270: {
      agency_id: "LE",
      trip_short_name_0: "LE 232",
      origin_trip_0: "Przemyśl Gł.",
      destination_trip_0: "Frankfurt (Main) Flughafen Fernbahnhof",
      trip_short_name_1: "LE 235",
      origin_trip_1: "Frankfurt (Main) Flughafen Fernbahnhof",
      destination_trip_1: "Przemyśl Gł.",
    },
  },
  data,
);
if (!(merged[270]?.pkp_gtfs_positions_0?.length > 1000)) {
  fail("Leo Express view-map row should receive pkp_gtfs_positions_0");
}
if (!(merged[270]?.pkp_gtfs_positions_1?.length > 1000)) {
  fail("Leo Express view-map row should receive pkp_gtfs_positions_1");
}

console.log(
  "pkpTrainShapes.json OK —",
  Object.keys(byTrainKey).length,
  "train keys,",
  withCalendar,
  "with calendar; collision detection + Hel compound stitch passed",
);
