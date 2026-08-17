// tests/verify-enrich-view-map.mjs
// Unit tests for the registry-driven view-map enrichment post-step
// (scripts/lib/enrich-view-map.mjs): NightJet legacy behavior stays
// byte-identical to the old finalizeViewMap, the PKP GTFS bundle stamps only
// endpoint-validated rows, and the trainsByNumber options used by official
// sources (via/times/per-direction polylines/stamp) work.
// Run: npm run verify-enrich
import assert from "node:assert";
import {
  enrichViewMap,
  appendSyntheticLeftovers,
} from "../scripts/lib/enrich-view-map.mjs";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const njEntry = (over = {}) => ({
  id: "nightjet",
  enabled: true,
  output: "nightjet-trains.json",
  enrich: { strategy: "trainsByNumber", setPolyline: true },
  synthetic: { idPrefix: "nj_standalone_", agency: { from: "fixed", value: "ÖBB" } },
  ...over,
});

const station = (name, time = null) => ({
  name,
  location: { latitude: 48.2, longitude: 16.4 },
  arrival: time,
  departure: time,
});

await check("NJ legacy: polyline merged onto matched BoT row, first direction wins", async () => {
  const viewMap = {
    1: { trip_short_name_0: "NJ 100", trip_short_name_1: "NJ 101" },
  };
  await enrichViewMap({
    registry: [njEntry()],
    viewMap,
    getTrains: () => ({
      "NJ 100": { polyline: "poly100", stations: [station("A"), station("B")] },
      "NJ 101": { polyline: "poly101", stations: [station("B"), station("A")] },
    }),
    readJson: () => null,
  });
  assert.strictEqual(viewMap[1].nj_polyline, "poly100");
  // legacy mode must not touch via/times/stamps
  assert.strictEqual(viewMap[1].via_0, undefined);
  assert.strictEqual(viewMap[1].official_sources, undefined);
});

await check("NJ leftovers: synthetic rows for unmatched trains, reverse paired", () => {
  const viewMap = {
    1: { trip_short_name_0: "NJ 100" },
  };
  const trains = {
    "NJ 100": { polyline: "p", stations: [station("A"), station("B")] },
    "NJ 200": { polyline: "p200", stations: [station("X"), station("Mid"), station("Y")] },
    "NJ 201": { polyline: "p201", stations: [station("Y"), station("Mid"), station("X")] },
    "NJ 300": { polyline: null, stations: [station("X"), station("Y")] }, // no polyline → skipped
  };
  appendSyntheticLeftovers({ entry: njEntry(), viewMap, trains });
  const row = viewMap.nj_standalone_NJ_200;
  assert.ok(row, "synthetic row created");
  assert.strictEqual(row.agency_id, "ÖBB");
  assert.strictEqual(row.origin_trip_0, "X");
  assert.strictEqual(row.destination_trip_0, "Y");
  assert.strictEqual(row.via_0, "Mid");
  assert.strictEqual(row.nj_polyline, "p200");
  assert.strictEqual(row.is_active, "Y");
  // reverse direction folded into the same row, not a second row
  assert.strictEqual(row.trip_short_name_1, "NJ 201");
  assert.strictEqual(viewMap.nj_standalone_NJ_201, undefined);
  assert.strictEqual(viewMap.nj_standalone_NJ_300, undefined);
});

await check("leftovers: botMatchAgencies stops a namesake swallowing a train", () => {
  // Back-on-Track carries a CFM/CFR 401 (Prietenia) alongside European
  // Sleeper's ES 401. Unscoped, the namesake marks 401 as already covered, so
  // ES 401 is dropped and ES 400 loses its reverse pairing.
  const esEntry = (botMatchAgencies) => ({
    id: "europeansleeper",
    enabled: true,
    output: "europeansleeper-trains.json",
    synthetic: {
      idPrefix: "es_",
      agency: { from: "fixed", value: "ES" },
      ...(botMatchAgencies ? { botMatchAgencies } : {}),
    },
  });
  const viewMap = () => ({
    22: { agency_id: "CFM/CFR", trip_short_name_0: "401", trip_short_name_1: "402" },
  });
  const trains = {
    400: { polyline: "p400", stations: [station("Milano"), station("Köln"), station("Bruxelles")] },
    401: { polyline: "p401", stations: [station("Bruxelles"), station("Köln"), station("Milano")] },
  };

  const unscoped = viewMap();
  appendSyntheticLeftovers({ entry: esEntry(null), viewMap: unscoped, trains });
  assert.strictEqual(unscoped.es_400.trip_short_name_1, undefined, "namesake breaks pairing");

  const scoped = viewMap();
  appendSyntheticLeftovers({ entry: esEntry(["ES"]), viewMap: scoped, trains });
  assert.strictEqual(scoped.es_400.trip_short_name_1, "401");
  assert.strictEqual(scoped.es_400.destination_trip_1, "Milano");
  assert.strictEqual(scoped.es_401, undefined, "reverse folded in, not a second row");
});

await check("trainsByNumber full options: via/times/per-direction polyline/stamp", async () => {
  const entry = {
    id: "europeansleeper",
    enabled: true,
    output: "europeansleeper-trains.json",
    enrich: {
      strategy: "trainsByNumber",
      agencyIds: ["ES"],
      setPolyline: true,
      polylineMode: "perDirection",
      updateVia: true,
      setTimes: true,
      stamp: true,
    },
  };
  const viewMap = {
    237: {
      agency_id: "ES",
      trip_short_name_0: "452",
      trip_short_name_1: "453",
      via_0: "old - stale",
    },
    9: { agency_id: "PKP", trip_short_name_0: "452" }, // out of agency scope
  };
  await enrichViewMap({
    registry: [entry],
    viewMap,
    getTrains: () => ({
      452: {
        polyline: "es452poly",
        stations: [
          { ...station("Praha hl.n."), departure: "2026-06-12T18:04:00.000Z" },
          station("Dresden Hbf"),
          { ...station("Bruxelles Midi"), arrival: "2026-06-13T09:27:00.000Z" },
        ],
      },
    }),
    readJson: () => null,
  });
  const row = viewMap[237];
  assert.strictEqual(row.nj_polyline_0, "es452poly");
  assert.strictEqual(row.nj_polyline_1, undefined); // no data for 453 tonight
  assert.strictEqual(row.via_0, "Dresden Hbf");
  assert.strictEqual(row.origin_departure_time_0, "18:04");
  assert.strictEqual(row.destination_arrival_time_0, "09:27");
  assert.deepStrictEqual(row.official_sources, ["europeansleeper"]);
  assert.strictEqual(viewMap[9].official_sources, undefined);
});

await check("stamping is idempotent and sorted across sources", async () => {
  const entry = njEntry({
    id: "nightjet",
    enrich: { strategy: "trainsByNumber", stamp: true },
  });
  const viewMap = {
    1: { trip_short_name_0: "NJ 100", official_sources: ["zz-other"] },
  };
  const args = {
    registry: [entry],
    viewMap,
    getTrains: () => ({ "NJ 100": { polyline: "p", stations: [station("A"), station("B")] } }),
    readJson: () => null,
  };
  await enrichViewMap(args);
  await enrichViewMap(args);
  assert.deepStrictEqual(viewMap[1].official_sources, ["nightjet", "zz-other"]);
});

const pkpEntry = {
  id: "pkp-gtfs",
  enabled: true,
  runner: "external",
  command: "npm run parse-pkp-gtfs",
  enrich: { strategy: "gtfsBundle", agencyIds: ["PKP", "PKP/ČD"], updateVia: true, stamp: true },
  params: { statusFile: "public/data/gtfs/pkpTrainShapes.json" },
};
const bundle = {
  byTrainKey: {
    430: {
      positions: [
        [49.78, 22.77],
        [53.91, 14.25],
      ],
      stops: [
        { name: "Przemyśl Główny" },
        { name: "Poznań Główny" },
        { name: "Świnoujście" },
      ],
    },
  },
};

await check("gtfsBundle: endpoint-matched PKP row gets official via + stamp", async () => {
  const viewMap = {
    126: {
      agency_id: "PKP",
      // endpoint matching is city-token based ("Przemyśl Gł." ≍ "Przemyśl
      // Główny"), but buildVia only strips endpoints spelled exactly like the
      // BoT origin/destination — same contract as the client-side merge.
      origin_trip_0: "Przemyśl Główny",
      destination_trip_0: "Świnoujście",
      trip_short_name_0: "EN 430 / IC 28170",
      via_0: "stale - bot - stops",
    },
  };
  await enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: (p) => (p === "public/data/gtfs/pkpTrainShapes.json" ? bundle : null),
  });
  assert.strictEqual(viewMap[126].via_0, "Poznań Główny");
  assert.deepStrictEqual(viewMap[126].official_sources, ["pkp-gtfs"]);
});

await check("gtfsBundle: wrong-corridor collision is not stamped", async () => {
  const viewMap = {
    99: {
      agency_id: "PKP",
      trip_short_name_0: "IC 430", // same number, different corridor
      origin_trip_0: "Chełm",
      destination_trip_0: "Świnoujście",
      via_0: "untouched",
    },
  };
  await enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => bundle,
  });
  assert.strictEqual(viewMap[99].official_sources, undefined);
  assert.strictEqual(viewMap[99].via_0, "untouched");
});

await check("gtfsBundle: missing bundle file is a no-op", async () => {
  const viewMap = { 126: { agency_id: "PKP", trip_short_name_0: "EN 430" } };
  await enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => null,
  });
  assert.deepStrictEqual(viewMap, { 126: { agency_id: "PKP", trip_short_name_0: "EN 430" } });
});

await check("gtfsBundle: corridor variants of a reused number are selected by endpoints", async () => {
  const variantBundle = {
    byTrainKey: {
      406: {
        // main entry = the longer München corridor…
        positions: [
          [48.14, 11.56],
          [52.23, 21.0],
        ],
        stops: [{ name: "München Hbf" }, { name: "Warszawa Wschodnia" }],
        // …but the Praha portion of the same number rides along as a variant.
        variants: [
          {
            positions: [
              [50.08, 14.44],
              [52.23, 21.0],
            ],
            stops: [
              { name: "Praha hl.n." },
              { name: "Bohumín" },
              { name: "Warszawa Wschodnia" },
            ],
          },
        ],
      },
    },
  };
  const viewMap = {
    9: {
      agency_id: "PKP/ČD",
      trip_short_name_0: "EN 443 / IC 406",
      origin_trip_0: "Praha hl.n.",
      destination_trip_0: "Warszawa Wschodnia",
      via_0: "stale",
    },
  };
  await enrichViewMap({
    registry: [pkpEntry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => variantBundle,
  });
  assert.strictEqual(viewMap[9].via_0, "Bohumín");
  assert.deepStrictEqual(viewMap[9].official_sources, ["pkp-gtfs"]);
});

await check("gtfsBundle: geometry fallback fills unmatched rows, OSM-only, no stamp", async () => {
  const entry = {
    ...pkpEntry,
    enrich: {
      ...pkpEntry.enrich,
      geometryFallback: { pinnedRelations: { 443: ["8737075"] } },
    },
  };
  const viewMap = {
    9: {
      agency_id: "PKP/ČD",
      trip_short_name_0: "EN 443 / IC 406",
      origin_trip_0: "Praha hl.n.",
      destination_trip_0: "Warszawa Wschodnia",
      via_0: "Bohumín",
    },
  };
  const calls = [];
  await enrichViewMap({
    registry: [entry],
    viewMap,
    getTrains: () => ({}),
    readJson: () => ({ byTrainKey: {} }), // bundle empty → nothing matches
    stopCoords: (name) => (name === "Praha hl.n." ? { lat: 50.08, lon: 14.44 } : null),
    resolveGeometry: async (args) => {
      calls.push(args);
      return { polyline: "osmPoly", method: "osm-pinned" };
    },
  });
  assert.strictEqual(viewMap[9].nj_polyline_0, "osmPoly");
  assert.strictEqual(viewMap[9].official_sources, undefined); // geometry ≠ corroboration
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].pinnedRelationIds, ["8737075"]);
  assert.strictEqual(calls[0].allowChain, false);
  assert.deepStrictEqual(calls[0].stops[0], { name: "Praha hl.n.", lat: 50.08, lon: 14.44 });

  // Already-matched directions must not hit the resolver.
  const matchedMap = {
    126: {
      agency_id: "PKP",
      trip_short_name_0: "EN 430",
      origin_trip_0: "Przemyśl Główny",
      destination_trip_0: "Świnoujście",
    },
  };
  const calls2 = [];
  await enrichViewMap({
    registry: [entry],
    viewMap: matchedMap,
    getTrains: () => ({}),
    readJson: () => bundle,
    resolveGeometry: async (args) => {
      calls2.push(args);
      return { polyline: "x" };
    },
  });
  assert.strictEqual(calls2.length, 0);
});

await check("a failing source is isolated; later sources still enrich", async () => {
  const viewMap = { 1: { trip_short_name_0: "NJ 100" } };
  const logs = [];
  await enrichViewMap({
    registry: [
      njEntry({ id: "broken", output: "broken.json" }),
      njEntry(),
    ],
    viewMap,
    getTrains: (entry) => {
      if (entry.id === "broken") throw new Error("boom");
      return { "NJ 100": { polyline: "ok", stations: [station("A"), station("B")] } };
    },
    readJson: () => null,
    log: (m) => logs.push(m),
  });
  assert.strictEqual(viewMap[1].nj_polyline, "ok");
  assert.ok(logs.some((m) => m.includes("broken") && m.includes("failed")));
});

await check("gtfsBundle: Leo Express matches by corridor when train numbers differ", async () => {
  const leoBundle = {
    byTrainKey: {
      1249: {
        positions: [
          [49.78, 22.77],
          [50.1, 8.66],
        ],
        stops: [
          { name: "Przemyśl Główny" },
          { name: "Praha hl.n." },
          { name: "Frankfurt (Main) Süd" },
        ],
      },
    },
  };
  const viewMap = {
    270: {
      agency_id: "LE",
      // BoT commercial number — not present as a bundle key.
      trip_short_name_0: "LE 232",
      origin_trip_0: "Przemyśl Główny",
      destination_trip_0: "Frankfurt (Main) Süd",
      via_0: "stale - bot - stops",
    },
  };
  await enrichViewMap({
    registry: [
      {
        ...pkpEntry,
        enrich: { ...pkpEntry.enrich, agencyIds: ["PKP", "PKP/ČD", "LE"] },
      },
    ],
    viewMap,
    getTrains: () => ({}),
    readJson: () => leoBundle,
  });
  assert.strictEqual(viewMap[270].via_0, "Praha hl.n.");
  assert.deepStrictEqual(viewMap[270].official_sources, ["pkp-gtfs"]);
});

console.log(`\n[verify-enrich] ${passed} checks passed`);
