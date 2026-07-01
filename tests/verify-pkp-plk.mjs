#!/usr/bin/env node
/**
 * Unit tests for the pure PKP PLK transforms (no server, no network):
 * normalizeStops, endpointsMatch, reconcileStopCoords, mergePlkIntoBundle.
 * Run: node tests/verify-pkp-plk.mjs
 *
 * Fixtures mirror the documented PLK shapes (plannedArrival/plannedDeparture
 * ISO DateTimes, stops linked to a stations dictionary by stationId). If the
 * first live response uses different field names, update FIELDS in the adapter —
 * these tests then confirm the transforms still hold.
 */
import assert from "node:assert/strict";
import {
  normalizeStops,
  endpointsMatch,
  reconcileStopCoords,
  mergePlkIntoBundle,
} from "../scripts/adapters/pkp-plk.mjs";

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// Stations dictionary: id → { name, lat, lon }.
const stationsById = {
  1: { name: "Warszawa Wschodnia", lat: 52.2519, lon: 21.0517 },
  2: { name: "Wrocław Główny", lat: 51.0989, lon: 17.0366 },
  3: { name: "Jelenia Góra", lat: 50.9033, lon: 15.7418 },
  4: { name: "Szklarska Poręba Górna", lat: 50.8236, lon: 15.5033 },
  9: { name: "München Hbf" }, // no coords in dict on purpose
};

// A PLK route detail (Warszawa → Szklarska Poręba, 4 calls, ISO times).
const detail16170 = {
  trainNumber: "16170",
  stops: [
    { stationId: "1", plannedDeparture: "2026-07-01T22:10:00" },
    {
      stationId: "2",
      plannedArrival: "2026-07-02T03:40:00",
      plannedDeparture: "2026-07-02T03:55:00",
    },
    {
      stationId: "3",
      plannedArrival: "2026-07-02T05:20:00",
      plannedDeparture: "2026-07-02T05:25:00",
    },
    { stationId: "4", plannedArrival: "2026-07-02T06:15:00" },
    { stationId: "999", plannedArrival: "2026-07-02T06:30:00" }, // unknown id, no name → dropped
  ],
};

// 1) normalizeStops resolves names/coords/times and drops unresolvable stops.
const stops = normalizeStops(detail16170.stops, stationsById);
assert.equal(stops.length, 4, "expected 4 resolvable stops");
assert.equal(stops[0].name, "Warszawa Wschodnia");
assert.equal(stops[0].dep, "22:10", "ISO departure → HH:MM");
assert.equal(stops[1].arr, "03:40", "ISO arrival → HH:MM");
assert.equal(stops[3].name, "Szklarska Poręba Górna");
assert.ok(
  Number.isFinite(stops[0].lat) && Number.isFinite(stops[0].lon),
  "coords from dict",
);

// 2) endpointsMatch is order-independent and city-normalized.
const gtfsStops16170 = [
  { name: "Warszawa Wsch.", lat: 52.25, lon: 21.05 },
  { name: "Wrocław Gł.", lat: 51.1, lon: 17.03 },
  { name: "Szklarska Poręba Górna", lat: 50.82, lon: 15.5 },
];
if (!endpointsMatch(stops, gtfsStops16170))
  fail("endpointsMatch should accept same corridor");
if (!endpointsMatch(stops, [...gtfsStops16170].reverse()))
  fail("endpointsMatch should be order-independent");
const munichCorridor = [
  { name: "München Hbf" },
  { name: "Warszawa Wschodnia" },
];
if (endpointsMatch(stops, munichCorridor))
  fail("endpointsMatch should reject a different corridor");

// 3) reconcileStopCoords backfills missing PLK coords from GTFS by city.
const plkNoCoords = [
  { name: "München Hbf", arr: null, dep: "20:00", lat: null, lon: null },
  {
    name: "Warszawa Wschodnia",
    arr: "08:00",
    dep: null,
    lat: 52.25,
    lon: 21.05,
  },
];
const gtfsMunich = [{ name: "München Hbf", lat: 48.14, lon: 11.56 }];
const reconciled = reconcileStopCoords(plkNoCoords, gtfsMunich);
assert.equal(reconciled[0].lat, 48.14, "missing coord filled from GTFS");
assert.equal(reconciled[1].lat, 52.25, "existing coord preserved");

// 4) mergePlkIntoBundle enriches the matching entry, keeps geometry/calendar,
//    and rejects wrong-corridor candidates (reused train number).
const bundle = {
  16170: {
    positions: [
      [52.25, 21.05],
      [51.1, 17.03],
      [50.82, 15.5],
    ],
    rail_segments: [
      {
        positions: [
          [52.25, 21.05],
          [50.82, 15.5],
        ],
      },
    ],
    stops: [
      { name: "Warszawa Wschodnia", lat: 52.25, lon: 21.05 },
      { name: "Szklarska Poręba Górna", lat: 50.82, lon: 15.5 },
    ], // sparse: only endpoints
    validFrom: "20260701",
    validUntil: "20260801",
    days: "Daily",
  },
  // Reused number 406: bundle entry is the München corridor; PLK candidate below
  // is the Praha corridor → must NOT be applied.
  406: {
    positions: [
      [48.14, 11.56],
      [52.25, 21.05],
    ],
    stops: [{ name: "München Hbf" }, { name: "Warszawa Wschodnia" }],
  },
};

const candidatesByNumber = {
  16170: [{ stops }], // richer (4 stops) same corridor → applied
  406: [{ stops: [{ name: "Praha hl.n." }, { name: "Warszawa Wschodnia" }] }], // wrong corridor
};

const { byTrainKey: merged, enrichedCount } = mergePlkIntoBundle(
  bundle,
  candidatesByNumber,
);
assert.equal(
  enrichedCount,
  1,
  "only the matching 16170 entry should be enriched",
);
assert.equal(
  merged["16170"].stops.length,
  4,
  "16170 stops replaced with the richer PLK list",
);
assert.deepEqual(
  merged["16170"].positions,
  bundle["16170"].positions,
  "geometry preserved",
);
assert.equal(merged["16170"].days, "Daily", "calendar preserved");
assert.equal(
  merged["406"].stops.length,
  2,
  "wrong-corridor candidate rejected (406 unchanged)",
);

// 5) Variants are enriched independently against their own endpoints.
const bundleWithVariant = {
  460: {
    positions: [
      [50, 14],
      [54.5, 18.5],
    ],
    stops: [{ name: "Praha hl.n." }, { name: "Gdynia Gł." }],
    variants: [
      {
        positions: [
          [50, 14],
          [52.25, 21.05],
        ],
        stops: [{ name: "Praha hl.n." }, { name: "Warszawa Wschodnia" }],
      },
    ],
  },
};
const variantCandidates = {
  460: [
    {
      stops: [
        { name: "Praha hlavní nádraží" },
        { name: "Poznań Gł." },
        { name: "Gdynia Główna" },
      ],
    },
    {
      stops: [
        { name: "Praha hlavní nádraží" },
        { name: "Łódź" },
        { name: "Warszawa Wschodnia" },
      ],
    },
  ],
};
const vres = mergePlkIntoBundle(bundleWithVariant, variantCandidates);
assert.equal(vres.enrichedCount, 2, "main + variant both enriched");
assert.equal(
  vres.byTrainKey["460"].stops.length,
  3,
  "main entry got the richer Gdynia corridor",
);
assert.equal(
  vres.byTrainKey["460"].variants[0].stops.length,
  3,
  "variant got the Warszawa corridor",
);

console.log(
  "pkp-plk transforms OK — normalize, endpoint match, coord reconcile, bundle merge + variants",
);
