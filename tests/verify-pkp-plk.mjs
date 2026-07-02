#!/usr/bin/env node
/**
 * Unit tests for the pure PKP PLK transforms (no server, no network):
 * normalizeStops, endpointsMatch, endpointKey, reconcileStopCoords,
 * mergePlkIntoBundle. Run: node tests/verify-pkp-plk.mjs
 *
 * Fixtures mirror the REAL PLK schema confirmed from live responses (2026-07):
 * a stop carries `stationId` (name resolved via the dictionary), `orderNumber`,
 * and `arrivalTime`/`departureTime` in "HH:MM:SS"; the dictionary is {id, name}
 * with no coordinates. If field names change, update FIELDS in the adapter.
 */
import assert from "node:assert/strict";
import {
  normalizeStops,
  endpointsMatch,
  endpointKey,
  reconcileStopCoords,
  mergePlkIntoBundle,
} from "../scripts/adapters/pkp-plk.mjs";

// Dictionary: id → { name } (no coordinates, exactly like the live API).
const stationsById = {
  129059: { name: "Praha Hlavni Nadrazi" },
  45100: { name: "Poznań Główny" },
  43100: { name: "Gdynia Główna" },
  50500: {}, // present but unnamed → dropped
};

// A PLK route's stations, deliberately out of order + one unresolvable id.
const rawStations = [
  { stationId: 43100, orderNumber: 9, arrivalTime: "07:30:00" }, // Gdynia (last)
  { stationId: 129059, orderNumber: 1, departureTime: "18:10:00" }, // Praha (first)
  {
    stationId: 45100,
    orderNumber: 5,
    arrivalTime: "03:40:06",
    departureTime: "03:52:00",
  },
  { stationId: 770000, orderNumber: 7, departureTime: "05:00:00" }, // id absent from dict → dropped
  { stationId: 50500, orderNumber: 8, departureTime: "06:00:00" }, // unnamed dict entry → dropped
];

// 1) normalizeStops: sorts by orderNumber, resolves names via dict, formats
//    "HH:MM:SS" → "HH:MM", leaves coords null, drops unresolvable stops.
const stops = normalizeStops(rawStations, stationsById);
assert.equal(stops.length, 3, "3 resolvable stops (two dropped)");
assert.deepEqual(
  stops.map((s) => s.name),
  ["Praha Hlavni Nadrazi", "Poznań Główny", "Gdynia Główna"],
  "ordered by orderNumber",
);
assert.equal(stops[0].dep, "18:10", "HH:MM:SS departure → HH:MM");
assert.equal(stops[1].arr, "03:40", "seconds dropped");
assert.equal(stops[1].dep, "03:52");
assert.equal(stops[2].arr, "07:30");
assert.equal(stops[0].lat, null, "PLK has no coordinates");
assert.equal(stops[0].lon, null);

// 2) endpointsMatch — order-independent, city-normalized.
const gtfs460 = [
  { name: "Praha hl.n.", lat: 50.08, lon: 14.44 },
  { name: "Gdynia Gł.", lat: 54.52, lon: 18.54 },
];
assert.ok(endpointsMatch(stops, gtfs460), "same corridor");
assert.ok(endpointsMatch(stops, [...gtfs460].reverse()), "order-independent");
assert.ok(
  !endpointsMatch(stops, [{ name: "Berlin Hbf" }, { name: "Gdynia Gł." }]),
  "different corridor",
);

// 3) endpointKey — sorted city pair.
assert.equal(endpointKey(stops), "gdynia|praha");
assert.equal(endpointKey([{ name: "x" }]), "", "needs two endpoints");

// 4) reconcileStopCoords — backfills missing PLK coords from GTFS by city.
const reconciled = reconcileStopCoords(stops, [
  { name: "Praha hlavní nádraží", lat: 50.08, lon: 14.44 },
  { name: "Gdynia Główna", lat: 54.52, lon: 18.54 },
]);
assert.equal(reconciled[0].lat, 50.08, "Praha coord filled from GTFS");
assert.equal(reconciled[2].lat, 54.52, "Gdynia coord filled from GTFS");
assert.equal(
  reconciled[1].lat,
  null,
  "Poznań stays null (not in the GTFS pair)",
);

// 5) mergePlkIntoBundle — number match, endpoint fallback, wrong-corridor reject.
const richWarSzk = [
  { name: "Warszawa Wschodnia" },
  { name: "Wrocław Główny" },
  { name: "Szklarska Poręba Górna" },
];
const richPraGdy = [
  { name: "Praha Hlavni Nadrazi" },
  { name: "Poznań Główny" },
  { name: "Gdynia Główna" },
];
const bundle = {
  16170: {
    positions: [
      [52.25, 21.05],
      [50.82, 15.5],
    ],
    stops: [
      { name: "Warszawa Wschodnia", lat: 52.25, lon: 21.05 },
      { name: "Szklarska Poręba Górna", lat: 50.82, lon: 15.5 },
    ],
    days: "Daily",
  },
  460: {
    positions: [
      [50.08, 14.44],
      [54.52, 18.54],
    ],
    stops: [
      { name: "Praha hl.n.", lat: 50.08, lon: 14.44 },
      { name: "Gdynia Gł.", lat: 54.52, lon: 18.54 },
    ],
  },
  406: {
    positions: [
      [48.14, 11.56],
      [52.25, 21.05],
    ],
    stops: [{ name: "München Hbf" }, { name: "Warszawa Wschodnia" }],
  },
};
const candidates = [
  { number: "16170", stops: richWarSzk }, // same-number match
  { number: "45402", stops: richPraGdy }, // international: number ≠ "460", endpoint fallback
  {
    number: "406",
    stops: [{ name: "Praha hl.n." }, { name: "Warszawa Wschodnia" }],
  }, // wrong corridor
];

const { byTrainKey: merged, enrichedCount } = mergePlkIntoBundle(
  bundle,
  candidates,
);
assert.equal(
  enrichedCount,
  2,
  "16170 (by number) + 460 (by endpoint) enriched",
);
assert.equal(merged["16170"].stops.length, 3, "16170 matched by number");
assert.equal(
  merged["460"].stops.length,
  3,
  "460 matched by endpoint despite number 45402",
);
assert.deepEqual(
  merged["460"].positions,
  bundle["460"].positions,
  "geometry preserved",
);
assert.equal(merged["16170"].days, "Daily", "calendar untouched");
assert.equal(
  merged["406"].stops.length,
  2,
  "wrong-corridor 406 left unchanged",
);

// 6) Variants enriched independently by endpoint.
const withVariant = {
  460: {
    positions: [
      [50, 14],
      [54.5, 18.5],
    ],
    stops: [{ name: "Praha hl.n." }, { name: "Gdynia Gł." }],
    variants: [
      { stops: [{ name: "Praha hl.n." }, { name: "Warszawa Wschodnia" }] },
    ],
  },
};
const vcands = [
  { number: "45402", stops: richPraGdy },
  {
    number: "45410",
    stops: [
      { name: "Praha Hlavni Nadrazi" },
      { name: "Łódź Fabryczna" },
      { name: "Warszawa Wschodnia" },
    ],
  },
];
const vres = mergePlkIntoBundle(withVariant, vcands);
assert.equal(vres.enrichedCount, 2, "main + variant enriched");
assert.equal(vres.byTrainKey["460"].stops.length, 3, "main → Gdynia corridor");
assert.equal(
  vres.byTrainKey["460"].variants[0].stops.length,
  3,
  "variant → Warszawa corridor",
);

console.log(
  "pkp-plk transforms OK — normalize/sort/times, endpoint match+key, coord reconcile, number+endpoint merge, variants",
);
