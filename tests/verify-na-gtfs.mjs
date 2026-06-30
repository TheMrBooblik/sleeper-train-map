// tests/verify-na-gtfs.mjs
// Offline unit test for the generic GTFS sleeper builder (scripts/lib/gtfs.mjs)
// that powers the Amtrak + VIA Rail sources. Runs a committed GTFS fixture
// through loadGtfsDir() + buildSleeperTrains() and asserts allowlist filtering,
// representative-trip selection, shape vs station-chain geometry, ordered
// stations and calendar rendering. Raw node, no network.
// Run: npm run verify-na-gtfs

import path from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import { loadGtfsDir, buildSleeperTrains } from "../scripts/lib/gtfs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "na-gtfs");

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};
const approx = (a, b) => Math.abs(a - b) < 1e-4;

const gtfs = loadGtfsDir(FIXTURE);

// Allowlist deliberately uses different case to exercise loose matching, and
// omits "Pacific Surfliner" so the day route is filtered out.
const trains = buildSleeperTrains({
  gtfs,
  allowlist: ["CALIFORNIA ZEPHYR", "Crescent"],
  agency: "AMTK",
  operator: "Amtrak",
});

const keys = Object.keys(trains).sort();
check(
  keys.length === 2 && keys[0] === "California Zephyr" && keys[1] === "Crescent",
  `expected exactly [California Zephyr, Crescent], got [${keys.join(", ")}]`,
);
check(!("Pacific Surfliner" in trains), "Pacific Surfliner (no sleeper) must be filtered out");

const cz = trains["California Zephyr"];
if (!cz) {
  problems.push("California Zephyr missing");
} else {
  check(cz.agency_id === "AMTK", `CZ agency_id: ${cz.agency_id}`);
  check(cz.operator === "Amtrak", `CZ operator: ${cz.operator}`);
  // Representative trip = t1 (3 stops), not t2 (2 stops).
  const names = cz.stations.map((s) => s.name);
  check(
    names.length === 3 &&
      names[0] === "Chicago Union Station" &&
      names[1] === "Omaha" &&
      names[2] === "Emeryville",
    `CZ stations should be Chicago→Omaha→Emeryville, got [${names.join(" → ")}]`,
  );
  check(
    cz.stations.every(
      (s) =>
        Number.isFinite(s.location.latitude) &&
        Number.isFinite(s.location.longitude),
    ),
    "CZ stations must all carry coordinates",
  );
  // Times come through formatted HH:MM.
  check(cz.stations[0].departure === "14:00", `CZ first departure: ${cz.stations[0].departure}`);
  // Geometry uses the GTFS shape (sh1: 3 points), not just the 2-stop t2.
  const decoded = polyline.decode(cz.polyline);
  check(
    decoded.length === 3 &&
      approx(decoded[0][0], 41.8786) &&
      approx(decoded[1][1], -95.9378) &&
      approx(decoded[2][0], 37.8409),
    `CZ polyline should follow shape sh1 (3 pts), decoded ${decoded.length}`,
  );
  // Full-year daily calendar → "2026: Daily".
  check(cz.frequency === "2026: Daily", `CZ frequency: ${cz.frequency}`);
}

const cr = trains["Crescent"];
if (!cr) {
  problems.push("Crescent missing");
} else {
  // No shape_id on the Crescent trip → polyline falls back to the station chain.
  const decoded = polyline.decode(cr.polyline);
  check(
    decoded.length === 3 &&
      approx(decoded[0][0], 40.7506) &&
      approx(decoded[2][1], -90.0701),
    `Crescent polyline should fall back to its 3-station chain, decoded ${decoded.length}`,
  );
}

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-na-gtfs: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`verify-na-gtfs: OK — ${keys.length} sleeper routes built from fixture`);
