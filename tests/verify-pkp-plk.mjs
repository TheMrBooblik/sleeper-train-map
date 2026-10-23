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
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  normalizeStops,
  endpointsMatch,
  endpointKey,
  reconcileStopCoords,
  mergePlkIntoBundle,
  plkScheduleForRow,
  canonicalizeStationName,
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

// 7b) A candidate must leave and arrive when the row says it does. PLK runs a
//     day train on the night train's pair (IC 3808 Przemyśl 07:12 →
//     Świnoujście 18:52 beside EN 430 / IC 28170 at 18:54 → 06:34); taken by
//     endpoint cities alone, its stop list and times landed on the sleeper's
//     row. The real train is a through car — PLK 37010 to Poznań, then 28170 —
//     and is stitched from those two legs at the station they share.
const ursaRow = {
  agency_id: "PKP",
  trip_short_name_0: "EN 430 / IC 28170",
  origin_trip_0: "Przemyśl Gł.",
  origin_departure_time_0: "18:54",
  destination_trip_0: "Świnoujście",
  destination_arrival_time_0: "06:34",
};
const ursaCands = [
  {
    number: "3808", // the day train on the same pair
    stops: [
      { name: "Przemyśl Główny", arr: null, dep: "07:12" },
      { name: "Zielona Góra Główna", arr: "15:04", dep: "15:05" },
      { name: "Świnoujście", arr: "18:52", dep: null },
    ],
  },
  {
    number: "37010", // EN 430 under its national number, on to Berlin
    operatingDates: ["2026-10-22", "2026-10-23"],
    stops: [
      { name: "Przemyśl Główny", arr: null, dep: "18:55" },
      { name: "Kraków Główny", arr: "21:21", dep: "21:35" },
      { name: "Poznań Główny", arr: "02:22", dep: "03:19" },
      { name: "Rzepin", arr: "04:46", dep: "04:49" },
      { name: "Berlin Gesundbrunnen", arr: "06:37", dep: null },
    ],
  },
  {
    number: "28170",
    operatingDates: ["2026-10-22", "2026-10-23"],
    stops: [
      { name: "Chełm", arr: null, dep: "18:18" },
      { name: "Warszawa Centralna", arr: "21:43", dep: "22:16" },
      { name: "Poznań Główny", arr: "02:41", dep: "03:14" },
      { name: "Szczecin Główny", arr: "05:11", dep: "05:13" },
      { name: "Świnoujście", arr: "06:39", dep: null },
    ],
  },
];
const ursa = plkScheduleForRow(ursaRow, ursaCands);
assert.deepEqual(
  ursa.pkp_schedule_0.map((s) => s.name),
  [
    "Przemyśl Główny",
    "Kraków Główny",
    "Poznań Główny",
    "Szczecin Główny",
    "Świnoujście",
  ],
  "through car stitched at Poznań, the day train refused",
);
assert.deepEqual(
  [ursa.pkp_schedule_0[2].arr, ursa.pkp_schedule_0[2].dep],
  ["02:22", "03:14"],
  "the junction keeps the first leg's arrival and the second leg's departure",
);
assert.equal(ursa.pkp_schedule_0[0].dep, "18:55");
assert.equal(ursa.pkp_valid_0?.validFrom, "20261022", "dates both legs run");
assert.equal(
  plkScheduleForRow(ursaRow, [ursaCands[0]]),
  null,
  "a day train alone is no match for the night train's row",
);
assert.equal(
  plkScheduleForRow(ursaRow, [ursaCands[1], ursaCands[2]].map((c) => ({
    ...c,
    stops: c.stops.map((s) =>
      s.name === "Poznań Główny" && c.number === "28170"
        ? { ...s, dep: "08:00" }
        : s,
    ),
  }))),
  null,
  "no stitch when the second leg leaves the junction hours after the first arrives",
);

// The committed PLK candidates against the committed rows: every row PLK
// enriches now carries a schedule within the tolerance of its own clocks, and
// the two through-car rows (EN 430 / IC 28170, TLK 35190/50191) are stitched.
{
  const vm = JSON.parse(
    fs.readFileSync(
      new URL("../public/data/scraped/backontrack-view_ontd_map.json", import.meta.url),
      "utf8",
    ),
  ).data;
  const plk = JSON.parse(
    fs.readFileSync(
      new URL("../public/data/scraped/pkp-plk-trains.json", import.meta.url),
      "utf8",
    ),
  ).data.candidates;
  const minutes = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const gap = (a, b) => {
    const d = Math.abs(minutes(a) - minutes(b)) % 1440;
    return Math.min(d, 1440 - d);
  };
  let checked = 0;
  for (const r of Object.values(vm)) {
    if (!(r.official_sources ?? []).includes("pkp-plk")) continue;
    for (const d of [0, 1]) {
      const s = r[`pkp_schedule_${d}`];
      if (!s?.length) continue;
      const dep = r[`origin_departure_time_${d}`];
      const arr = r[`destination_arrival_time_${d}`];
      if (dep) assert.ok(gap(s[0].dep, dep) <= 90, `route ${r.route_id}/${d} departs ${s[0].dep}, row ${dep}`);
      if (arr) assert.ok(gap(s.at(-1).arr, arr) <= 90, `route ${r.route_id}/${d} arrives ${s.at(-1).arr}, row ${arr}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `${checked} enriched directions checked`);
  const r126 = plkScheduleForRow(vm["126"], plk, canonicalizeStationName);
  assert.ok(
    r126.via_0.includes("Poznań Główny") && !r126.via_0.includes("Zielona Góra"),
    "EN 430 runs via Poznań, not the day train's Zielona Góra",
  );
  assert.equal(r126.pkp_schedule_1[0].dep, "21:33", "IC 82170 / EC 431 leaves Świnoujście 21:33");
  const r10 = plkScheduleForRow(vm["10"], plk, canonicalizeStationName);
  assert.equal(r10.pkp_schedule_0.at(-1).name, "Hel", "TLK 35190/50191 reaches Hel");
}

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
assert.equal(
  canonicalizeStationName("Praha Hlavni Nadrazi"),
  "Praha hl.n.",
  "PLK Czech ASCII origin aliases to BoT",
);
assert.equal(canonicalizeStationName("Praha-Liben"), "Praha-Libeň");
assert.equal(canonicalizeStationName("Pardubice Hlavni Nadrazi"), "Pardubice hl.n.");
assert.equal(canonicalizeStationName("Ceska Trebova"), "Česká Třebová");
assert.equal(canonicalizeStationName("Zabreh na Morave"), "Zábřeh na Moravě");
assert.equal(canonicalizeStationName("Olomouc Hlavni Nadrazi"), "Olomouc hl.n.");
assert.equal(canonicalizeStationName("Ostrava Hlavni Nadrazi"), "Ostrava hl.n.");

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

console.log(
  "pkp-plk transforms OK — normalize/sort/times, endpoint match+key, coord reconcile, number+endpoint merge, variants, name canonicalization",
);
