#!/usr/bin/env node
/**
 * Build the mobile app's offline basemap.
 *
 * The web map draws Back-on-Track's routes over `tile.openstreetmap.org`, which
 * a published app may not do: the OSMF tile policy prohibits apps and any
 * offline prefetch, and blocks by User-Agent. The paid-tier alternatives are
 * either metered or non-commercial-only, and this site carries affiliate booking
 * links. So the app ships its own basemap instead — Natural Earth, public
 * domain, ~400 KB, no key, no quota, and correct in a train with no signal.
 *
 * For a thematic map of sleeper routes that is not a downgrade: what a reader
 * needs is coastline, borders and city labels for orientation, not street
 * geometry at z18.
 *
 * Two levels of detail, because a world map at 1:50m is wasted below zoom 5 and
 * 1:110m is too coarse above it. Both are simplified with the same
 * Douglas-Peucker the route geometry uses, and encoded with the same
 * precision-5-capable polyline codec (at precision 4, ~11 m — far finer than a
 * 1:50m source warrants) so the app needs exactly ONE decoder for everything it
 * draws.
 *
 * Run manually; the output is committed. Natural Earth releases every few years,
 * so there is nothing for the nightly job to do here.
 *
 *   node scripts/build-basemap.mjs
 *
 * Output: mobile/assets/basemap.json.gz (committed)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";

import { simplifyPath, dedupeConsecutive } from "./lib/mobile-geometry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "mobile/assets/basemap.json.gz");

/**
 * The upstream `naturalearthdata.com` CDN is unreachable from CI here, and the
 * canonical redistributable copy of the same data is the project's own vector
 * repo, so that is what is fetched.
 */
const SOURCE_BASE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

const CACHE_DIR = path.join(ROOT, ".basemap-cache");

/** Polyline precision. 4 ≈ 11 m; the 1:50m source is nowhere near that detailed. */
const PRECISION = 4;

/**
 * Simplification per level, in degrees.
 * `lo` is drawn below zoom ~5 where a degree is a few pixels; `hi` above it.
 */
const TOLERANCE = { lo: 0.08, hi: 0.012 };

/** Antarctica is a third of the land area and carries no sleeper trains. */
const MIN_LATITUDE = -60;

/** Budget: the whole app has 30 MB and this is a fixed cost on every install. */
const MAX_RAW_BYTES = 900 * 1024;

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function fetchGeojson(name) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `${name}.geojson`);
  if (fs.existsSync(cached)) {
    return JSON.parse(fs.readFileSync(cached, "utf8"));
  }
  const url = `${SOURCE_BASE}/${name}.geojson`;
  process.stdout.write(`  fetching ${name}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(cached, text);
  console.log(kb(text.length));
  return JSON.parse(text);
}

/** GeoJSON is [lng, lat]; everything downstream of here is [lat, lng]. */
const toLatLng = (ring) =>
  ring
    .filter(
      (p) =>
        Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]),
    )
    .map((p) => [+p[1], +p[0]]);

/** True when no vertex reaches above the Antarctic cutoff. */
const isPolar = (ring) => ring.every(([lat]) => lat < MIN_LATITUDE);

/**
 * One GeoJSON geometry → a list of polygons, each a list of rings, each ring
 * simplified and encoded.
 *
 * A ring is closed, so simplification must not be allowed to collapse it: a
 * triangle is the smallest thing that still encloses area, and anything that
 * simplifies below that is dropped rather than drawn as a line.
 */
function encodePolygons(geometry, tolerance, counters) {
  const polygons = [];
  const raw =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

  for (const polygon of raw) {
    const rings = [];
    for (const ring of polygon) {
      const latLng = toLatLng(ring);
      if (latLng.length < 4 || isPolar(latLng)) continue;
      counters.pointsIn += latLng.length;
      const simplified = simplifyPath(dedupeConsecutive(latLng), tolerance);
      if (simplified.length < 4) continue;
      counters.pointsOut += simplified.length;
      rings.push(polyline.encode(simplified, PRECISION));
    }
    // rings[0] is the outer boundary; the rest are holes (Lesotho, the Caspian).
    if (rings.length > 0) polygons.push(rings);
  }
  return polygons;
}

function collectPolygons(collection, tolerance, counters) {
  const out = [];
  for (const feature of collection?.features || []) {
    out.push(...encodePolygons(feature.geometry, tolerance, counters));
  }
  return out;
}

/**
 * City labels, ranked so the app can thin them by zoom without a second pass.
 * rank 0 = national capital, 1 = 1M+, 2 = 300k+.
 */
function collectPlaces(collection) {
  const places = [];
  for (const feature of collection?.features || []) {
    const p = feature.properties || {};
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lat = +coords[1];
    const lng = +coords[0];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < MIN_LATITUDE) continue;

    const population = Number(p.pop_max ?? p.POP_MAX ?? 0);
    const isCapital = Number(p.adm0cap ?? p.ADM0CAP ?? 0) === 1;
    if (!isCapital && population < 300000) continue;

    places.push({
      n: p.name ?? p.NAME ?? "",
      y: Math.round(lat * 1e4) / 1e4,
      x: Math.round(lng * 1e4) / 1e4,
      r: isCapital ? 0 : population >= 1000000 ? 1 : 2,
    });
  }
  // Capitals first, then by population band, so a zoom-limited slice of the head
  // of this list is always the most important labels.
  places.sort((a, b) => a.r - b.r || a.n.localeCompare(b.n));
  return places.filter((p) => p.n);
}

export async function buildBasemap() {
  const counters = { pointsIn: 0, pointsOut: 0 };

  const [lo, hi, lakes, places] = await Promise.all([
    fetchGeojson("ne_110m_admin_0_countries"),
    fetchGeojson("ne_50m_admin_0_countries"),
    fetchGeojson("ne_50m_lakes"),
    fetchGeojson("ne_50m_populated_places_simple"),
  ]);

  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    // Natural Earth is public domain, but saying where the map came from is
    // both courteous and what the app's about screen shows.
    attribution: "Map data: Natural Earth (public domain)",
    precision: PRECISION,
    // Countries are drawn as filled polygons with a stroked outline, so one
    // layer gives both landmass and borders. Shared borders are painted twice;
    // at a hairline that is invisible and it saves a second dataset.
    lo: { countries: collectPolygons(lo, TOLERANCE.lo, counters) },
    hi: {
      countries: collectPolygons(hi, TOLERANCE.hi, counters),
      lakes: collectPolygons(lakes, TOLERANCE.hi, counters),
    },
    places: collectPlaces(places),
  };

  return { payload, counters };
}

async function main() {
  console.log("[basemap]");
  const { payload, counters } = await buildBasemap();
  const json = JSON.stringify(payload);
  const gzip = zlib.gzipSync(Buffer.from(json), { level: 9 }).length;

  console.log(`  countries lo      ${payload.lo.countries.length} polygons`);
  console.log(`  countries hi      ${payload.hi.countries.length} polygons`);
  console.log(`  lakes             ${payload.hi.lakes.length} polygons`);
  console.log(`  places            ${payload.places.length} labels`);
  console.log(
    `  points            ${counters.pointsIn} → ${counters.pointsOut} ` +
      `(${(100 - (counters.pointsOut / counters.pointsIn) * 100).toFixed(0)}% simplified away)`,
  );
  console.log(`  TOTAL             ${kb(json.length)} raw / ${kb(gzip)} gzip`);

  if (json.length > MAX_RAW_BYTES) {
    console.error(
      `\n[basemap] ${kb(json.length)} exceeds the ${kb(MAX_RAW_BYTES)} budget.`,
    );
    process.exit(1);
  }

  // Only the gzip is committed: the store's number is download size, Dart
  // reads it back with `gzip.decode`, and one artifact in git beats two.
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, zlib.gzipSync(Buffer.from(json), { level: 9 }));
  console.log(`  written           ${path.relative(ROOT, OUT_FILE)}`);
  console.log(
    `  (source GeoJSON cached in ${path.relative(ROOT, CACHE_DIR)}/ — safe to delete)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[basemap] ${error.message}`);
    process.exit(1);
  });
}
