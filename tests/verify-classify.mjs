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

check("new route key is gated and proposed with seen.approve apply", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["142"]);
  assert.strictEqual(out.nextSeen.routes["142"].approved, false);
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].kind, "route.add");
  assert.deepStrictEqual(out.proposals[0].apply, {
    type: "seen.approve",
    payload: { routeKey: "142" },
  });
});

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
  // fingerprint advances so the same change doesn't re-fire tomorrow
  assert.strictEqual(
    out.nextSeen.routes["142"].fingerprint.days0,
    "2026: Mon, Fri",
  );
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

check("unapproved existing route stays gated, no duplicate proposal", () => {
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
  assert.deepStrictEqual(out.gatedRouteKeys, ["142"]);
  assert.strictEqual(out.proposals.length, 0);
});

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

  // Re-run with the flagged seen — no second notice.
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

check("openProposalKeys dedups", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 142: route() },
    injectedStations: [],
    openProposalKeys: new Set(["route.add:142"]),
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 0);
  // still gated + tracked even when the proposal already exists
  assert.deepStrictEqual(out.gatedRouteKeys, ["142"]);
  assert.strictEqual(out.nextSeen.routes["142"].approved, false);
});

// ── Trusted sources (auto-approval) ──────────────────────────────────────────
const TRUST = {
  sourceIds: new Set(["nightjet", "pkp-gtfs"]),
  prefixes: ["nj_standalone_"],
};

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
  assert.strictEqual(out.proposals[0].target.routeKey, "trusted-2026-06-10");
  assert.ok(out.proposals[0].title.includes("1 routes, 0 stations"));
});

check("row stamped official_sources by a trusted source is auto-approved", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 9: route({ official_sources: ["pkp-gtfs"] }) },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, []);
  assert.strictEqual(out.nextSeen.routes["9"].approved, true);
});

check("untrusted new key still gated alongside trusted ones", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: {
      142: route(),
      nj_standalone_NJ_999: route({ trip_short_name_0: "NJ 999" }),
    },
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.deepStrictEqual(out.gatedRouteKeys, ["142"]);
  assert.strictEqual(out.nextSeen.routes["142"].approved, false);
  assert.ok(out.proposals.some((p) => p.kind === "route.add"));
  assert.ok(out.proposals.some((p) => p.kind === "note"));
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
  assert.strictEqual(
    out.nextSeen.injectedStations["Wien Praterstern"].approved,
    true,
  );
  assert.strictEqual(out.nextSeen.injectedStations.Yerevan.approved, false);
  // one seen.approve for the untrusted station + one aggregate note
  assert.strictEqual(out.proposals.length, 2);
  assert.ok(out.proposals.some((p) => p.kind === "seen.approve"));
  const note = out.proposals.find((p) => p.kind === "note");
  assert.ok(note.title.includes("0 routes, 1 stations"));
});

check("aggregate note survives the proposal cap", () => {
  const viewMap = { nj_standalone_NJ_999: route({ trip_short_name_0: "NJ 999" }) };
  for (let i = 0; i < 50; i++) viewMap[`new_${i}`] = route({ route_id: `new_${i}` });
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap,
    injectedStations: [],
    trust: TRUST,
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 30);
  assert.strictEqual(out.proposals[0].kind, "note");
  assert.ok(out.proposals[0].title.startsWith("Auto-added from trusted sources"));
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
  // flagged so it never fires later either
  assert.strictEqual(out.nextSeen.routes.es_452.removalNoticed, true);
});

check("proposal cap respected", () => {
  const viewMap = {};
  for (let i = 0; i < 50; i++) viewMap[`new_${i}`] = route({ route_id: `new_${i}` });
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap,
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 30);
  assert.strictEqual(out.droppedProposals, 20);
  assert.strictEqual(out.gatedRouteKeys.length, 50);
});

// ─── lastChanged ────────────────────────────────────────────────────────────
// The honest staleness signal for the integration dashboard: a nightly fetch
// of an unmaintained upstream keeps the feed timestamp green forever, so what
// matters is when the route's own content last moved.

check("a new route records lastChanged as today", () => {
  const out = classify({
    previousSeen: { v: 1, routes: {}, injectedStations: {} },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.routes["142"].lastChanged, "2026-06-10");
});

check("an unchanged route keeps its previous lastChanged", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastChanged: "2026-02-01" }) },
      injectedStations: {},
    },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.routes["142"].lastChanged, "2026-02-01");
  assert.strictEqual(out.nextSeen.routes["142"].lastSeen, "2026-06-10");
});

check("a material change moves lastChanged to today", () => {
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastChanged: "2026-02-01" }) },
      injectedStations: {},
    },
    viewMap: { 142: route({ destination_trip_0: "Halkali" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.routes["142"].lastChanged, "2026-06-10");
});

check("a stop-sequence-only change also moves lastChanged", () => {
  // Mechanical for the review queue (no proposal), but it is still the data
  // changing, which is what this date is for.
  const out = classify({
    previousSeen: {
      v: 1,
      routes: { 142: seenEntry({ lastChanged: "2026-02-01" }) },
      injectedStations: {},
    },
    viewMap: { 142: route({ via_0: "Plovdiv - Dimitrovgrad - Kapikule" }) },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.proposals.length, 0);
  assert.strictEqual(out.nextSeen.routes["142"].lastChanged, "2026-06-10");
});

check("an entry written before lastChanged existed backfills to firstSeen", () => {
  const legacy = seenEntry();
  delete legacy.lastChanged;
  const out = classify({
    previousSeen: { v: 1, routes: { 142: legacy }, injectedStations: {} },
    viewMap: { 142: route() },
    injectedStations: [],
    now: NOW,
  });
  assert.strictEqual(out.nextSeen.routes["142"].lastChanged, "2026-06-01");
});

console.log(`\n[verify-classify] ${passed} checks passed`);
