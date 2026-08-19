// tests/verify-return-branches.mjs
// Unit tests for returnGeometryBranches (src/components/Map/utils/), which stops
// a route's return leg being drawn on top of its outbound leg. Two overlapping
// dashed lines fill each other's gaps and render as one solid, heavier line —
// the dash then conveys nothing about how often the train runs.
// Raw node, no network. Run: npm run verify-return-branches
import assert from "node:assert";
import {
  returnGeometryBranches,
  cachedReturnGeometryBranches,
} from "../src/components/Map/utils/returnGeometryBranches.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// A straight west→east corridor at ~0.1° (≈11 km) steps.
const corridor = Array.from({ length: 20 }, (_, i) => [50, 4 + i * 0.1]);

check("a return leg that retraces the corridor yields nothing to draw", () => {
  const back = [...corridor].reverse();
  assert.deepStrictEqual(returnGeometryBranches(corridor, back), []);
});

check("parallel tracks within tolerance still count as the same corridor", () => {
  // ~1 km north of the outbound path: a different platform or track, not a
  // different route.
  const back = corridor.map(([lat, lng]) => [lat + 0.009, lng]).reverse();
  assert.deepStrictEqual(returnGeometryBranches(corridor, back), []);
});

check("a sparsely-sampled corridor still matches a densely-stopping return", () => {
  // Station chains, not encoded polylines: the outbound calls at 3 stations
  // ~220 km apart, the return at 9 more between each pair. Every extra stop is
  // far from all three outbound *vertices* while riding the identical track, so
  // testing against vertices alone invents branches (2 of them, here) for a
  // route that never leaves the corridor.
  const outbound = [
    [50, 4],
    [51, 7],
    [52, 10],
  ];
  const stopping = [];
  for (let i = 0; i < outbound.length - 1; i += 1) {
    const [a, b] = [outbound[i], outbound[i + 1]];
    for (let s = 0; s < 10; s += 1) {
      stopping.push([
        a[0] + (b[0] - a[0]) * (s / 10),
        a[1] + (b[1] - a[1]) * (s / 10),
      ]);
    }
  }
  stopping.push(outbound[outbound.length - 1]);
  assert.deepStrictEqual(
    returnGeometryBranches(outbound, stopping.reverse()),
    [],
  );
});

check("a detour that rejoins yields exactly one branch", () => {
  // Leaves the corridor in the middle, runs ~55 km north, then rejoins.
  const back = [
    ...corridor.slice(0, 6),
    ...Array.from({ length: 6 }, (_, i) => [50.5, 4.6 + i * 0.1]),
    ...corridor.slice(12),
  ].reverse();
  const branches = returnGeometryBranches(corridor, back);
  assert.strictEqual(branches.length, 1, `expected 1 branch, got ${branches.length}`);
  assert.ok(
    branches[0].every(([lat]) => Math.abs(lat - 50.5) < 1e-6),
    "the branch should be exactly the diverging stretch",
  );
  assert.strictEqual(branches[0].length, 6);
});

check("a sliver shorter than minBranchPoints is dropped", () => {
  // Two stray points off-corridor: shape noise, not a routing.
  const back = [...corridor.slice(0, 8), [51, 4.8], [51, 4.9], ...corridor.slice(10)].reverse();
  assert.deepStrictEqual(returnGeometryBranches(corridor, back), []);
  // …but it IS a branch once the threshold is lowered, proving it was found
  // and deliberately discarded rather than never detected.
  const kept = returnGeometryBranches(corridor, back, { minBranchPoints: 2 });
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].length, 2);
});

check("a wholly different return route is kept in full", () => {
  const elsewhere = Array.from({ length: 20 }, (_, i) => [40, 4 + i * 0.1]);
  const branches = returnGeometryBranches(corridor, elsewhere);
  assert.strictEqual(branches.length, 1);
  assert.strictEqual(branches[0].length, elsewhere.length);
});

check("two separate detours yield two branches", () => {
  const back = [
    ...corridor.slice(0, 4),
    ...Array.from({ length: 5 }, (_, i) => [50.5, 4.4 + i * 0.1]),
    ...corridor.slice(9, 13),
    ...Array.from({ length: 5 }, (_, i) => [49.5, 5.3 + i * 0.1]),
    ...corridor.slice(18),
  ];
  assert.strictEqual(returnGeometryBranches(corridor, back).length, 2);
});

check("degenerate input is handled, not thrown on", () => {
  assert.deepStrictEqual(returnGeometryBranches(null, corridor), []);
  assert.deepStrictEqual(returnGeometryBranches(corridor, null), []);
  assert.deepStrictEqual(returnGeometryBranches([], corridor), []);
  assert.deepStrictEqual(returnGeometryBranches(corridor, [[50, 4]]), []);
  // NaN coordinates must not poison the grid.
  assert.deepStrictEqual(
    returnGeometryBranches([[NaN, NaN], ...corridor], [...corridor].reverse()),
    [],
  );
});

check("the cache returns the same result for the same route", () => {
  const back = [...corridor].reverse();
  const a = cachedReturnGeometryBranches("es_400", corridor, back);
  const b = cachedReturnGeometryBranches("es_400", corridor, back);
  assert.strictEqual(a, b, "second call should hit the cache");
  // A different route with the same shapes must not collide.
  const other = cachedReturnGeometryBranches("es_401", corridor, back);
  assert.deepStrictEqual(other, a);
});

console.log(`\n[verify-return-branches] ${passed} checks passed`);
