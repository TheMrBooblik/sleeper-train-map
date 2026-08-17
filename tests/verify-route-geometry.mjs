// tests/verify-route-geometry.mjs
// Unit tests for the OSM-backed route geometry builder
// (scripts/lib/route-geometry.mjs): the hash-gated cache (regenerate ONLY when
// the stop list changed — zero network on hits), endpoint + via-stop validation
// of OSM candidates, Overpass discovery pick, and the straight-line fallback. Run: npm run verify-route-geometry
import assert from "node:assert";
import polyline from "@mapbox/polyline";
import {
  emptyGeometryCache,
  resolveRouteGeometry,
  stopListHash,
} from "../scripts/lib/route-geometry.mjs";

let passed = 0;
function check(name, fn) {
  const out = fn();
  const done = () => {
    passed++;
    console.log(`  ✓ ${name}`);
  };
  return out instanceof Promise ? out.then(done) : done();
}

const NOW = new Date("2026-06-10T03:10:00.000Z");
// Praha → Dresden → Berlin (roughly), as official ES-style stops.
const STOPS = [
  { name: "Praha hl.n.", lat: 50.083, lon: 14.435 },
  { name: "Dresden Hbf", lat: 51.04, lon: 13.732 },
  { name: "Berlin Hbf", lat: 52.525, lon: 13.369 },
];
const TRACK = [
  [50.084, 14.436],
  [50.6, 14.1],
  [51.041, 13.733],
  [52.0, 13.5],
  [52.526, 13.37],
];
const noFetch = () => {
  throw new Error("network must not be touched");
};

await check("stop-list hash is order-sensitive and whitespace-stable", () => {
  const a = stopListHash(["A", "B", "C"]);
  assert.strictEqual(a, stopListHash([" A", "B ", "C"]));
  assert.notStrictEqual(a, stopListHash(["A", "C", "B"]));
});

await check("pinned relation: accepted, cached, encoded", async () => {
  const cache = emptyGeometryCache();
  const out = await resolveRouteGeometry({
    key: "es:452",
    stops: STOPS,
    pinnedRelationIds: ["18616102"],
    cache,
    readScrapedRelation: (id) => (id === "18616102" ? TRACK : null),
    fetchImpl: noFetch,
    now: NOW,
  });
  assert.strictEqual(out.method, "osm-pinned");
  assert.strictEqual(out.relationId, "18616102");
  assert.strictEqual(out.polyline, polyline.encode(TRACK));
  assert.strictEqual(cache.entries["es:452"].stopsHash, stopListHash(STOPS.map((s) => s.name)));
});

await check("cache hit with same stop list: zero reads, zero network", async () => {
  const cache = emptyGeometryCache();
  cache.entries["es:452"] = {
    polyline: "cached",
    method: "osm-pinned",
    relationId: "1",
    stopsHash: stopListHash(STOPS.map((s) => s.name)),
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const out = await resolveRouteGeometry({
    key: "es:452",
    stops: STOPS,
    pinnedRelationIds: ["18616102"],
    cache,
    readScrapedRelation: () => {
      throw new Error("must not re-read relations on cache hit");
    },
    fetchImpl: noFetch,
    now: NOW,
  });
  assert.strictEqual(out.polyline, "cached");
});

await check("changed stop list invalidates the cache entry", async () => {
  const cache = emptyGeometryCache();
  cache.entries["es:452"] = {
    polyline: "stale",
    method: "osm-pinned",
    stopsHash: stopListHash(["Old", "List"]),
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const out = await resolveRouteGeometry({
    key: "es:452",
    stops: STOPS,
    pinnedRelationIds: ["18616102"],
    cache,
    readScrapedRelation: () => TRACK,
    fetchImpl: noFetch,
    now: NOW,
  });
  assert.strictEqual(out.method, "osm-pinned");
  assert.notStrictEqual(out.polyline, "stale");
});

await check("reversed OSM geometry is flipped to run origin → destination", async () => {
  const out = await resolveRouteGeometry({
    key: "es:453",
    stops: STOPS,
    pinnedRelationIds: ["1"],
    cache: emptyGeometryCache(),
    readScrapedRelation: () => [...TRACK].reverse(),
    fetchImpl: noFetch,
    now: NOW,
  });
  assert.strictEqual(out.method, "osm-pinned");
  assert.deepStrictEqual(polyline.decode(out.polyline)[0], polyline.decode(polyline.encode(TRACK))[0]);
});

await check("wrong-corridor pinned relation rejected → stops-chain fallback", async () => {
  const out = await resolveRouteGeometry({
    key: "es:454",
    stops: STOPS,
    pinnedRelationIds: ["1"],
    cache: emptyGeometryCache(),
    // Vienna–Zürich track: nowhere near Praha/Berlin endpoints.
    readScrapedRelation: () => [
      [48.18, 16.37],
      [47.37, 8.54],
    ],
    fetchImpl: null,
    now: NOW,
  });
  assert.strictEqual(out.method, "stops-chain");
  assert.strictEqual(out.polyline, polyline.encode(STOPS.map((s) => [s.lat, s.lon])));
});

// Chopin case: OSM 8737075 hits Praha + Warszawa but runs via Oświęcim, ~27 km
// south of Katowice. Endpoint-only validation used to accept it; via check must
// not. PKP geometryFallback sets allowChain: false, so the result is "none"
// and the renderer chains station coords instead.
await check("pinned relation that misses a via stop is rejected (allowChain false → none)", async () => {
  const chopinStops = [
    { name: "Praha hl.n.", lat: 50.083, lon: 14.435 },
    { name: "Katowice", lat: 50.258, lon: 19.017 },
    { name: "Warszawa Wschodnia", lat: 52.251, lon: 21.052 },
  ];
  // Praha → Oświęcim → Warszawa. Ends are right; Katowice is ~27 km off.
  const oswiecimTrack = [
    [50.083, 14.436],
    [50.042, 19.200],
    [52.251, 21.052],
  ];
  const out = await resolveRouteGeometry({
    key: "pkp-gtfs:9:0",
    stops: chopinStops,
    pinnedRelationIds: ["8737075"],
    cache: emptyGeometryCache(),
    readScrapedRelation: () => oswiecimTrack,
    fetchImpl: null,
    allowChain: false,
    now: NOW,
  });
  assert.strictEqual(out.method, "none");
  assert.strictEqual(out.polyline, null);
});

await check("Overpass discovery rejects a longer relation that misses a via stop", async () => {
  const chopinStops = [
    { name: "Praha hl.n.", lat: 50.083, lon: 14.435 },
    { name: "Katowice", lat: 50.258, lon: 19.017 },
    { name: "Warszawa Wschodnia", lat: 52.251, lon: 21.052 },
  ];
  const viaKatowice = [
    [50.083, 14.436],
    [50.258, 19.017],
    [52.251, 21.052],
  ];
  const viaOswiecimLonger = [
    [50.083, 14.436],
    [50.5, 16.0],
    [50.042, 19.200],
    [51.0, 20.0],
    [52.251, 21.052],
  ];
  const overpassResponse = {
    elements: [
      {
        type: "relation",
        id: 8737075,
        members: [
          { type: "way", geometry: viaOswiecimLonger.map(([lat, lon]) => ({ lat, lon })) },
        ],
      },
      {
        type: "relation",
        id: 999,
        members: [
          { type: "way", geometry: viaKatowice.map(([lat, lon]) => ({ lat, lon })) },
        ],
      },
    ],
  };
  const out = await resolveRouteGeometry({
    key: "pkp-gtfs:9:overpass",
    stops: chopinStops,
    refCandidates: ["443"],
    cache: emptyGeometryCache(),
    fetchImpl: async () => ({ ok: true, json: async () => overpassResponse }),
    allowChain: false,
    now: NOW,
  });
  assert.strictEqual(out.method, "overpass");
  assert.strictEqual(out.relationId, "999");
});

await check("Overpass discovery picks the longest endpoint-valid relation", async () => {
  const overpassResponse = {
    elements: [
      {
        type: "relation",
        id: 111,
        members: [
          { type: "way", geometry: [{ lat: 48.18, lon: 16.37 }, { lat: 47.37, lon: 8.54 }] },
        ],
      },
      {
        type: "relation",
        id: 222,
        members: [
          { type: "way", geometry: TRACK.map(([lat, lon]) => ({ lat, lon })) },
        ],
      },
      {
        type: "relation",
        id: 333,
        members: [
          { type: "way", geometry: [{ lat: 50.084, lon: 14.436 }, { lat: 52.526, lon: 13.37 }] },
        ],
      },
    ],
  };
  let queried = null;
  const out = await resolveRouteGeometry({
    key: "es:474",
    stops: STOPS,
    refCandidates: ["474", "ES 474"],
    operatorRegex: "European Sleeper",
    cache: emptyGeometryCache(),
    fetchImpl: async (url, opts) => {
      queried = opts.body;
      return { ok: true, json: async () => overpassResponse };
    },
    now: NOW,
  });
  assert.strictEqual(out.method, "overpass");
  assert.strictEqual(out.relationId, "222"); // longest of the two valid ones
  assert.ok(queried.includes('route"="train'));
  assert.ok(queried.includes("474"));
  assert.ok(queried.includes("European Sleeper"));
});

await check('failed lookups are cached as "none" and not retried within 7 days', async () => {
  const cache = emptyGeometryCache();
  const noCoordStops = [{ name: "A" }, { name: "B" }];
  const first = await resolveRouteGeometry({
    key: "es:999",
    stops: noCoordStops,
    cache,
    fetchImpl: noFetch,
    now: NOW,
  });
  assert.strictEqual(first.method, "none");
  assert.strictEqual(first.polyline, null);

  // 2 days later: same stop list → served from cache, no work.
  const second = await resolveRouteGeometry({
    key: "es:999",
    stops: noCoordStops,
    cache,
    fetchImpl: noFetch,
    now: new Date("2026-06-12T03:10:00.000Z"),
  });
  assert.strictEqual(second.updatedAt, first.updatedAt);

  // 8 days later: retried (updatedAt advances).
  const third = await resolveRouteGeometry({
    key: "es:999",
    stops: noCoordStops,
    cache,
    fetchImpl: noFetch,
    now: new Date("2026-06-18T04:10:00.000Z"),
  });
  assert.notStrictEqual(third.updatedAt, first.updatedAt);
});

console.log(`\n[verify-route-geometry] ${passed} checks passed`);
