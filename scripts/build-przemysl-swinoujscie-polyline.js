#!/usr/bin/env node
/**
 * Builds public/data/przemyslSwinoujsciePolyline.json by splicing:
 *   - key 430 (EN 430, Przemyśl→Berlin via Kraków/Wrocław) from start up to Poznań Główny
 *   - key 28170 (IC 28170, Chełm→Świnoujście via Warsaw) from Poznań Główny northward
 *
 * The Przemyśl→Świnoujście train shares the EN 430 corridor (Przemyśl→Kraków→Wrocław→Poznań)
 * then continues north via Krzyż→Szczecin→Świnoujście instead of west to Berlin.
 *
 * Run once and commit the output: node scripts/build-przemysl-swinoujscie-polyline.js
 */

const fs = require("fs");
const path = require("path");

const shapesPath = path.join(__dirname, "../public/data/gtfs/pkpTrainShapes.json");
const outPath = path.join(__dirname, "../public/data/przemyslSwinoujsciePolyline.json");

const data = JSON.parse(fs.readFileSync(shapesPath, "utf8"));
// The bundle ships rail_segments only. This script is CommonJS and one-off, so
// it inlines what hydratePkpBundle() (src/lib/pkpTrainKeyExtract.js) does for
// every other reader.
const positionsOf = (key) =>
  (data.byTrainKey[key].rail_segments || []).flatMap((s) => s.positions || []);
const pts430 = positionsOf("430");     // Przemyśl → Poznań → Berlin
const pts28170 = positionsOf("28170"); // Chełm → Poznań → Świnoujście

// Poznań Główny ≈ 52.404N, 16.925E
const POZNAN_LAT = 52.404;
const POZNAN_LON = 16.925;

function nearestIdx(pts, lat, lon) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - lat) ** 2 + (pts[i][1] - lon) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

const spliceIdx430 = nearestIdx(pts430, POZNAN_LAT, POZNAN_LON);
const spliceIdx28170 = nearestIdx(pts28170, POZNAN_LAT, POZNAN_LON);

// Przemyśl → Poznań (from key 430), then Poznań → Świnoujście (from key 28170)
const combined = [
  ...pts430.slice(0, spliceIdx430 + 1),
  ...pts28170.slice(spliceIdx28170),
];

fs.writeFileSync(outPath, JSON.stringify(combined) + "\n", "utf8");
console.log(
  `Wrote ${combined.length} pts` +
  ` (430[0..${spliceIdx430}] + 28170[${spliceIdx28170}..${pts28170.length - 1}])`,
);
console.log(`Splice at 430[${spliceIdx430}] = ${JSON.stringify(pts430[spliceIdx430])}`);
console.log(`         28170[${spliceIdx28170}] = ${JSON.stringify(pts28170[spliceIdx28170])}`);
