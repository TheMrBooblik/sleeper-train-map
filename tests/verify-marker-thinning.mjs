// tests/verify-marker-thinning.mjs
// The per-frame marker path: thinStationsByViewport + the station-key cache.
// Run: npm run verify-marker-thinning
//
// This runs on every pan and zoom frame, because useMapMarkers' memo depends on
// mapZoom and mapBounds. That makes its complexity a user-visible property
// rather than an implementation detail: it used to compare every stop against
// every always-show rule, and since the caller appends every endpoint of every
// route to that list (they must not vanish when zoomed out), "every rule" was
// ~1 100 entries. 1 863 stops × 1 136 rules ≈ 2.1 million string comparisons a
// frame, 19 ms against a 16.7 ms budget — the map visibly lagged when dragged,
// and it got worse with every station an official stop list added.
//
// So the assertions here are about shape, not speed: the number of
// normalizations must stay LINEAR in stops + rules. A wall-clock ceiling comes
// last and is deliberately loose, because a CI runner's absolute numbers mean
// little while the difference between n+m and n×m does not.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { thinStationsByViewport } from "../src/components/Map/utils/thinStationsByViewport.js";
import { normalizeStationNameForLookup } from "../src/lib/stationKey.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const norm = normalizeStationNameForLookup;
const ids = (r) => r.visibleStops.map((s) => s.stop_id).sort();

// ── Always-show semantics ──────────────────────────────────────────────────
// Exact rules moved into a Set and prefix rules into a list; both must still
// mean what they meant, and the selected station is neither.
{
  const stops = [
    { stop_id: "Paris Austerlitz", stop_lat: 48.84, stop_lon: 2.36 },
    { stop_id: "Frankfurt(Main)Hbf", stop_lat: 50.107, stop_lon: 8.663 },
    { stop_id: "Frankfurt(Main)Süd", stop_lat: 50.099, stop_lon: 8.686 },
    { stop_id: "Crest", stop_lat: 44.73, stop_lon: 5.01 },
    // Outside the viewport: only a forced rule can keep it.
    { stop_id: "Bodø", stop_lat: 67.28, stop_lon: 14.4 },
  ];
  const bounds = { north: 52, south: 43, east: 10, west: 0 };
  const base = {
    stops,
    cities: {},
    mapZoom: 5,
    mapBounds: bounds,
    normalizeStationNameForLookup: norm,
    selectedStopId: null,
  };

  const exact = thinStationsByViewport({ ...base, alwaysShowStations: ["Crest"] });
  check(ids(exact).includes("Crest"), "an exact always-show rule keeps its station");

  const prefix = thinStationsByViewport({ ...base, alwaysShowStations: ["Frankfurt*"] });
  check(
    ids(prefix).includes("Frankfurt(Main)Hbf") && ids(prefix).includes("Frankfurt(Main)Süd"),
    "a prefix rule keeps every station under it",
  );
  check(
    !ids(prefix).includes("Bodø") ||
      thinStationsByViewport({ ...base, alwaysShowStations: ["Bodø"] }).visibleStops.length > 0,
    "a prefix rule does not become a wildcard",
  );

  const forcedOffscreen = thinStationsByViewport({ ...base, alwaysShowStations: ["Bodø"] });
  check(
    ids(forcedOffscreen).includes("Bodø"),
    "a forced station is kept even outside the viewport",
  );

  const selected = thinStationsByViewport({
    ...base,
    alwaysShowStations: [],
    selectedStopId: "Bodø",
  });
  check(ids(selected).includes("Bodø"), "the selected station is kept with no rules at all");

  const none = thinStationsByViewport({ ...base, alwaysShowStations: [] });
  check(!ids(none).includes("Bodø"), "an out-of-bounds station is dropped when nothing forces it");

  // Every stop is accounted for: visible ∪ hidden == stops, with no overlap.
  const all = thinStationsByViewport({ ...base, alwaysShowStations: ["Crest"] });
  const seen = new Set([...all.visibleStops, ...all.hiddenStops].map((s) => s.stop_id));
  check(
    seen.size === stops.length &&
      all.visibleStops.length + all.hiddenStops.length === stops.length,
    "no stop is lost or duplicated between visible and hidden",
  );

  // Above the threshold everything shows, whatever the rules say.
  const zoomedIn = thinStationsByViewport({ ...base, mapZoom: 12, alwaysShowStations: [] });
  check(
    zoomedIn.visibleStops.length === stops.length && zoomedIn.hiddenStops.length === 0,
    "zoomed in past the threshold, every stop shows",
  );
}

// ── The complexity is the point ────────────────────────────────────────────
// Count normalizer calls through a counting wrapper: the total must scale with
// stops + rules, never with their product. This is the assertion that actually
// pins the fix — a reverted Set would blow it by three orders of magnitude.
{
  const stops = Array.from({ length: 600 }, (_, i) => ({
    stop_id: `Station ${i}`,
    stop_lat: 45 + (i % 100) / 100,
    stop_lon: 5 + (i % 50) / 50,
  }));
  const rules = Array.from({ length: 900 }, (_, i) => `Endpoint ${i}`);

  let calls = 0;
  const counting = (name) => {
    calls += 1;
    return norm(name);
  };
  thinStationsByViewport({
    stops,
    cities: {},
    mapZoom: 5,
    mapBounds: { north: 50, south: 44, east: 8, west: 4 },
    normalizeStationNameForLookup: counting,
    alwaysShowStations: rules,
    selectedStopId: null,
  });

  const linear = stops.length + rules.length;
  const product = stops.length * rules.length;
  check(
    calls <= linear * 3,
    `normalizations stay linear in stops+rules: ${calls} vs ${linear} linear / ${product.toLocaleString()} if scanned per stop`,
  );
  check(
    calls < product / 100,
    "the always-show rules are not scanned once per stop",
  );
}

// ── The station-key cache must be invisible ────────────────────────────────
{
  const names = [
    "Košice, žst.",
    "Bruxelles-Midi",
    "Antwerpen-Centraal / Anvers-Central",
    "Pardubice hlavní nádraží",
    "Frankfurt(Main)Hbf",
    "  padded  ",
  ];
  for (const n of names) {
    const first = norm(n);
    const second = norm(n);
    if (first !== second) fail(`the cache changed the answer for ${JSON.stringify(n)}`);
  }
  ok("repeat calls return the same key (the cache is a cache, not a transform)");

  // Falsy input is returned as-is, unchanged by caching — callers rely on it
  // (normalizeForAllowlistMatch type-checks the result rather than the input).
  for (const falsy of [undefined, null, "", 0, false]) {
    const a = norm(falsy);
    const b = norm(falsy);
    if (!Object.is(a, falsy) || !Object.is(b, falsy)) {
      fail(`falsy input ${JSON.stringify(falsy)} must pass through unchanged`);
    }
  }
  ok("falsy input passes through, cached or not");

  // Two names that normalise to the same key must not collide in the cache.
  assert.strictEqual(norm("Ostrava, hl.n."), norm("Ostrava hl.n."));
  assert.notStrictEqual(norm("Ostrava hl.n."), norm("Praha hl.n."));
  ok("distinct names keep distinct keys");
}

// ── Against the real payload, with a loose wall-clock ceiling ──────────────
{
  const published = path.join(ROOT, "public/data/published/initial-data.json");
  if (fs.existsSync(published)) {
    const { data } = JSON.parse(fs.readFileSync(published, "utf8"));
    const named = new Set();
    const endpoints = [];
    for (const r of Object.values(data.viewMap)) {
      for (const d of [0, 1]) {
        for (const f of ["origin_trip_", "destination_trip_"]) {
          const n = r[`${f}${d}`];
          if (n) {
            named.add(String(n).trim());
            endpoints.push(String(n).trim());
          }
        }
        for (const n of String(r[`via_${d}`] || "").split(" - ")) {
          if (n.trim()) named.add(n.trim());
        }
      }
    }
    const lower = new Set([...named].map((n) => n.toLowerCase()));
    const stops = data.stops
      .filter(
        (s) =>
          s?.stop_name &&
          Number.isFinite(s.stop_lat) &&
          lower.has(s.stop_name.toLowerCase().trim()),
      )
      .map((s) => ({ stop_id: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon }));

    const args = {
      stops,
      cities: {},
      mapZoom: 5,
      mapBounds: { north: 60, south: 40, east: 25, west: -5 },
      normalizeStationNameForLookup: norm,
      alwaysShowStations: endpoints,
      selectedStopId: null,
    };
    thinStationsByViewport(args); // warm
    const t0 = performance.now();
    const N = 10;
    for (let i = 0; i < N; i += 1) {
      thinStationsByViewport({
        ...args,
        mapBounds: { ...args.mapBounds, west: -5 + i * 0.01 },
      });
    }
    const ms = (performance.now() - t0) / N;
    // Measured 19.3 ms before the fix and 1.6 ms after, on the same machine.
    // 12 ms is loose enough for a slow shared runner and still well under what
    // a per-stop rule scan costs.
    check(
      ms < 12,
      `a pan frame over ${stops.length} stops and ${endpoints.length} rules: ${ms.toFixed(1)} ms (ceiling 12)`,
    );
  } else {
    ok("no published payload — skipped the wall-clock check");
  }
}

// ── Coordinate-override hygiene ────────────────────────────────────────────
// station-coordinates.json is 102 hand-written names and its whole job is to
// replace a wrong coordinate. An entry naming a station the payload does not
// carry under that spelling does nothing at all, silently — which is not
// hypothetical: seven of them are Latin spellings of Ukrainian and Bulgarian
// stations the payload holds in Cyrillic ("Berdychiv" where the stop is
// "Бердичів"), so somebody already tried to fix those positions by hand and
// the entries have never once applied. Reported rather than failed, like
// verify-seo-urls' uncovered endpoints: they become live the day the lookup
// learns to fold transliterations, and deleting them would lose the work.
{
  const published = path.join(ROOT, "public/data/published/initial-data.json");
  const overridePath = path.join(ROOT, "data/overrides/station-coordinates.json");
  if (fs.existsSync(published) && fs.existsSync(overridePath)) {
    const { data } = JSON.parse(fs.readFileSync(published, "utf8"));
    const overrides = JSON.parse(fs.readFileSync(overridePath, "utf8"));
    const keyed = new Set();
    for (const s of data.stops) {
      if (s?.stop_id) keyed.add(String(s.stop_id).toLowerCase().trim());
      if (s?.stop_name) keyed.add(String(s.stop_name).toLowerCase().trim());
    }
    const unmatched = Object.keys(overrides).filter(
      (k) => !keyed.has(k.toLowerCase().trim()),
    );

    // Every entry must at least be well-formed, which IS a failure: a malformed
    // one would be applied as NaN and drop the marker rather than move it.
    const malformed = Object.entries(overrides).filter(
      ([, v]) => !Number.isFinite(Number(v?.lat)) || !Number.isFinite(Number(v?.lon)),
    );
    check(
      malformed.length === 0,
      `every override carries finite coordinates${malformed.length ? ` (bad: ${malformed.map(([k]) => k).join(", ")})` : ""}`,
    );

    // And an entry that DOES match must be the coordinate the payload carries —
    // otherwise the build-time pass in normalizeStops() has stopped applying it.
    const byKey = new Map();
    for (const s of data.stops) {
      for (const k of [s?.stop_id, s?.stop_name]) {
        if (k) {
          const lk = String(k).toLowerCase().trim();
          if (!byKey.has(lk)) byKey.set(lk, s);
        }
      }
    }
    const notApplied = Object.entries(overrides).filter(([k, v]) => {
      const s = byKey.get(k.toLowerCase().trim());
      if (!s) return false;
      return s.stop_lat !== Number(v.lat) || s.stop_lon !== Number(v.lon);
    });
    check(
      notApplied.length === 0,
      `every matching override is the coordinate the payload carries${notApplied.length ? ` (not applied: ${notApplied.map(([k]) => k).join(", ")})` : ""}`,
    );

    console.log(
      `  · ${Object.keys(overrides).length - unmatched.length}/${Object.keys(overrides).length} overrides name a station in the payload` +
        (unmatched.length ? `; inert: ${unmatched.join(", ")}` : ""),
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll marker-thinning checks passed.");
