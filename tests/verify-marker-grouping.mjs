// tests/verify-marker-grouping.mjs
// Unit tests for groupCityMarkers (src/components/Map/utils/), which collapses a
// city's stations into one map dot.
//
// The bucket key is normalizeStationNameForDisplay, a SUBSTRING matcher, and the
// grouped marker sits at the AVERAGE of its members' coordinates. So one station
// that merely shares a city's name — "Florence Amtrak Station" in South Carolina
// against Firenze — dragged the Florence dot to [40.6, -19.1], the middle of the
// Atlantic, and neither city had a marker where it belongs.
//
// Raw node, no network. Run: npm run verify-marker-grouping
import assert from "node:assert";
import { groupCityMarkers } from "../src/components/Map/utils/groupCityMarkers.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const stop = (id, lat, lon, extra = {}) => ({
  stop_id: id,
  stop_lat: lat,
  stop_lon: lon,
  ...extra,
});

// Stand-ins for the two normalizers the map passes in: display collapses to the
// city, lookup is the identity (the fixtures are already canonical).
const display = (name) => {
  if (String(name).includes("Florence") || String(name).startsWith("Firenze")) return "Florence";
  if (String(name).startsWith("Berlin")) return "Berlin";
  return name;
};
const lookup = (name) => name;
const citiesFor = (ids, over = {}) =>
  Object.fromEntries(ids.map((id) => [id, { stop_id: id, stop_route_ids: "1", ...(over[id] ?? {}) }]));

const FIRENZE_CASTELLO = stop("Firenze Castello", 43.8145, 11.2225);
const FIRENZE_CAMPO_MARTE = stop("Firenze Campo Marte", 43.7813, 11.2745);
const FLORENCE_SC = stop("Florence Amtrak Station", 34.1987, -79.7573);

check("a city on two continents becomes two markers, each in its place", () => {
  const stops = [FIRENZE_CASTELLO, FIRENZE_CAMPO_MARTE, FLORENCE_SC];
  const out = groupCityMarkers(
    stops,
    citiesFor(stops.map((s) => s.stop_id)),
    true,
    display,
    lookup,
  );
  assert.strictEqual(out.length, 2, `expected 2 markers, got ${out.length}`);
  const italy = out.find((m) => m.stop_lon > 0);
  const carolina = out.find((m) => m.stop_lon < 0);
  assert.ok(italy && carolina, "one marker per continent");
  // Both keep the display name — it is the position that has to be honest.
  assert.strictEqual(italy.displayName, "Florence");
  assert.strictEqual(carolina.displayName, "Florence");
  assert.ok(Math.abs(italy.stop_lat - 43.798) < 0.05 && Math.abs(italy.stop_lon - 11.248) < 0.05);
  assert.ok(Math.abs(carolina.stop_lat - 34.199) < 0.01 && Math.abs(carolina.stop_lon + 79.757) < 0.01);
  // The bug this guards: the average of all three lands in the ocean.
  assert.ok(!out.some((m) => m.stop_lon < 0 && m.stop_lon > -30), "no marker in the Atlantic");
});

check("a sprawling real city still collapses to one marker", () => {
  // Spandau to Ostbahnhof is ~20 km; splitting Berlin would be a regression.
  const stops = [
    stop("Berlin Hbf", 52.525, 13.3695),
    stop("Berlin Gesundbrunnen", 52.5487, 13.3886),
    stop("Berlin-Spandau", 52.5345, 13.1976),
    stop("Berlin Ostbahnhof", 52.5103, 13.4348),
  ];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].groupSize, 4);
  assert.ok(out[0].isGrouped);
});

check("a lone far-off station is a marker, not a dropped station", () => {
  const stops = [FIRENZE_CASTELLO, FLORENCE_SC];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((m) => m.isGrouped === false), "single-member clusters are not grouped");
  assert.deepStrictEqual(
    out.map((m) => m.stop_id).sort(),
    ["Firenze Castello", "Florence Amtrak Station"],
  );
});

check("clusters chain through intermediate stations", () => {
  // Three stations 50 km apart in a line: single-link keeps them together even
  // though the ends are 100 km apart, which is what a real corridor city needs.
  const stops = [
    stop("Berlin A", 52.0, 13.0),
    stop("Berlin B", 52.45, 13.0),
    stop("Berlin C", 52.9, 13.0),
  ];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].groupSize, 3);
});

check("the grouped marker still prefers a main station's own coordinates", () => {
  const stops = [
    stop("Berlin Hbf", 52.525, 13.3695, { coordinatesSource: "custom" }),
    stop("Berlin Ostbahnhof", 52.5103, 13.4348),
  ];
  const cities = citiesFor(stops.map((s) => s.stop_id), {
    "Berlin Hbf": { isViaStation: false },
    "Berlin Ostbahnhof": { isViaStation: true },
  });
  const out = groupCityMarkers(stops, cities, true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].stop_lat, 52.525);
  assert.strictEqual(out[0].stop_lon, 13.3695);
});

check("ungrouped mode is untouched by clustering", () => {
  const stops = [FIRENZE_CASTELLO, FLORENCE_SC];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), false, display, lookup);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((m) => m.isGrouped === false));
  assert.strictEqual(out[0].displayName, "Firenze Castello");
});

check("degenerate input yields nothing rather than throwing", () => {
  assert.deepStrictEqual(groupCityMarkers([], {}, true, display, lookup), []);
  assert.deepStrictEqual(groupCityMarkers(null, {}, true, display, lookup), []);
  // Stations with no route metadata never become markers.
  assert.deepStrictEqual(groupCityMarkers([FLORENCE_SC], {}, true, display, lookup), []);
});

console.log(`\n[verify-marker-grouping] ${passed} checks passed`);
