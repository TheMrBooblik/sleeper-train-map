// tests/verify-basemap.mjs
//
// The offline basemap replaces a tile server, so nothing external will ever tell
// us it is wrong — a broken ring is a country that silently fails to draw, and a
// coordinate swap is a world map that looks plausible until you notice Europe is
// in the Indian Ocean. Nothing else in the repo reads this file.
//
// Checks the committed artifact rather than rebuilding it: the build fetches
// ~5 MB from GitHub, and the point of committing the output is that it does not
// need regenerating.
//
// Raw node, no network. Run: npm run verify-basemap
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "mobile/assets/basemap.json");
const MAX_RAW_BYTES = 900 * 1024;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

assert.ok(
  fs.existsSync(FILE),
  "mobile/assets/basemap.json is missing — run `npm run build-basemap`",
);
const raw = fs.readFileSync(FILE, "utf8");
const map = JSON.parse(raw);

const decode = (encoded) => polyline.decode(encoded, map.precision);
const allPolygons = [...map.lo.countries, ...map.hi.countries, ...map.hi.lakes];

check("declares its schema, precision and attribution", () => {
  assert.strictEqual(map.v, 1);
  assert.strictEqual(map.precision, 4);
  assert.ok(
    /natural earth/i.test(map.attribution),
    "attribution names the source",
  );
  assert.ok(Date.parse(map.generatedAt) > 0);
});

check("fits the asset budget", () => {
  assert.ok(
    raw.length <= MAX_RAW_BYTES,
    `${(raw.length / 1024).toFixed(0)} KB exceeds ${MAX_RAW_BYTES / 1024} KB`,
  );
});

check("carries both levels of detail, coarse below fine", () => {
  const points = (polygons) =>
    polygons.reduce(
      (a, rings) => a + rings.reduce((b, r) => b + decode(r).length, 0),
      0,
    );
  const lo = points(map.lo.countries);
  const hi = points(map.hi.countries);
  assert.ok(lo > 1000, `the coarse level has only ${lo} points`);
  assert.ok(
    hi > lo * 2,
    `the fine level (${hi} points) is not meaningfully finer than the coarse one (${lo})`,
  );
});

check("every ring is a closed polygon, not a stray line", () => {
  // A polygon fill needs at least a triangle plus the repeated closing vertex.
  // Douglas-Peucker keeps endpoints, so a ring that came in closed stays closed;
  // if that ever stops holding, Flutter draws an open shape with a seam.
  let rings = 0;
  for (const polygon of allPolygons) {
    assert.ok(polygon.length > 0, "a polygon with no rings");
    for (const encoded of polygon) {
      const pts = decode(encoded);
      assert.ok(pts.length >= 4, `a ring decoded to ${pts.length} points`);
      const first = pts[0];
      const last = pts[pts.length - 1];
      assert.ok(
        Math.abs(first[0] - last[0]) < 1e-3 &&
          Math.abs(first[1] - last[1]) < 1e-3,
        `a ring is not closed: ${JSON.stringify(first)} vs ${JSON.stringify(last)}`,
      );
      rings += 1;
    }
  }
  assert.ok(rings > 1500, `only ${rings} rings in total`);
});

check("coordinates are finite and in range", () => {
  for (const polygon of allPolygons) {
    for (const encoded of polygon) {
      for (const [lat, lng] of decode(encoded)) {
        assert.ok(
          Number.isFinite(lat) && lat >= -90 && lat <= 90,
          `latitude ${lat} out of range`,
        );
        assert.ok(
          Number.isFinite(lng) && lng >= -180 && lng <= 180,
          `longitude ${lng} out of range`,
        );
      }
    }
  }
});

check("the world is the right way up and Antarctica is gone", () => {
  // Catches the [lng, lat] → [lat, lng] swap, which produces a map that decodes
  // cleanly and is completely wrong.
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const polygon of map.hi.countries) {
    for (const encoded of polygon) {
      for (const [lat, lng] of decode(encoded)) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
  }
  assert.ok(
    maxLat > 70,
    `northernmost land is only ${maxLat.toFixed(1)}° — is lat/lng swapped?`,
  );
  assert.ok(
    minLat > -62,
    `land reaches ${minLat.toFixed(1)}° — Antarctica was not dropped`,
  );
  assert.ok(
    maxLng > 170 && minLng < -170,
    "the map does not span the full longitude range",
  );
});

check("city labels cover the network's continents", () => {
  // Natural Earth's own spelling has quirks ("Washington,  D.C." carries a
  // double space), so match on collapsed whitespace rather than the raw string.
  const key = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = new Map(map.places.map((p) => [key(p.n), p]));
  // One from each region the route data actually reaches.
  for (const city of [
    "berlin",
    "paris",
    "vienna",
    "warsaw",
    "beijing",
    "washington, d.c.",
    "tbilisi",
  ]) {
    assert.ok(byName.has(city), `no label for ${city}`);
  }
  const berlin = byName.get("berlin");
  assert.ok(
    Math.abs(berlin.y - 52.52) < 0.5 && Math.abs(berlin.x - 13.4) < 0.5,
    `Berlin is at ${berlin.y},${berlin.x} — expected ~52.5,13.4`,
  );
});

check("labels are ranked capitals first", () => {
  assert.ok(map.places.length > 300, `only ${map.places.length} labels`);
  for (const p of map.places) {
    assert.ok(p.n, "a label with no name");
    assert.ok([0, 1, 2].includes(p.r), `label ${p.n} has rank ${p.r}`);
    assert.ok(
      Number.isFinite(p.y) && Number.isFinite(p.x),
      `label ${p.n} coordinates`,
    );
  }
  const ranks = map.places.map((p) => p.r);
  assert.deepStrictEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
    "labels are not sorted by rank — the app slices the head of this list by zoom",
  );
});

const gzip = zlib.gzipSync(Buffer.from(raw), { level: 9 }).length;
console.log(
  `[verify-basemap] ${passed} checks passed ` +
    `(${(raw.length / 1024).toFixed(0)} KB raw / ${(gzip / 1024).toFixed(0)} KB gzip, ` +
    `${allPolygons.length} polygons, ${map.places.length} labels)`,
);
