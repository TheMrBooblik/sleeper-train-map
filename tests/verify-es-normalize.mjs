// tests/verify-es-normalize.mjs
// Unit tests for the European Sleeper adapter's pure core
// (scripts/adapters/europeansleeper.mjs): BoT-driven train discovery, the
// station-coordinate resolution chain, and journey normalization into the
// standard trains-file shape (bare-number keys — BoT view-map names are bare).
// Run: npm run verify-es
import assert from "node:assert";
import {
  discoverEsTrainNumbers,
  makeStationResolver,
  normalizeEsTrains,
} from "../scripts/adapters/europeansleeper.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("discovery: bare numbers from ES view-map rows and trips only", () => {
  const numbers = discoverEsTrainNumbers(
    {
      237: { agency_id: "ES", trip_short_name_0: "452", trip_short_name_1: "453" },
      1: { agency_id: "ÖBB", trip_short_name_0: "NJ 466" },
    },
    {
      "ES 474": { agency_id: "ES", trip_short_name: "ES 474" },
      "PKP X": { agency_id: "PKP", trip_short_name: "IC 430" },
    },
  );
  assert.deepStrictEqual([...numbers].sort(), ["452", "453", "474"]);
});

check("station resolver: overrides beat BoT stops; unknown → null", () => {
  const resolve = makeStationResolver({
    botStops: {
      "Praha hl.n.": { stop_name: "Praha hl.n.", stop_lat: 50.083, stop_lon: 14.435 },
      Broken: { stop_name: "Broken", stop_lat: null, stop_lon: 1 },
    },
    overrides: { "praha HL.N.": { lat: 50.0, lon: 14.4 } },
  });
  assert.deepStrictEqual(resolve("Praha hl.n."), { lat: 50.0, lon: 14.4 });
  assert.strictEqual(resolve("Broken"), null);
  assert.strictEqual(resolve("Nowhere"), null);
});

check("normalize: standard trains shape, bare keys, wall-clock times", () => {
  const resolve = makeStationResolver({
    botStops: {
      "Bruxelles Midi / Brussel Zuid": {
        stop_name: "Bruxelles Midi / Brussel Zuid",
        stop_lat: 50.835,
        stop_lon: 4.336,
      },
    },
  });
  const trains = normalizeEsTrains(
    [
      {
        train: "ES 453",
        calendar: "2026: Mon, Wed, Fri",
        stops: [
          { name: "Bruxelles Midi / Brussel Zuid", arrival: null, departure: "19:04" },
          { name: "Antwerpen-Centraal", arrival: "19:35", departure: "19:40" },
          { name: "Praha hl.n.", arrival: "10:56", departure: null },
        ],
      },
      { train: "no-number", stops: [{ name: "A" }, { name: "B" }] },
      { train: "455", stops: [{ name: "only-one" }] },
    ],
    { resolveStation: resolve, today: "2026-06-12" },
  );

  assert.deepStrictEqual(Object.keys(trains), ["453"]);
  const t = trains["453"];
  assert.strictEqual(t.lineName, "453");
  assert.strictEqual(t.operator, "European Sleeper");
  assert.strictEqual(t.polyline, null);
  assert.strictEqual(t.frequency, "2026: Mon, Wed, Fri");
  assert.strictEqual(t.stations.length, 3);
  assert.deepStrictEqual(t.stations[0].location, { latitude: 50.835, longitude: 4.336 });
  assert.strictEqual(t.stations[0].departure, "2026-06-12T19:04:00");
  assert.strictEqual(t.stations[0].arrival, null);
  assert.strictEqual(t.stations[1].location, null); // unknown station — coords resolved later or never
  assert.strictEqual(t.stations[2].arrival, "2026-06-12T10:56:00");
});

check("normalize: calendar objects render to BoT-style strings", () => {
  const trains = normalizeEsTrains(
    [
      {
        train: "452",
        calendar: {
          daysOfWeek: ["mon", "wed", "fri"],
          validFrom: "2026-01-01",
          validUntil: "2026-12-31",
        },
        stops: [
          { name: "A", departure: "18:04" },
          { name: "B", arrival: "09:27" },
        ],
      },
    ],
    { resolveStation: () => null, today: "2026-06-12" },
  );
  assert.strictEqual(trains["452"].frequency, "2026: Mon, Wed, Fri");
});

console.log(`\n[verify-es] ${passed} checks passed`);
