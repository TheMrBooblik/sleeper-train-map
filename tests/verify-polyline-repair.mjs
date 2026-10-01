// tests/verify-polyline-repair.mjs
// An operator polyline must pass through the operator's own stops.
//
// The NightJet API handed NJ 11446 (Wien → Bregenz, diverted via Salzburg Süd
// and the Giselabahn) NJ 446's polyline byte for byte, so the map drew its line
// through Rosenheim while the stop list put a dot at Schwarzach-St. Veit, 55 km
// away. repairPolylinesThroughStops rebuilds such a train stop to stop from its
// own geometry and the other trains' (scripts/lib/polyline-repair.mjs).
//
// Pins the rule on fixtures, then on the committed scrape and the published
// payload, so a polyline that drifts off its stops fails here rather than on
// the map. Raw node, no network. Run: npm run verify-polyline-repair
import assert from "node:assert";
import fs from "node:fs";
import polyline from "@mapbox/polyline";
import {
  pathThroughStops,
  repairPolylinesThroughStops,
  STOP_TOLERANCE_KM,
} from "../scripts/lib/polyline-repair.mjs";
import {
  coordPathFromStations,
  haversineKm,
  maxStationDeviationKm,
} from "../scripts/lib/sibling-path.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// A straight line sampled every ~1 km, so a slice has real vertices in it.
function line(from, to, steps = 60) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return out;
}
const station = (name, [lat, lon]) => ({ name, location: { latitude: lat, longitude: lon } });

// Two corridors from W to E: a northern one through N, a southern one through S.
const W = [48.0, 13.0];
const N = [48.6, 13.5];
const S = [47.4, 13.5];
const E = [48.0, 14.0];
const northern = [...line(W, N), ...line(N, E).slice(1)];
const southern = [...line(W, S), ...line(S, E).slice(1)];

console.log("fixtures");

check("a train whose polyline already passes its stops is left untouched", () => {
  const trains = {
    A: { polyline: polyline.encode(northern), stations: [station("W", W), station("N", N), station("E", E)] },
  };
  const { trains: out, repaired } = repairPolylinesThroughStops(trains);
  assert.strictEqual(repaired.length, 0);
  assert.strictEqual(out.A.polyline, trains.A.polyline);
});

check("a diverted train carrying the regular polyline is rebuilt along its own stops", () => {
  // The NJ 11446 shape: stops via S, polyline via N. Another train runs via S.
  const trains = {
    diverted: { polyline: polyline.encode(northern), stations: [station("W", W), station("S", S), station("E", E)] },
    regular: { polyline: polyline.encode(northern), stations: [station("W", W), station("N", N), station("E", E)] },
    southern: { polyline: polyline.encode(southern), stations: [station("W", W), station("S", S), station("E", E)] },
  };
  // The fault as committed: S is ~75 km from the line it was given.
  assert.ok(maxStationDeviationKm([S], northern) > 50);
  const { trains: out, repaired } = repairPolylinesThroughStops(trains);
  assert.deepStrictEqual(repaired.map((r) => r.key), ["diverted"]);
  assert.deepStrictEqual(repaired[0].missed, ["S"]);
  assert.strictEqual(repaired[0].straight, 0, "both legs come from the southern train's geometry");
  const path = polyline.decode(out.diverted.polyline);
  assert.ok(maxStationDeviationKm([W, S, E], path) <= 0.01, "every stop is now a vertex");
  assert.ok(maxStationDeviationKm([N], path) > 50, "and the line no longer runs the northern corridor");
  assert.strictEqual(out.regular.polyline, trains.regular.polyline, "healthy trains are untouched");
});

check("a broken polyline is never used as a donor", () => {
  // Two trains with the same wrong geometry must not 'fix' each other.
  const trains = {
    one: { polyline: polyline.encode(northern), stations: [station("W", W), station("S", S), station("E", E)] },
    two: { polyline: polyline.encode(northern), stations: [station("W", W), station("S", S), station("E", E)] },
  };
  const { repaired } = repairPolylinesThroughStops(trains);
  assert.strictEqual(repaired.length, 2);
  for (const r of repaired) assert.strictEqual(r.straight, 2, `${r.key} falls back to straight hops`);
});

check("the shortest donor slice wins over one that wanders between the stops", () => {
  // Both donors pass W and S; one goes the long way round via N first.
  const detour = [...line(W, N), ...line(N, S).slice(1)];
  const direct = line(W, S);
  const { path, borrowed } = pathThroughStops([W, S], [], [detour, direct]);
  assert.strictEqual(borrowed, 1);
  assert.ok(maxStationDeviationKm([N], path) > 50, "the slice through N is not taken");
});

check("adjacent stops with no vertex between them are a short hop, not a gap", () => {
  const a = [48.0, 13.0];
  const b = [48.005, 13.005];
  const { straight } = pathThroughStops([a, b], [], []);
  assert.strictEqual(straight, 0);
});

console.log("committed data");

const nj = JSON.parse(fs.readFileSync("public/data/scraped/nightjet-trains.json", "utf8")).data.trains;

check("every NightJet/EuroNight polyline passes all of its own stops", () => {
  const off = [];
  for (const [key, train] of Object.entries(nj)) {
    const stops = coordPathFromStations(train.stations);
    const km = maxStationDeviationKm(stops, polyline.decode(train.polyline));
    if (km > STOP_TOLERANCE_KM) off.push(`${key} (${km.toFixed(1)} km)`);
  }
  assert.deepStrictEqual(off, [], `off their own stops: ${off.join(", ")}`);
});

check("the repair is a no-op on the committed scrape (it already ran)", () => {
  assert.deepStrictEqual(repairPolylinesThroughStops(nj).repaired, []);
});

check("NJ 11446 runs the Giselabahn it stops on, not the Rosenheim corridor", () => {
  const path = polyline.decode(nj["NJ 11446"].polyline);
  const nearest = (p) => Math.min(...path.map((q) => haversineKm(q, p)));
  assert.ok(nearest([47.3209, 13.1528]) < 1, "Schwarzach-St. Veit is on the line");
  assert.ok(nearest([47.3195, 12.7973]) < 1, "Zell am See is on the line");
  assert.ok(nearest([47.8505, 12.1195]) > 20, "Rosenheim is not");
});

check("the published row draws the repaired polyline", () => {
  const vm = JSON.parse(fs.readFileSync("public/data/published/initial-data.json", "utf8")).data.viewMap;
  const row = vm.nj_standalone_NJ_11446;
  assert.ok(row, "nj_standalone_NJ_11446 is published");
  assert.strictEqual(row.trip_short_name_0, "NJ 11446");
  assert.strictEqual(row.nj_polyline_0, nj["NJ 11446"].polyline);
});

console.log(`\nverify-polyline-repair: ${passed} checks passed`);
