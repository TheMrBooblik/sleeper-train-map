// tests/verify-classify.mjs
// Unit tests for the pure nightly change classifier.
// Run: npm run verify-classify
import assert from "node:assert";
import { classify, fingerprintRoute } from "../scripts/lib/classify.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const NOW = new Date("2026-06-10T03:10:00.000Z");
const route = (over = {}) => ({
  route_id: "142",
  agency_id: "BDZ",
  trip_short_name_0: "EN 493",
  origin_trip_0: "Sofia",
  destination_trip_0: "Istanbul",
  service_id_0: "2026: Daily",
  via_0: "Plovdiv - Dimitrovgrad",
  ...over,
});
const seenEntry = (over = {}) => ({
  firstSeen: "2026-06-01",
  lastSeen: "2026-06-09",
  approved: true,
  fingerprint: fingerprintRoute(route()),
  ...over,
});

// ── Auto-show by default ─────────────────────────────────────────────────────

check("new BoT route with no look-alike is AUTO-shown (not gated)", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["142"].approved, true);
  assert.strictEqual(out.nextSeen.routes["142"].autoApproved, "2026-06-10");
  // single aggregate FYI note, no gating proposal
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.ok(out.proposals[0].title.startsWith("Auto-added"));
});

check("many new routes with no duplicates are all auto-shown (one note)", () => {
  const viewMap = {};
  for (let i = 0; i < 50; i++) {
    viewMap[`new_${i}`] = route({
      route_id: `new_${i}`,
      origin_trip_0: `City${i}`,
      destination_trip_0: `Town${i}`,
    });
  }
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap,
    injectedStations: [],
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.strictEqual(Object.keys(out.nextSeen.routes).length, 50);
});

// ── Duplicate detection → gated for review ───────────────────────────────────

const TRUST = {
  sourceIds: new Set(["nightjet", "pkp-gtfs", "cd"]),
  prefixes: ["nj_standalone_"],
};

// A trusted (official) row already on the map, distinct from the default route().
const trustedRow = (over = {}) => ({
  route_id: "nj_standalone_NJ_40421",
  agency_id: "ÖBB",
  trip_short_name_0: "NJ 40421",
  origin_trip_0: "Wien Hbf",
  destination_trip_0: "Roma Termini",
  service_id_0: "2026: Daily",
  via_0: "Villach - Bologna",
  ...over,
});

check("new BoT route duplicating a trusted route is gated + flagged", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {
      nj_standalone_NJ_40421: trustedRow(),
      // Same endpoints + days as the official row, different train number.
      555: route({
        route_id: "555",
        agency_id: "ÖBB",
        trip_short_name_0: "EN 235",
        origin_trip_0: "Wien Hbf",
        destination_trip_0: "Roma Termini",
        via_0: "Villach - Bologna",
      }),
    },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["555"]);
  assert.strictEqual(out.nextSeen.routes["555"].approved, false);
  const dupCard = out.proposals.find((p) => p.kind === "route.add");
  assert.ok(dupCard, "a route.add card was filed");
  assert.strictEqual(dupCard.target.duplicateOf, "nj_standalone_NJ_40421");
  assert.ok(dupCard.title.startsWith("Possible duplicate"));
  // the trusted row itself is auto-approved + summarised in the aggregate note
  assert.strictEqual(out.nextSeen.routes.nj_standalone_NJ_40421.approved, true);
  assert.ok(out.proposals.some((p) => p.kind === "note"));
});

check("different endpoints → NOT a duplicate, auto-shown", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {
      nj_standalone_NJ_40421: trustedRow(),
      555: route({
        route_id: "555",
        origin_trip_0: "Praha hl.n.",
        destination_trip_0: "Budapest Keleti",
      }),
    },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["555"].approved, true);
});

check("endpoint proximity (coords) catches a renamed-station duplicate", () => {
  const coords = {
    "wien hbf": { lat: 48.185, lon: 16.376 },
    wien: { lat: 48.2, lon: 16.37 },
    "roma termini": { lat: 41.901, lon: 12.502 },
    roma: { lat: 41.9, lon: 12.5 },
  };
  const helpers = {
    resolveName: (n) => n,
    coordsOf: (n) => coords[String(n).toLowerCase().trim()] ?? null,
  };
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {
      nj_standalone_NJ_40421: trustedRow(),
      555: route({
        route_id: "555",
        origin_trip_0: "Wien", // ≈ "Wien Hbf" by coords
        destination_trip_0: "Roma", // ≈ "Roma Termini" by coords
      }),
    },
    injectedStations: [],
    trust: TRUST,
    helpers,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["555"]);
  const dupCard = out.proposals.find((p) => p.kind === "route.add");
  assert.strictEqual(dupCard.target.duplicateOf, "nj_standalone_NJ_40421");
});

check("dup card deduped against an already-open proposal (still gated)", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {
      nj_standalone_NJ_40421: trustedRow(),
      555: route({
        route_id: "555",
        origin_trip_0: "Wien Hbf",
        destination_trip_0: "Roma Termini",
      }),
    },
    injectedStations: [],
    trust: TRUST,
    openProposalKeys: new Set(["route.add:555"]),
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["555"]);
  assert.strictEqual(out.nextSeen.routes["555"].approved, false);
  assert.ok(!out.proposals.some((p) => p.kind === "route.add"));
});

// ── Self-heal of previously-gated routes ─────────────────────────────────────

check("previously-gated route with no look-alike self-heals to approved", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ approved: false }) },
      injectedStations: {},
    },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["142"].approved, true);
  assert.strictEqual(out.nextSeen.routes["142"].autoApproved, "2026-06-10");
});

check("previously-gated route still matching a duplicate stays gated", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 555: seenEntry({ approved: false }) },
      injectedStations: {},
    },
    viewMap: {
      nj_standalone_NJ_40421: trustedRow(),
      555: route({
        route_id: "555",
        origin_trip_0: "Wien Hbf",
        destination_trip_0: "Roma Termini",
      }),
    },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["555"]);
  assert.strictEqual(out.nextSeen.routes["555"].approved, false);
});

// ── Approved-route change tracking (unchanged behaviour) ─────────────────────

check("mechanical refresh (same fingerprint, new times) produces nothing", () => {
  const out = classify({
    previousSeen: { v: 1, routes: { 142: seenEntry() }, injectedStations: {} },
    viewMap: { 142: route({ origin_departure_time_0: "19:45" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 0);
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["142"].lastSeen, "2026-06-10");
  assert.strictEqual(out.nextSeen.routes["142"].approved, true);
});

check("operating-days change on approved route → FYI note, still live", () => {
  const out = classify({
    previousSeen: { v: 1, routes: { 142: seenEntry() }, injectedStations: {} },
    viewMap: { 142: route({ service_id_0: "2026: Mon, Fri" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.ok(out.proposals[0].summary.includes("operating days"));
  assert.strictEqual(out.nextSeen.routes["142"].fingerprint.days0, "2026: Mon, Fri");
});

check("stop-sequence drift alone is mechanical (no proposal)", () => {
  const out = classify({
    previousSeen: { v: 1, routes: { 142: seenEntry() }, injectedStations: {} },
    viewMap: { 142: route({ via_0: "Plovdiv - Dimitrovgrad - Edirne" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 0);
});

// ── Disappearance (unchanged behaviour) ──────────────────────────────────────

check("vanished <7 days: retained silently", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastSeen: "2026-06-07" }) },
      injectedStations: {},
    },
    viewMap: {},
    injectedStations: [],
    now: NOW,
  });
  assert.ok(out.nextSeen.routes["142"]);
  assert.strictEqual(out.proposals.length, 0);
});

check("vanished ≥7 days: one removal FYI, flagged to not repeat", () => {
  const prev = {
    v: 1,
    routes: { 142: seenEntry({ lastSeen: "2026-06-01" }) },
    injectedStations: {},
  };
  const out = classify({ previousSeen: prev, viewMap: {}, injectedStations: [], now: NOW });
  assert.strictEqual(out.proposals.length, 1);
  assert.ok(out.proposals[0].title.startsWith("Disappeared"));
  assert.strictEqual(out.nextSeen.routes["142"].removalNoticed, true);

  const out2 = classify({
    previousSeen: out.nextSeen,
    viewMap: {},
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out2.proposals.length, 0);
});

check("vanished >30 days: forgotten entirely", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastSeen: "2026-05-01" }) },
      injectedStations: {},
    },
    viewMap: {},
    injectedStations: [],
    now: NOW,
  });
  assert.ok(!out.nextSeen.routes["142"]);
  assert.strictEqual(out.proposals.length, 0);
});

check("reappearing route clears removalNoticed", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastSeen: "2026-06-01", removalNoticed: true }) },
      injectedStations: {},
    },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.routes["142"].removalNoticed, undefined);
  assert.strictEqual(out.nextSeen.routes["142"].lastSeen, "2026-06-10");
});

// ── Injected stations (unchanged behaviour) ──────────────────────────────────

check("new injected station → gated + seen.approve proposal; known one passes", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: {},
      injectedStations: { Marabda: { firstSeen: "2026-05-01", approved: true } },
    },
    viewMap: {},
    injectedStations: ["Marabda", "Yerevan"],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.injectedStations.Marabda.approved, true);
  assert.strictEqual(out.nextSeen.injectedStations.Yerevan.approved, false);
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "seen.approve");
  assert.deepStrictEqual(out.proposals[0].apply.payload, { stationName: "Yerevan" });
});

// ── Trusted sources (auto-approval, skips the duplicate check) ────────────────

check("trusted-prefix new key auto-approved, one aggregate FYI note", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { nj_standalone_NJ_999: route({ trip_short_name_0: "NJ 999" }) },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes.nj_standalone_NJ_999.approved, true);
  assert.strictEqual(out.nextSeen.routes.nj_standalone_NJ_999.autoApproved, "2026-06-10");
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.strictEqual(out.proposals[0].apply, null);
  assert.strictEqual(out.proposals[0].target.routeKey, "auto-added-2026-06-10");
  assert.ok(out.proposals[0].title.includes("1 routes, 0 stations"));
});

check("row stamped official_sources by a trusted source is auto-approved", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 9: route({ official_sources: ["cd"] }) },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["9"].approved, true);
});

check("previously-gated key flips to approved when corroborated", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 9: seenEntry({ approved: false }) },
      injectedStations: {},
    },
    viewMap: { 9: route({ official_sources: ["pkp-gtfs"] }) },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["9"].approved, true);
});

check("station injected by a trusted source is auto-approved", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {},
    injectedStations: ["Wien Praterstern", "Yerevan"],
    stationSources: { "Wien Praterstern": "nightjet", Yerevan: "caucasus" },
    trust: TRUST,
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.injectedStations["Wien Praterstern"].approved, true);
  assert.strictEqual(out.nextSeen.injectedStations.Yerevan.approved, false);
  assert.strictEqual(out.proposals.length, 2);
  assert.ok(out.proposals.some((p) => p.kind === "seen.approve"));
  const note = out.proposals.find((p) => p.kind === "note");
  assert.ok(note.title.includes("0 routes, 1 stations"));
});

check("aggregate note survives the proposal cap (many gated duplicates)", () => {
  const viewMap = { nj_standalone_NJ_40421: trustedRow() };
  // 50 BoT rows all duplicating the one trusted Wien–Roma row → all gated.
  for (let i = 0; i < 50; i++) {
    viewMap[`dup_${i}`] = route({
      route_id: `dup_${i}`,
      trip_short_name_0: `EN ${i}`,
      origin_trip_0: "Wien Hbf",
      destination_trip_0: "Roma Termini",
    });
  }
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap,
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 30);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.ok(out.proposals[0].title.startsWith("Auto-added"));
  assert.strictEqual(out.gatedRouteKeys.length, 50);
});

check("disappearance note suppressed when trains migrated to another key", () => {
  const fp452 = fingerprintRoute(route({ trip_short_name_0: "452" }));
  const out = classify({
    previousSeen: {
      v: 1,
      routes: {
        es_452: seenEntry({ lastSeen: "2026-06-01", fingerprint: fp452 }),
        237: seenEntry({ fingerprint: fp452 }),
      },
      injectedStations: {},
    },
    viewMap: { 237: route({ trip_short_name_0: "452" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 0);
  assert.strictEqual(out.nextSeen.routes.es_452.removalNoticed, true);
});

console.log(`\n[verify-classify] ${passed} checks passed`);
