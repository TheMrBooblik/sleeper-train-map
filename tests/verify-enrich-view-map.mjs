// tests/verify-enrich-view-map.mjs
// Unit tests for the registry-driven view-map enrichment post-step
// (scripts/lib/enrich-view-map.mjs): NightJet legacy behavior stays
// byte-identical to the old finalizeViewMap, the PKP GTFS bundle stamps only
// endpoint-validated rows, and the trainsByNumber options used by official
// sources (via/times/per-direction polylines/stamp) work.
// Run: npm run verify-enrich
import assert from "node:assert";
import {
  enrichViewMap,
  appendSyntheticLeftovers,
} from "../scripts/lib/enrich-view-map.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const njEntry = (over = {}) => ({
  id: "nightjet",
  enabled: true,
  output: "nightjet-trains.json",
  enrich: { strategy: "trainsByNumber", setPolyline: true },
  synthetic: { idPrefix: "nj_standalone_", agency: { from: "fixed", value: "ÖBB" } },
  ...over,
});

const station = (name, time = null) => ({
  name,
  location: { latitude: 48.2, longitude: 16.4 },
  arrival: time,
  departure: time,
});

check("NJ legacy: polyline merged onto matched BoT row, first direction wins", () => {
  const viewMap = {
    1: { trip_short_name_0: "NJ 100", trip_short_name_1: "NJ 101" },
  };
  enrichViewMap({
    registry: [njEntry()],
    viewMap,
    getTrains: () => ({
      "NJ 100": { polyline: "poly100", stations: [station("A"), station("B")] },
      "NJ 101": { polyline: "poly101", stations: [station("B"), station("A")] },
    }),
    readJson: () => null,
  });
  assert.strictEqual(viewMap[1].nj_polyline, "poly100");
  // legacy mode must not touch via/times/stamps
  assert.strictEqual(viewMap[1].via_0, undefined);
  assert.strictEqual(viewMap[1].official_sources, undefined);
});

check("NJ leftovers: synthetic rows for unmatched trains, reverse paired", () => {
  const viewMap = {
    1: { trip_short_name_0: "NJ 100" },
  };
  const trains = {
    "NJ 100": { polyline: "p", stations: [station("A"), station("B")] },
    "NJ 200": { polyline: "p200", stations: [station("X"), station("Mid"), station("Y")] },
    "NJ 201": { polyline: "p201", stations: [station("Y"), station("Mid"), station("X")] },
    "NJ 300": { polyline: null, stations: [station("X"), station("Y")] }, // no polyline → skipped
  };
  appendSyntheticLeftovers({ entry: njEntry(), viewMap, trains });
  const row = viewMap.nj_standalone_NJ_200;
  assert.ok(row, "synthetic row created");
  assert.strictEqual(row.agency_id, "ÖBB");
  assert.strictEqual(row.origin_trip_0, "X");
  assert.strictEqual(row.destination_trip_0, "Y");
  assert.strictEqual(row.via_0, "Mid");
  assert.strictEqual(row.nj_polyline, "p200");
  assert.strictEqual(row.is_active, "Y");
  // reverse direction folded into the same row, not a second row
  assert.strictEqual(row.trip_short_name_1, "NJ 201");
  assert.strictEqual(viewMap.nj_standalone_NJ_201, undefined);
  assert.strictEqual(viewMap.nj_standalone_NJ_300, undefined);
});

check("trainsByNumber full options: via/times/per-direction polyline/stamp", () => {
  const entry = {
    id: "europeansleeper",
    enabled: true,
    output: "europeansleeper-trains.json",
    enrich: {
      strategy: "trainsByNumber",
      agencyIds: ["ES"],
      setPolyline: true,
      polylineMode: "perDirection",
      updateVia: true,
      setTimes: true,
      stamp: true,
    },
  };
  const viewMap = {
    237: {
      agency_id: "ES",
      trip_short_name_0: "452",
      trip_short_name_1: "453",
      via_0: "old - stale",
    },
    9: { agency_id: "PKP", trip_short_name_0: "452" }, // out of agency scope
  };
  enrichViewMap({
    registry: [entry],
    viewMap,
    getTrains: () => ({
      452: {
        polyline: "es452poly",
        stations: [
          { ...station("Praha hl.n."), departure: "2026-06-12T18:04:00.000Z" },
          station("Dresden Hbf"),
          { ...station("Bruxelles Midi"), arrival: "2026-06-13T09:27:00.000Z" },
        ],
      },
    }),
    readJson: () => null,
  });
  const row = viewMap[237];
  assert.strictEqual(row.nj_polyline_0, "es452poly");
  assert.strictEqual(row.nj_polyline_1, undefined); // no data for 453 tonight
  assert.strictEqual(row.via_0, "Dresden Hbf");
  assert.strictEqual(row.origin_departure_time_0, "18:04");
  assert.strictEqual(row.destination_arrival_time_0, "09:27");
  assert.deepStrictEqual(row.official_sources, ["europeansleeper"]);
  assert.strictEqual(viewMap[9].official_sources, undefined);
});

check("stamping is idempotent and sorted across sources", () => {
  const entry = njEntry({
    id: "nightjet",
    enrich: { strategy: "trainsByNumber", stamp: true },
  });
  const viewMap = {
    1: { trip_short_name_0: "NJ 100", official_sources: ["zz-other"] },
  };
  const args = {
    registry: [entry],
    viewMap,
    getTrains: () => ({ "NJ 100": { polyline: "p", stations: [station("A"), station("B")] } }),
    readJson: () => null,
  };
  enrichViewMap(args);
  enrichViewMap(args);
  assert.deepStrictEqual(viewMap[1].official_sources, ["nightjet", "zz-other"]);
});

const pkpEntry = {
  id: "pkp-gtfs",
  enabled: true,
  runner: "external",
  command: "npm run parse-pkp-gtfs",
  enrich: { strategy: "gtfsBundle", agencyIds: ["PKP", "PKP/ČD"], updateVia: true, stamp: true },
  params: { statusFile: "public/data/gtfs/pkpTrainShapes.json" },
};
const bundle = {
  byTrainKey: {
    430: {
      positions: [
        [49.78, 22.77],
        [53.91, 14.25],
      ],
      stops: [
        { name: "Przemyśl Główny" },
        { name: "Poznań Główny" },
        { name: "Świnoujście" },
      ],
    },
  },
};

check("gtfsBundle: endpoint-matched PKP row gets official via + stamp", () => {
  const viewMap = {
    126: {
      agency_id: "PKP",
      // endpoint matching is city-token based ("Przemyśl Gł." ≍ "Przemyśl
      // Główny"), but buildVia only strips endpoints spelled exactly like the
      // BoT origin/destination — same contract as the client-side merge.
      origin_trip_0: "Przemyśl Główny",
      destination_trip_0: "Świnoujście",
      trip_short_name_0: "EN 430 / IC 28170",
      via_0: "stale - bot - stops",
    },
  };
  enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: (p) => (p === "public/data/gtfs/pkpTrainShapes.json" ? bundle : null),
  });
  assert.strictEqual(viewMap[126].via_0, "Poznań Główny");
  assert.deepStrictEqual(viewMap[126].official_sources, ["pkp-gtfs"]);
});

check("gtfsBundle: wrong-corridor collision is not stamped", () => {
  const viewMap = {
    99: {
      agency_id: "PKP",
      trip_short_name_0: "IC 430", // same number, different corridor
      origin_trip_0: "Chełm",
      destination_trip_0: "Świnoujście",
      via_0: "untouched",
    },
  };
  enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => bundle,
  });
  assert.strictEqual(viewMap[99].official_sources, undefined);
  assert.strictEqual(viewMap[99].via_0, "untouched");
});

check("gtfsBundle: missing bundle file is a no-op", () => {
  const viewMap = { 126: { agency_id: "PKP", trip_short_name_0: "EN 430" } };
  enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => null,
  });
  assert.deepStrictEqual(viewMap, { 126: { agency_id: "PKP", trip_short_name_0: "EN 430" } });
});

check("a failing source is isolated; later sources still enrich", () => {
  const viewMap = { 1: { trip_short_name_0: "NJ 100" } };
  const logs = [];
  enrichViewMap({
    registry: [
      njEntry({ id: "broken", output: "broken.json" }),
      njEntry(),
    ],
    viewMap,
    getTrains: (entry) => {
      if (entry.id === "broken") throw new Error("boom");
      return { "NJ 100": { polyline: "ok", stations: [station("A"), station("B")] } };
    },
    readJson: () => null,
    log: (m) => logs.push(m),
  });
  assert.strictEqual(viewMap[1].nj_polyline, "ok");
  assert.ok(logs.some((m) => m.includes("broken") && m.includes("failed")));
});

console.log(`\n[verify-enrich] ${passed} checks passed`);
