// tests/verify-duplicate-detect.mjs
// Unit tests for the deterministic duplicate detector
// (scripts/lib/duplicate-detect.mjs). Run: npm run verify-duplicate-detect
import assert from "node:assert";
import {
  findDuplicateCandidate,
  scoreRoutePair,
  normalizeTrainNumber,
  buildCoordsLookup,
} from "../scripts/lib/duplicate-detect.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const r = (over = {}) => ({
  route_id: "x",
  agency_id: "ÖBB",
  trip_short_name_0: "NJ 40421",
  origin_trip_0: "Wien Hbf",
  destination_trip_0: "Roma Termini",
  service_id_0: "2026: Daily",
  via_0: "Villach - Bologna",
  ...over,
});

check("normalizeTrainNumber extracts the longest digit run", () => {
  assert.strictEqual(normalizeTrainNumber("EN 442"), "442");
  assert.strictEqual(normalizeTrainNumber("IC Notte 770"), "770");
  assert.strictEqual(normalizeTrainNumber("452"), "452");
  assert.strictEqual(normalizeTrainNumber("NJ 40421"), "40421");
  assert.strictEqual(normalizeTrainNumber(null), "");
});

check("identical endpoints + days qualify as a duplicate", () => {
  const a = r({ route_id: "555", trip_short_name_0: "EN 235" });
  const out = findDuplicateCandidate(a, [["nj_x", r()]]);
  assert.ok(out);
  assert.strictEqual(out.key, "nj_x");
  assert.ok(out.reasons.some((x) => x.includes("same endpoints")));
});

check("direction-agnostic: A→B matches an existing B→A", () => {
  const a = r({
    route_id: "555",
    origin_trip_0: "Roma Termini",
    destination_trip_0: "Wien Hbf",
  });
  const out = findDuplicateCandidate(a, [["nj_x", r()]]);
  assert.ok(out, "reverse direction still matches");
});

check("different endpoints → no candidate", () => {
  const a = r({
    route_id: "555",
    origin_trip_0: "Praha hl.n.",
    destination_trip_0: "Budapest Keleti",
  });
  assert.strictEqual(findDuplicateCandidate(a, [["nj_x", r()]]), null);
});

check("same corridor but disjoint days AND different operator → not a dup", () => {
  const a = r({
    route_id: "555",
    agency_id: "MÁV",
    service_id_0: "2026: Mon",
  });
  const existing = r({ agency_id: "ÖBB", service_id_0: "2026: Tue" });
  assert.strictEqual(findDuplicateCandidate(a, [["nj_x", existing]]), null);
  // …but with requireQualify off (AI second-opinion path) the endpoint match
  // still surfaces it for a human/AI to judge.
  const soft = findDuplicateCandidate(a, [["nj_x", existing]], {}, { requireQualify: false });
  assert.ok(soft);
});

check("alias resolution lets renamed endpoints match", () => {
  const helpers = {
    resolveName: (n) => (n === "Rome Termini" ? "Roma Termini" : n),
    coordsOf: () => null,
  };
  const a = r({ route_id: "555", destination_trip_0: "Rome Termini" });
  const out = findDuplicateCandidate(a, [["nj_x", r()]], helpers);
  assert.ok(out, "alias-resolved destination matches");
});

check("coordinate proximity matches near-identical stations", () => {
  const coords = {
    "wien hbf": { lat: 48.185, lon: 16.376 },
    wien: { lat: 48.2, lon: 16.37 },
    "roma termini": { lat: 41.901, lon: 12.502 },
    "münchen hbf": { lat: 48.14, lon: 11.56 },
  };
  const helpers = {
    resolveName: (n) => n,
    coordsOf: (n) => coords[String(n).toLowerCase().trim()] ?? null,
  };
  const near = r({ route_id: "555", origin_trip_0: "Wien" }); // ≈ Wien Hbf
  assert.ok(findDuplicateCandidate(near, [["nj_x", r()]], helpers));

  const far = r({ route_id: "556", origin_trip_0: "München Hbf" }); // 350+ km
  assert.strictEqual(findDuplicateCandidate(far, [["nj_x", r()]], helpers), null);
});

check("via overlap and matching train numbers raise the score", () => {
  const base = scoreRoutePair(r({ trip_short_name_0: "EN 999" }), r({ trip_short_name_0: "NJ 1" }));
  const boosted = scoreRoutePair(r(), r()); // same via + same number
  assert.ok(boosted.score > base.score);
  assert.ok(boosted.reasons.some((x) => x.includes("train numbers match")));
});

check("a route never matches itself by key", () => {
  const a = r({ route_id: "nj_x" });
  assert.strictEqual(findDuplicateCandidate(a, [["nj_x", a]]), null);
});

check("buildCoordsLookup: BoT stops, overrides, and alias fallback", () => {
  const coordsOf = buildCoordsLookup({
    botStops: { 1: { stop_name: "Wien Hbf", stop_lat: 48.185, stop_lon: 16.376 } },
    overrides: { "Roma Termini": { lat: 41.901, lon: 12.502 } },
    resolveName: (n) => (n === "Vienna" ? "Wien Hbf" : n),
  });
  assert.deepStrictEqual(coordsOf("Wien Hbf"), { lat: 48.185, lon: 16.376 });
  assert.deepStrictEqual(coordsOf("Roma Termini"), { lat: 41.901, lon: 12.502 });
  // alias-resolved miss
  assert.deepStrictEqual(coordsOf("Vienna"), { lat: 48.185, lon: 16.376 });
  assert.strictEqual(coordsOf("Nowhere"), null);
});

console.log(`\n[verify-duplicate-detect] ${passed} checks passed`);
