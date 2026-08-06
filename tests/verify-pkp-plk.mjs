#!/usr/bin/env node
/**
 * Unit tests for the pure PKP PLK transforms (no server, no network):
 * normalizeStops, endpointsMatch, endpointKey, reconcileStopCoords,
 * mergePlkIntoBundle, canonicalizeStationName. Run: node tests/verify-pkp-plk.mjs
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
  plkScheduleForRow,
  canonicalizeStationName,
  parseClock,
  clockGapMinutes,
  endpointTimesAgree,
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
// Times as the real feeds carry them (every live bundle entry and PLK
// candidate has endpoint times): the endpoint fallback checks the clock, so a
// same-corridor service running at a different hour is a different train.
const richPraGdy = [
  { name: "Praha Hlavni Nadrazi", dep: "18:49" },
  { name: "Poznań Główny", arr: "01:12", dep: "01:20" },
  { name: "Gdynia Główna", arr: "05:58" },
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
      { name: "Praha hl.n.", lat: 50.08, lon: 14.44, dep: "18:49" },
      { name: "Gdynia Gł.", lat: 54.52, lon: 18.54, arr: "05:58" },
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
  // Same corridor, same endpoint cities, daytime — must NOT overwrite 460.
  {
    number: "45900",
    stops: [
      { name: "Praha Hlavni Nadrazi", dep: "06:10" },
      { name: "Wrocław Główny", arr: "10:05", dep: "10:15" },
      { name: "Poznań Główny", arr: "12:30", dep: "12:38" },
      { name: "Gdynia Główna", arr: "16:44" },
    ],
  },
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
    stops: [
      { name: "Praha hl.n.", dep: "18:49" },
      { name: "Gdynia Gł.", arr: "05:58" },
    ],
    variants: [
      {
        stops: [
          { name: "Praha hl.n.", dep: "22:16" },
          { name: "Warszawa Wschodnia", arr: "08:15" },
        ],
      },
    ],
  },
};
const vcands = [
  { number: "45402", stops: richPraGdy },
  {
    number: "45410",
    stops: [
      { name: "Praha Hlavni Nadrazi", dep: "22:16" },
      { name: "Łódź Fabryczna", arr: "04:40", dep: "04:48" },
      { name: "Warszawa Wschodnia", arr: "08:15" },
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

// 7) plkScheduleForRow — GTFS-less row gets pkp_schedule + via_ per direction by
//    ORIENTED endpoints (correct times/order), preferring same-number.
const rijekaRow = {
  agency_id: "PKP",
  trip_short_name_0: "EN 1276",
  origin_trip_0: "Rijeka",
  destination_trip_0: "Warszawa Wschodnia",
  trip_short_name_1: "EN 1277",
  origin_trip_1: "Warszawa Wschodnia",
  destination_trip_1: "Rijeka",
  via_0: "OLD VIA (replaced by the PLK via)",
};
const rijekaCands = [
  {
    number: "1276",
    operatingDates: ["2026-07-04", "2026-07-11", "2026-07-18"],
    stops: [
      { name: "Rijeka", arr: null, dep: "18:00" },
      { name: "Ljubljana", arr: "20:00", dep: "20:10" },
      { name: "Wien Hauptbahnhof", arr: "23:00", dep: "23:20" },
      { name: "Warszawa Wschodnia", arr: "10:00", dep: null },
    ],
  },
  {
    number: "1277",
    operatingDates: ["2026-07-05"],
    stops: [
      { name: "Warszawa Wschodnia", arr: null, dep: "19:00" },
      { name: "Wien Hauptbahnhof", arr: "06:00", dep: "06:20" },
      { name: "Rijeka", arr: "12:00", dep: null },
    ],
  },
];
const rf = plkScheduleForRow(rijekaRow, rijekaCands);
assert.ok(rf, "Rijeka row enriched from PLK");
assert.equal(rf.pkp_schedule_0.length, 4, "dir0 Rijeka -> Warszawa (4 stops)");
assert.equal(rf.pkp_schedule_0[0].name, "Rijeka");
assert.equal(rf.pkp_schedule_0[3].name, "Warszawa Wschodnia");
assert.equal(
  rf.pkp_schedule_1.length,
  3,
  "dir1 Warszawa -> Rijeka (own times)",
);
assert.equal(rf.pkp_schedule_1[0].name, "Warszawa Wschodnia");
assert.equal(rf.pkp_schedule_1[0].dep, "19:00", "dir1 keeps its own departure");
assert.equal(
  rf.via_0,
  "Ljubljana - Wien Hauptbahnhof",
  "via_0 = intermediate stations in order, endpoints dropped",
);
assert.equal(rf.via_1, "Wien Hauptbahnhof", "via_1 intermediate only");
assert.ok(rf.pkp_valid_0?.days, "calendar derived from operatingDates");
assert.equal(
  plkScheduleForRow(
    { agency_id: "PKP", origin_trip_0: "Gdańsk", destination_trip_0: "Kraków" },
    rijekaCands,
  ),
  null,
  "no oriented endpoint match -> null",
);

// 8) canonicalizeStationName — PLK ASCII/alternate names → canonical BoT names
//    via the shared alias table, so international stops match BoT
//    coordinate-bearing stations (map dots + line). Unmapped names pass through.
assert.equal(canonicalizeStationName("Bohumin"), "Bohumín", "diacritic alias");
assert.equal(canonicalizeStationName("Breclav"), "Břeclav");
assert.equal(
  canonicalizeStationName("Graz Hauptbahnhof"),
  "Graz Hbf",
  "naming-form alias",
);
assert.equal(
  canonicalizeStationName("Stare Mesto u Uher. Hradiste"),
  "Staré Město u Uherského Hradiště",
);
assert.equal(
  canonicalizeStationName("Ljubljana"),
  "Ljubljana",
  "unmapped name passes through unchanged",
);
assert.equal(canonicalizeStationName(""), "", "empty passes through");

// 9) plkScheduleForRow threads the canonicalizer through via_ AND pkp_schedule_.
const canonRow = {
  agency_id: "PKP",
  trip_short_name_0: "EN 1276",
  origin_trip_0: "Rijeka",
  destination_trip_0: "Warszawa Wschodnia",
};
const canonCands = [
  {
    number: "1276",
    stops: [
      { name: "Rijeka", arr: null, dep: "18:00" },
      { name: "Lasko", arr: "20:00", dep: "20:02" },
      { name: "Bohumin", arr: "04:00", dep: "04:05" },
      { name: "Warszawa Wschodnia", arr: "10:00", dep: null },
    ],
  },
];
const cf = plkScheduleForRow(canonRow, canonCands, canonicalizeStationName);
assert.equal(
  cf.via_0,
  "Laško - Bohumín",
  "via_ names canonicalized, endpoints dropped",
);
assert.deepEqual(
  cf.pkp_schedule_0.map((s) => s.name),
  ["Rijeka", "Laško", "Bohumín", "Warszawa Wschodnia"],
  "schedule names canonicalized",
);
// Default (no canonicalizer) leaves names verbatim — back-compat for callers.
assert.equal(
  plkScheduleForRow(canonRow, canonCands).via_0,
  "Lasko - Bohumin",
  "default identity preserves raw names",
);

// 10) mergePlkIntoBundle threads the canonicalizer into folded bundle stops.
const cbRes = mergePlkIntoBundle(
  {
    1276: {
      positions: [
        [45.33, 14.44],
        [52.25, 21.05],
      ],
      stops: [{ name: "Rijeka" }, { name: "Warszawa Wschodnia" }],
    },
  },
  [
    {
      number: "1276",
      stops: [
        { name: "Rijeka" },
        { name: "Bohumin" },
        { name: "Warszawa Wschodnia" },
      ],
    },
  ],
  canonicalizeStationName,
);
assert.deepEqual(
  cbRes.byTrainKey["1276"].stops.map((s) => s.name),
  ["Rijeka", "Bohumín", "Warszawa Wschodnia"],
  "bundle fold canonicalizes PLK names",
);

// ── Endpoint match alone is not identity ────────────────────────────────────
// Praha → Warszawa is run by an overnight EuroNight AND by daytime EuroCitys.
// PLK's international trains carry a national number that does not equal the
// commercial one, so the endpoint fallback is the only match available — and
// without a clock check it stamped a daytime EC's stop list and times onto
// EN 11443, giving the sleeper six stations it does not call at.
assert.equal(parseClock("22:16"), 22 * 60 + 16);
assert.equal(parseClock("08:04:00"), 8 * 60 + 4);
assert.equal(parseClock(""), null);
assert.equal(parseClock("25:00"), null);
// Shortest way round the clock face, so an overnight pair stays close.
assert.equal(clockGapMinutes(parseClock("23:50"), parseClock("00:10")), 20);
assert.equal(clockGapMinutes(parseClock("14:08"), parseClock("22:16")), 488);

const nightTrainRow = {
  agency_id: "PKP/ČD",
  trip_short_name_0: "EN 11443",
  origin_trip_0: "Praha hl.n.",
  origin_departure_time_0: "22:16",
  destination_trip_0: "Warszawa Wschodnia",
  destination_arrival_time_0: "08:15",
};
const daytimeEc = {
  number: "41000",
  stops: [
    { name: "Praha Hlavni Nadrazi", dep: "14:08" },
    { name: "Tychy", arr: "19:36", dep: "19:41" },
    { name: "Warszawa Wschodnia", arr: "23:23" },
  ],
};
assert.equal(
  endpointTimesAgree(daytimeEc.stops, "22:16", "08:15"),
  false,
  "a daytime EC must not read as the overnight service",
);
assert.equal(
  plkScheduleForRow(nightTrainRow, [daytimeEc], canonicalizeStationName),
  null,
  "same endpoints + wrong clock = no match",
);

const overnight = {
  number: "41500",
  stops: [
    { name: "Praha Hlavni Nadrazi", dep: "22:16" },
    { name: "Katowice", arr: "05:19", dep: "05:24" },
    { name: "Warszawa Wschodnia", arr: "08:15" },
  ],
};
const okFields = plkScheduleForRow(nightTrainRow, [overnight], canonicalizeStationName);
assert.ok(okFields?.pkp_schedule_0, "the service that runs at the right time still matches");
assert.ok(okFields.via_0.includes("Katowice"), "its stop list drives the map dots");
assert.ok(
  !okFields.via_0.includes("Tychy"),
  "and carries only the stations this train actually calls at",
);

// A candidate carrying this train's own number is trusted without the clock
// check — the number is stronger evidence than the timetable it came with.
const numbered = { ...overnight, number: "11443", stops: daytimeEc.stops };
assert.ok(
  plkScheduleForRow(nightTrainRow, [numbered], canonicalizeStationName)?.pkp_schedule_0,
  "a same-number candidate is still accepted",
);

console.log(
  "pkp-plk transforms OK — normalize/sort/times, endpoint match+key, coord reconcile, number+endpoint merge, variants, name canonicalization, clock guard",
);
