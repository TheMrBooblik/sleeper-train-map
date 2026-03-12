#!/usr/bin/env node
/**
 * Extracts PKP route data from a Portal Pasażera ShowTrack API response.
 *
 * Outputs two files under public/data/:
 * - <name>Polyline.json         → [ [lat, lon], ... ] main route polyline
 * - <name>ShowTrackStops.json   → station list with basic timetable info
 *
 * Usage:
 *   1. Save the full ShowTrack response JSON to a file, e.g.:
 *        showtrack-karkonosze.json
 *   2. Run:
 *        node scripts/extract-pkp.js showtrack-karkonosze.json pkpKarkonosze
 *
 * Arguments:
 *   - argv[2]: input JSON path (ShowTrack response)
 *   - argv[3]: output base name (without suffix), e.g. "pkpKarkonosze"
 *
 * Reads data[0].r.s.rt[0] for the polyline and data[0].s for stops/timetable.
 */

const fs = require("fs");
const path = require("path");

function main() {
  const inputArg = process.argv[2];
  const nameArg = process.argv[3];

  if (!inputArg || !nameArg) {
    console.error(
      "Usage: node scripts/extract-pkp.js <showtrack.json> <baseName>",
    );
    console.error(
      "Example: node scripts/extract-pkp.js showtrack-karkonosze.json pkpKarkonosze",
    );
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const polylinePath = path.join(
    __dirname,
    "..",
    "public",
    "data",
    `${nameArg}Polyline.json`,
  );
  const stopsPath = path.join(
    __dirname,
    "..",
    "public",
    "data",
    `${nameArg}ShowTrackStops.json`,
  );

  let raw;
  try {
    raw = fs.readFileSync(inputPath, "utf8");
  } catch (e) {
    console.error("Failed to read input file:", inputPath);
    console.error(e.message);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Invalid JSON in", inputPath);
    process.exit(1);
  }

  if (!Array.isArray(data) || data.length === 0) {
    console.error("Expected a non-empty array (ShowTrack response).");
    process.exit(1);
  }

  const first = data[0];

  // Polyline: main route segment
  const route = first?.r?.s?.rt;
  if (!Array.isArray(route) || route.length === 0 || !Array.isArray(route[0])) {
    console.error("Expected data[0].r.s.rt[0] to be the main route polyline.");
    process.exit(1);
  }

  const points = route[0];
  const coords = points.map((pt) => [pt.s, pt.d]);

  // Stops + timetable: station array "s"
  const rawStops = Array.isArray(first?.s) ? first.s : [];
  const stops = rawStops.map((s, index) => ({
    order: index + 1,
    name: s.a,
    language: s.b,
    arrival_planned: s.c,
    arrival_real: s.d,
    delay_minutes: s.e,
    departure_planned: s.f,
    departure_real: s.g,
    platform: s.i,
    track: s.j,
    lat: s.k,
    lon: s.l,
  }));

  fs.writeFileSync(polylinePath, JSON.stringify(coords), "utf8");
  fs.writeFileSync(stopsPath, JSON.stringify(stops, null, 2), "utf8");

  console.log("Wrote", coords.length, "polyline points to", polylinePath);
  console.log("Wrote", stops.length, "stops to", stopsPath);
}

main();
