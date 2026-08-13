// tests/verify-synthetic-scope.mjs
// Unit tests for the two scoping rules that decide whether a synthetic route
// gets built (src/pages/api/lib/build-initial-data.mjs, `excludeBotMatched`):
//
//   1. synthetic.botMatchAgencies — bare train numbers are only unique within
//      an operator, so an unrelated Back-on-Track namesake (CFM/CFR 401 vs
//      European Sleeper's ES 401) must not count as coverage.
//   2. rows carrying the source's own idPrefix never count as coverage — the
//      scrape runner's leftover rows would otherwise mark every train as
//      already covered and shadow the richer row built here.
//
// Raw node, no network. Run: npm run verify-synthetic-scope
import assert from "node:assert";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const station = (name, lat, lon) => ({
  name,
  location: { latitude: lat, longitude: lon },
});

const esEntry = (synthetic) => ({
  v: 1,
  id: "europeansleeper",
  label: "European Sleeper",
  kind: "gtfs",
  enabled: true,
  output: "europeansleeper-trains.json",
  synthetic: {
    idPrefix: "es_",
    agency: { from: "fixed", value: "ES" },
    excludeBotMatched: true,
    ...synthetic,
  },
});

const trains = {
  400: {
    lineName: "400",
    polyline: "p400",
    frequency: "2026: Wed, Fri, Sun",
    stations: [station("Milano", 45.48, 9.18), station("Bruxelles Midi", 50.83, 4.33)],
  },
  401: {
    lineName: "401",
    polyline: "p401",
    frequency: "2026: Mon, Thu, Sat",
    stations: [station("Bruxelles Midi", 50.83, 4.33), station("Milano", 45.48, 9.18)],
  },
  452: {
    lineName: "452",
    polyline: "p452",
    frequency: "2026: Tue, Thu, Sun",
    stations: [station("Praha hl.n.", 50.08, 14.43), station("Bruxelles Midi", 50.83, 4.33)],
  },
};

// A Back-on-Track world containing an ES row for 452, plus an unrelated
// Romanian train that happens to be numbered 401, plus a leftover row the
// scrape runner synthesised for 400.
const world = () => ({
  stops: [
    { stop_id: "Praha hl.n.", stop_name: "Praha hl.n.", stop_lat: 50.08, stop_lon: 14.43 },
    { stop_id: "Bruxelles Midi", stop_name: "Bruxelles Midi", stop_lat: 50.83, stop_lon: 4.33 },
  ],
  viewMap: {
    22: {
      route_id: 22,
      agency_id: "CFM/CFR",
      trip_short_name_0: "401",
      trip_short_name_1: "402",
      is_active: "Y",
    },
    237: {
      route_id: 237,
      agency_id: "ES",
      trip_short_name_0: "452",
      trip_short_name_1: "453",
      is_active: "Y",
    },
    es_400: {
      route_id: "es_400",
      agency_id: "ES",
      trip_short_name_0: "400",
      origin_trip_0: "Milano",
      destination_trip_0: "Bruxelles Midi",
      nj_polyline: "stale-leftover",
      is_active: "Y",
    },
  },
  trips: {
    "CFR 401": { route_id: 22, agency_id: "CFM/CFR", trip_short_name: "401" },
    "ES 452": { route_id: 237, agency_id: "ES", trip_short_name: "452" },
    "ES 400": { route_id: "es_400", agency_id: "ES", trip_short_name: "400" },
  },
});

const build = (synthetic) => {
  const { stops, viewMap, trips } = world();
  return buildInitialData({
    stops,
    viewMap,
    trips,
    operatorTrains: { europeansleeper: trains },
    registry: [esEntry(synthetic)],
    seenIndex: null,
  }).viewMap;
};

check("a BoT row for the same operator still suppresses its synthetic twin", () => {
  // 452 is covered by the real ES row 237, so no es_452 is invented.
  const vm = build({ botMatchAgencies: ["ES"] });
  assert.strictEqual(vm.es_452, undefined);
  assert.ok(vm[237], "the Back-on-Track row survives and is the one enriched");
});

check("unscoped, a foreign namesake swallows the train", () => {
  // Documents the bug botMatchAgencies fixes: CFM/CFR 401 is unrelated to ES 401.
  const vm = build({});
  assert.strictEqual(vm.es_400?.trip_short_name_1, undefined);
});

check("botMatchAgencies ignores the foreign namesake", () => {
  const vm = build({ botMatchAgencies: ["ES"] });
  assert.strictEqual(vm.es_400.trip_short_name_0, "400");
  assert.strictEqual(vm.es_400.trip_short_name_1, "401");
});

check("our own leftover row never counts as Back-on-Track coverage", () => {
  // The runner's leftover es_400 row is in the view map; without the idPrefix
  // exclusion it marks 400 as covered and its stale single-polyline row wins.
  const vm = build({ botMatchAgencies: ["ES"], withService: true });
  assert.strictEqual(vm.es_400.nj_polyline_0, "p400");
  assert.strictEqual(vm.es_400.nj_polyline_1, "p401");
  assert.strictEqual(vm.es_400.nj_polyline, undefined, "stale leftover row replaced");
  assert.strictEqual(vm.es_400.service_id_0, "2026: Wed, Fri, Sun");
  assert.strictEqual(vm.es_400.service_id_1, "2026: Mon, Thu, Sat");
});

console.log(`\n[verify-synthetic-scope] ${passed} checks passed`);
