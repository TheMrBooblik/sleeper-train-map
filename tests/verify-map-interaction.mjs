/**
 * The map's per-interaction budget: what runs on every zoom and pan.
 *
 * Over Poland a zoom step blocked the main thread for ~2 s on a phone-class
 * CPU (4× throttled Chromium, measured on a production build), from three
 * things that each scaled with the whole world rather than with the screen:
 *
 *   1. Every per-route trips question scanned the whole trips table
 *      (`Object.values(trips).filter`), and the marker hook asks one per route
 *      per station per zoom.
 *   2. Every station marker in the world stayed a live DOM element — ~2 100 at
 *      zoom 8 to show ~80 — and Leaflet moves and restyles all of them on zoom.
 *   3. Every vertex of every route line (~370 000, twice) was re-projected on
 *      every zoom, on screen or not.
 *
 * Their fixes are pure functions, asserted here in raw node; the wiring into
 * the hooks is asserted against the source, since those files import
 * extensionless specifiers and cannot load outside the Next build (the same
 * reason verify-via-schedule asserts the panel's chain order).
 *
 * Run with: node tests/verify-map-interaction.mjs
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tripsForRoute,
  isRouteOutsideServiceIdSeason,
  getRouteStyleFromFrequency,
  getFutureRouteStartDate,
  hasUnknownStart,
} from "../src/components/Map/utils/routeStyleUtils.js";
import {
  nextCullRegion,
  isInsideCullRegion,
  padBounds,
} from "../src/components/Map/utils/markerCulling.js";
import {
  decimateForZoom,
  runsNearWindow,
} from "../src/components/Map/utils/zoomDecimation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const payload = JSON.parse(read("public/data/published/initial-data.json")).data;
const { trips, viewMap } = payload;

console.log("trips index");

test("tripsForRoute answers exactly what the old full-table filter did, for every route", () => {
  const ids = new Set([
    ...Object.keys(viewMap),
    ...Object.values(trips).map((t) => String(t.route_id)),
  ]);
  for (const id of ids) {
    const scan = Object.values(trips).filter(
      (trip) => trip.route_id?.toString() === id.toString(),
    );
    assert.deepStrictEqual(tripsForRoute(trips, id), scan, `route ${id}`);
    // Numeric ids are looked up as strings, as the old toString() compare did.
    if (/^\d+$/.test(id)) {
      assert.deepStrictEqual(tripsForRoute(trips, Number(id)), scan);
    }
  }
});

test("the index is built once per trips table and follows a new table", () => {
  const first = tripsForRoute(trips, Object.keys(viewMap)[0]);
  assert.strictEqual(tripsForRoute(trips, Object.keys(viewMap)[0]), first);
  const replaced = { x: { route_id: "zz" } };
  assert.deepStrictEqual(tripsForRoute(replaced, "zz"), [replaced.x]);
  assert.deepStrictEqual(tripsForRoute(null, "zz"), []);
  assert.deepStrictEqual(tripsForRoute(trips, null), []);
});

test("the route predicates built on it still answer for the whole payload", () => {
  // A smoke check that the four callers still run end to end and agree with
  // the old scan's answer on a table without the index (a fresh copy).
  const copy = { ...trips };
  for (const [id, row] of Object.entries(viewMap)) {
    assert.strictEqual(
      isRouteOutsideServiceIdSeason(id, trips, row),
      isRouteOutsideServiceIdSeason(id, copy, row),
    );
    assert.deepStrictEqual(
      getRouteStyleFromFrequency(id, trips, row),
      getRouteStyleFromFrequency(id, copy, row),
    );
    assert.strictEqual(
      getFutureRouteStartDate(id, trips, row),
      getFutureRouteStartDate(id, copy, row),
    );
    assert.strictEqual(hasUnknownStart(id, trips), hasUnknownStart(id, copy));
  }
});

console.log("marker culling");

const view = { north: 54, south: 50, east: 24, west: 15 };

test("the region is the view padded by one screen on each side", () => {
  assert.deepStrictEqual(padBounds(view), {
    north: 58,
    south: 46,
    east: 33,
    west: 6,
  });
});

test("a pan inside the region keeps the same object, so nothing re-renders", () => {
  const region = nextCullRegion(null, view, 7);
  const nudged = { north: 55, south: 51, east: 26, west: 17 };
  assert.strictEqual(nextCullRegion(region, nudged, 7), region);
});

test("leaving the region, or zooming, makes a new one", () => {
  const region = nextCullRegion(null, view, 7);
  const far = { north: 54, south: 50, east: 40, west: 31 };
  assert.notStrictEqual(nextCullRegion(region, far, 7), region);
  assert.notStrictEqual(nextCullRegion(region, view, 8), region);
});

test("no bounds yet means no culling", () => {
  assert.strictEqual(nextCullRegion(null, null, 7), null);
  assert.strictEqual(isInsideCullRegion(null, 0, 0), true);
});

test("a marker is kept only inside the region, and one without a position is left to the caller", () => {
  const region = nextCullRegion(null, view, 7);
  assert.strictEqual(isInsideCullRegion(region, 52.23, 21.01), true); // Warszawa
  assert.strictEqual(isInsideCullRegion(region, 39.9, 116.4), false); // Beijing
  assert.strictEqual(isInsideCullRegion(region, "52.23", "21.01"), true);
  assert.strictEqual(isInsideCullRegion(region, undefined, 21), true);
});

console.log("line decimation");

// Distance from p to segment a–b in local-Mercator pixels at `zoom`.
function pxDistToSegment(p, a, b, zoom) {
  const k = (256 * 2 ** zoom) / 360;
  const sy = 1 / Math.cos((a[0] * Math.PI) / 180);
  const P = [p[1] * k, p[0] * k * sy];
  const A = [a[1] * k, a[0] * k * sy];
  const B = [b[1] * k, b[0] * k * sy];
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2)) : 0;
  return Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
}

// A wiggly track across Poland, a vertex every ~30 m.
const track = [];
for (let i = 0; i <= 20000; i++) {
  const lon = 15 + (i / 20000) * 9;
  track.push([52 + 0.3 * Math.sin(i / 400) + 0.002 * Math.sin(i / 7), lon]);
}

test("zoomed out, most vertices go; zoomed in far enough, every one stays", () => {
  const z6 = decimateForZoom(track, 6);
  assert.ok(z6.length < track.length * 0.1, `${z6.length} kept at z6`);
  assert.strictEqual(decimateForZoom(track, 19), track);
});

test("the ends are always kept, and no dropped vertex strays half a pixel from the line drawn", () => {
  for (const zoom of [4, 6, 8, 10]) {
    const kept = decimateForZoom(track, zoom);
    assert.strictEqual(kept[0], track[0]);
    assert.strictEqual(kept.at(-1), track.at(-1));
    let j = 0;
    let worst = 0;
    for (const p of track) {
      while (j < kept.length - 2 && kept[j + 1] !== p && track.indexOf(kept[j + 1]) < track.indexOf(p)) j++;
      worst = Math.max(worst, pxDistToSegment(p, kept[j], kept[j + 1], zoom));
    }
    assert.ok(worst <= 0.5 + 1e-9, `zoom ${zoom}: ${worst.toFixed(3)} px`);
  }
});

test("it reads Leaflet LatLng objects as well as [lat, lng] arrays", () => {
  const objects = track.map(([lat, lng]) => ({ lat, lng }));
  const a = decimateForZoom(track, 7).map((p) => track.indexOf(p));
  const b = decimateForZoom(objects, 7).map((p) => objects.indexOf(p));
  assert.deepStrictEqual(a, b);
});

console.log("projection window");

test("a line wholly inside the window is returned as itself", () => {
  const runs = runsNearWindow(track, { south: 40, north: 60, west: 0, east: 30 });
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0], track);
});

test("a long straight hop crossing the window with both ends outside it is kept", () => {
  // Station chains: Amsterdam → Warszawa → Kyiv with nothing between.
  const chain = [[52.37, 4.9], [52.23, 21.01], [50.45, 30.52]];
  const window = { south: 51, north: 53, west: 10, east: 12 };
  assert.deepStrictEqual(runsNearWindow(chain, window), [[chain[0], chain[1]]]);
});

test("stretches far from the window are dropped, and each kept run starts one vertex outside it", () => {
  const window = { south: 51.5, north: 52.5, west: 18, east: 19 };
  const runs = runsNearWindow(track, window);
  assert.ok(runs.length >= 1);
  const kept = runs.reduce((n, r) => n + r.length, 0);
  assert.ok(kept < track.length * 0.2, `${kept} of ${track.length}`);
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const [a, b] = [run[i - 1], run[i]];
      assert.ok(
        Math.max(a[1], b[1]) >= window.west && Math.min(a[1], b[1]) <= window.east,
      );
    }
  }
  assert.deepStrictEqual(runsNearWindow([[0, 0]], window), []);
});

console.log("wiring");

test("the marker hook culls markers to the region after grouping", () => {
  const hook = read("src/components/Map/hooks/useMapMarkers.js");
  const grouping = hook.indexOf("groupCityMarkers(");
  const culling = hook.indexOf("isInsideCullRegion(cullRegion");
  assert.ok(grouping > 0 && culling > grouping, "culling must follow grouping");
  assert.match(hook, /\bcullRegion,\n\s+defaultIcon,/, "cullRegion is a memo dependency");
});

test("the map renders route lines through the decimating polyline, and memoises them", () => {
  const map = read("src/components/Map/DynamicMap.js");
  assert.ok(!/<Polyline\b/.test(map), "a plain <Polyline> projects every vertex on every zoom");
  assert.ok(map.includes("<DecimatedPolyline"));
  assert.match(map, /const routeLayers = useMemo\(/);
  assert.match(map, /onViewportSettle=\{handleViewportSettle\}/);
});

test("no per-route trips scan is left in the route style helpers", () => {
  const utils = read("src/components/Map/utils/routeStyleUtils.js");
  assert.ok(!/Object\.values\(trips\)\.filter\(\s*\(/.test(utils));
});

console.log(`\n${passed} checks passed`);
