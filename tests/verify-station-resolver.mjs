#!/usr/bin/env node
/**
 * Unit tests for the station-name resolver (no server, no network).
 * Run: node tests/verify-station-resolver.mjs
 *
 * The resolver is what lets a coordinate-less feed (PLK Open Data) put its
 * stations on the map: it maps an alternately-spelled name onto the SAME
 * station in the map's own stop table. Fixtures use the real spellings that
 * broke before — "Praha Hlavni Nadrazi" vs "Praha hl.n.", "Bydgoszcz Główna"
 * vs "Bydgoszcz Gł." — plus the real collision that made geographic
 * disambiguation necessary ("Kolin" in Poland vs "Kolín" in Czechia).
 */
import assert from "node:assert/strict";
import {
  foldStationName,
  buildStationIndex,
  resolveStationList,
} from "../scripts/lib/station-resolver.mjs";

// 1) foldStationName — diacritics, punctuation and the three main-station
//    qualifiers all collapse, so the two spellings of one station agree.
assert.equal(foldStationName("Česká Třebová"), foldStationName("Ceska Trebova"));
assert.equal(foldStationName("Zábřeh na Moravě"), foldStationName("Zabreh na Morave"));
assert.equal(foldStationName("Praha hl.n."), foldStationName("Praha Hlavni Nadrazi"));
assert.equal(foldStationName("Bydgoszcz Gł."), foldStationName("Bydgoszcz Główna"));
assert.equal(foldStationName("Kraków Gł."), foldStationName("Kraków Główny"));
assert.equal(foldStationName("München Hbf"), foldStationName("Munchen Hauptbahnhof"));
assert.equal(foldStationName("Opatija-Matulji"), foldStationName("Opatija Matulji"));
assert.equal(foldStationName(""), "", "empty stays empty");
assert.notEqual(
  foldStationName("Gdańsk Gł."),
  foldStationName("Gdynia Gł."),
  "different cities must not fold together",
);

// A stop table shaped like Back-on-Track's, with the real duplicate spellings
// and the real cross-border name collision.
const stops = [
  { stop_name: "Praha hl.n.", stop_lat: 50.08, stop_lon: 14.44 },
  { stop_name: "Kolin", stop_lat: 51.92, stop_lon: 15.6 }, // Poland
  { stop_name: "Kolín", stop_lat: 50.03, stop_lon: 15.2 }, // Czechia
  { stop_name: "Pardubice hl.n.", stop_lat: 50.03, stop_lon: 15.76 },
  { stop_name: "Česká Třebová", stop_lat: 49.9, stop_lon: 16.44 },
  { stop_name: "Bydgoszcz Gł.", stop_lat: 53.13, stop_lon: 18.01 },
  { stop_name: "Gdynia Gł.", stop_lat: 54.52, stop_lon: 18.54 },
  { stop_name: "Gdynia Główna", stop_lat: 54.52, stop_lon: 18.54 }, // duplicate
  { stop_name: "Nowhere", stop_lat: null, stop_lon: null }, // no coords → skipped
];
const index = buildStationIndex(stops);

// 2) buildStationIndex — coordinate-less rows never enter the index.
assert.equal(index.exact.has("nowhere"), false, "stops without coords skipped");

// 3) resolveStationList — alternate spellings resolve to the canonical stop.
const resolved = resolveStationList(
  ["Praha Hlavni Nadrazi", "Ceska Trebova", "Bydgoszcz Główna"],
  index,
);
assert.deepEqual(
  resolved.map((s) => s.name),
  ["Praha hl.n.", "Česká Třebová", "Bydgoszcz Gł."],
  "folded names map onto the stop table's own spelling",
);
assert.equal(resolved[0].lat, 50.08, "coordinates come from the stop table");

// 4) The collision: "Kolin" exact-matches the Polish station, but inside a
//    Czech corridor the Czech one is meant. Picking by name alone would throw
//    the route line 200 km off course; the nearest-anchor rule fixes it.
const czech = resolveStationList(["Praha hl.n.", "Kolin", "Pardubice hl.n."], index);
assert.equal(czech[1].name, "Kolín", "ambiguous name resolves to the corridor it sits on");
assert.equal(czech[1].lat, 50.03);

// 5) Same name, no surrounding context → the exact match still wins.
assert.equal(
  resolveStationList(["Kolin"], index)[0].name,
  "Kolin",
  "with nothing to compare against, the exact spelling is kept",
);

// 6) Duplicates at identical coordinates must not be renamed for no reason.
assert.equal(
  resolveStationList(["Bydgoszcz Gł.", "Gdynia Gł."], index)[1].name,
  "Gdynia Gł.",
  "an equivalent duplicate keeps the incoming spelling",
);

// 7) Unknown stations resolve to null rather than to something wrong.
assert.equal(
  resolveStationList(["Ulaanbaatar"], index)[0],
  null,
  "a station the map does not know stays unresolved",
);

console.log(
  "station-resolver OK — folding (diacritics, hl.n./Hbf/Główna), stop-table lookup, geographic disambiguation, duplicate handling",
);
