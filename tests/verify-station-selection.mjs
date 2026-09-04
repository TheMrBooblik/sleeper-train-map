#!/usr/bin/env node
/**
 * Validates that selecting a station gathers the routes of *that* station, not
 * of every station in the world that happens to share its name. Run:
 *   node tests/verify-station-selection.mjs
 *
 * handleMarkerClick (DynamicMap) aggregates route ids from every cities[] entry
 * whose display name equals, or fuzzy-matches, the clicked station. Both tests
 * are name-only, and both produce cross-continent false positives: clicking
 * Glasgow Central in Scotland pulled in the Amtrak Empire Builder through
 * "Glasgow Amtrak Station" in Montana, and every stop of that route then passed
 * the marker filter and drew a dot. This pins the proximity guard that stops it.
 *
 * The aggregation itself lives inside a React callback, so what runs here is the
 * same predicate composition against the committed payload: name match AND
 * stationsAreNearby.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStationNameForLookup as normalize } from "../src/lib/stationKey.mjs";
import {
  normalizeStationNameForDisplay as display,
  matchStationNames,
  stationsAreNearby,
  SAME_CITY_RADIUS_KM,
} from "../src/components/Map/utils/stationNameUtils.js";
import { distanceKm } from "../src/components/Map/utils/returnGeometryBranches.js";
import { projectStopsToRoutes } from "../src/pages/api/lib/payload-projection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let failures = 0;
const fail = (msg) => {
  console.error("FAIL:", msg);
  failures += 1;
};
const ok = (msg) => console.log("  ✓", msg);

const payload = projectStopsToRoutes(
  JSON.parse(
    fs.readFileSync(
      path.join(root, "public", "data", "published", "initial-data.json"),
      "utf8",
    ),
  ).data,
);

// cities index, as useInitialData derives it
const cities = {};
for (const route of Object.values(payload.viewMap)) {
  if (!route?.route_id) continue;
  const id = String(route.route_id);
  const add = (name) => {
    const key = normalize(name);
    if (!key) return;
    cities[key] = cities[key] || { ids: new Set() };
    cities[key].ids.add(id);
  };
  for (const f of ["origin_trip_0", "destination_trip_0", "origin_trip_1", "destination_trip_1"]) {
    if (route[f]) add(route[f]);
  }
  for (const f of ["via_0", "via_1"]) {
    if (route[f]) String(route[f]).split(" - ").map((s) => s.trim()).filter(Boolean).forEach(add);
  }
}

const coords = new Map();
for (const stop of payload.stops) {
  if (!stop?.stop_id) continue;
  if (!Number.isFinite(stop.stop_lat) || !Number.isFinite(stop.stop_lon)) continue;
  const key = normalize(stop.stop_id);
  if (key && !coords.has(key)) coords.set(key, [stop.stop_lat, stop.stop_lon]);
}

/** The route ids a click on `station` gathers, with and without the guard. */
function routesForClick(station, { guarded }) {
  const here = coords.get(normalize(station));
  const filterName = display(station);
  const ids = new Set(cities[normalize(station)]?.ids ?? []);
  for (const [key, city] of Object.entries(cities)) {
    const nameHit =
      display(key) === filterName || matchStationNames(station, key, normalize);
    if (!nameHit) continue;
    if (guarded) {
      const there = coords.get(key);
      if (there && here && !stationsAreNearby(here[0], here[1], there[0], there[1])) continue;
    }
    for (const id of city.ids) ids.add(id);
  }
  return ids;
}

const routeLabel = (id) => {
  const r = Object.values(payload.viewMap).find((x) => String(x.route_id) === id);
  return r ? `${r.origin_trip_0} → ${r.destination_trip_0}` : id;
};

// ─── 1. The reported false positives are gone ───────────────────────────────
console.log("1) cross-continent name collisions");

// [clicked station, a route it must NOT gather, why]
const collisions = [
  ["Glasgow Central", "amtrak_Empire_Builder", "Glasgow, Montana is not Glasgow, Scotland"],
  ["Birmingham International", "amtrak_Crescent", "Birmingham, Alabama is not Birmingham, UK"],
  ["Bar", "via_Vancouver_-_Toronto", "Boston Bar, British Columbia is not Bar, Montenegro"],
];

for (const [station, forbiddenRoute, why] of collisions) {
  if (!coords.has(normalize(station))) {
    fail(`test fixture stale: "${station}" is no longer in the payload`);
    continue;
  }
  const before = routesForClick(station, { guarded: false });
  const after = routesForClick(station, { guarded: true });

  if (!before.has(forbiddenRoute)) {
    fail(`fixture stale: unguarded click on "${station}" no longer reaches ${forbiddenRoute}`);
  } else if (after.has(forbiddenRoute)) {
    fail(`"${station}" still gathers ${forbiddenRoute} (${routeLabel(forbiddenRoute)}) — ${why}`);
  } else {
    ok(`"${station}" no longer gathers ${routeLabel(forbiddenRoute)}`);
  }
}

// ─── 2. Same-city variants still resolve ────────────────────────────────────
console.log("2) genuine same-city variants still match");

// These are what the fuzzy matcher exists for: one city, differently spelled or
// suffixed stations, which must keep sharing their routes.
const sameCity = [
  ["Dąbrowa Górnicza", "Dąbrowa Górnicza Ząbkowice"],
  ["Częstochowa", "Częstochowa Stradom"],
  ["Lublin", "Lublin Zachodni"],
  ["Lviv", "Lviv Pidzamche"],
  ["Split", "Split Predgrađe"],
  ["Suceava", "Suceava Nord"],
];

for (const [a, b] of sameCity) {
  const ca = coords.get(normalize(a));
  const cb = coords.get(normalize(b));
  if (!ca || !cb) {
    fail(`fixture stale: "${a}" / "${b}" missing from the payload`);
    continue;
  }
  const km = distanceKm(ca[0], ca[1], cb[0], cb[1]);
  if (!stationsAreNearby(ca[0], ca[1], cb[0], cb[1])) {
    fail(`"${a}" and "${b}" are ${Math.round(km)} km apart — the guard would split one city`);
    continue;
  }
  const routesOfB = cities[normalize(b)]?.ids ?? new Set();
  const gathered = routesForClick(a, { guarded: true });
  const missing = [...routesOfB].filter((id) => !gathered.has(id));
  if (missing.length > 0) {
    fail(`clicking "${a}" lost ${b}'s routes: ${missing.join(", ")}`);
  } else {
    ok(`"${a}" ↔ "${b}" (${Math.round(km)} km) still share routes`);
  }
}

// ─── 3. The threshold sits in a real gap ────────────────────────────────────
console.log("3) the radius is not a guess");

let widestKept = 0;
let narrowestCut = Infinity;
for (const clicked of Object.keys(cities)) {
  const here = coords.get(clicked);
  if (!here) continue;
  const filterName = display(clicked);
  const own = cities[clicked].ids;
  for (const [key, city] of Object.entries(cities)) {
    if (key === clicked) continue;
    const nameHit =
      display(key) === filterName || matchStationNames(clicked, key, normalize);
    if (!nameHit) continue;
    if ([...city.ids].every((id) => own.has(id))) continue; // adds nothing either way
    const there = coords.get(key);
    if (!there) continue;
    const km = distanceKm(here[0], here[1], there[0], there[1]);
    if (km <= SAME_CITY_RADIUS_KM) widestKept = Math.max(widestKept, km);
    else narrowestCut = Math.min(narrowestCut, km);
  }
}
console.log(`  widest pair kept: ${Math.round(widestKept)} km`);
console.log(`  nearest pair cut: ${Math.round(narrowestCut)} km`);
if (!(widestKept < SAME_CITY_RADIUS_KM && narrowestCut > SAME_CITY_RADIUS_KM)) {
  fail(
    `${SAME_CITY_RADIUS_KM} km no longer separates the two populations ` +
      `(kept up to ${Math.round(widestKept)} km, cut from ${Math.round(narrowestCut)} km)`,
  );
} else {
  ok(`${SAME_CITY_RADIUS_KM} km sits in the gap, with margin on both sides`);
}

// ─── 4. The guard is permissive where it cannot know ────────────────────────
console.log("4) missing coordinates never drop a match");

if (!stationsAreNearby(NaN, NaN, 50, 10)) fail("a station with no coordinates must not be rejected");
if (!stationsAreNearby(50, 10, undefined, undefined)) fail("an unlocatable candidate must not be rejected");
if (stationsAreNearby(51.5, -0.1, 40.7, -74.0)) fail("London and New York must not be nearby");
if (!stationsAreNearby(52.52, 13.4, 52.53, 13.2)) fail("two Berlin stations must be nearby");
ok("rejects only what it can prove far apart");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll station selection checks passed.");
