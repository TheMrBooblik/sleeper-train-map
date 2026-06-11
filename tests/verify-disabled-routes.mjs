// tests/verify-disabled-routes.mjs
// Unit tests for stripDisabledRoutes() — the serve-time filter that withholds
// admin-disabled routes from /api/initial-data. Run: npm run verify-disabled-routes
import assert from "node:assert";
import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const payload = () => ({
  stops: [{ stop_id: "a" }],
  viewMap: {
    7: { route_id: "7", trip_short_name_0: "RJ 1020" },
    8: { route_id: "8", trip_short_name_0: "EN 50443" },
  },
  trips: {
    "t-7": { route_id: "7" },
    "t-8": { route_id: "8" },
    "t-7b": { route_id: 7 }, // numeric route_id must match string key too
  },
});

check("removes the disabled route from viewMap", () => {
  const out = stripDisabledRoutes(payload(), ["7"]);
  assert.ok(!("7" in out.viewMap));
  assert.ok("8" in out.viewMap);
});

check("removes trips referencing the disabled route (string or number id)", () => {
  const out = stripDisabledRoutes(payload(), ["7"]);
  assert.deepStrictEqual(Object.keys(out.trips), ["t-8"]);
});

check("leaves stops untouched", () => {
  const out = stripDisabledRoutes(payload(), ["7"]);
  assert.deepStrictEqual(out.stops, [{ stop_id: "a" }]);
});

check("empty disabled list returns the payload unchanged", () => {
  const input = payload();
  const out = stripDisabledRoutes(input, []);
  assert.strictEqual(out, input);
});

check("missing disabled list is a no-op", () => {
  const input = payload();
  assert.strictEqual(stripDisabledRoutes(input, undefined), input);
});

check("does not mutate the input payload", () => {
  const input = payload();
  stripDisabledRoutes(input, ["7"]);
  assert.ok("7" in input.viewMap);
  assert.ok("t-7" in input.trips);
});

console.log(`\n[verify-disabled-routes] ${passed} checks passed`);
