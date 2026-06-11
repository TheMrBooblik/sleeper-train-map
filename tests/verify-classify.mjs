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

console.log(`\n[verify-classify] ${passed} checks passed`);
