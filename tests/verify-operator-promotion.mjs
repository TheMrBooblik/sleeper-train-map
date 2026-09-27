// tests/verify-operator-promotion.mjs
// Promoted operators' trains are listed first in the map's bottom bar
// (src/lib/operatorPromotion.mjs, data/overrides/operator-promotion.json).
// Run: npm run verify-operator-promotion

import assert from "node:assert";
import fs from "node:fs";
import { orderByPromotion, promotionRank } from "../src/lib/operatorPromotion.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("European Sleeper, then Trenitalia, by the committed table", () => {
  assert.strictEqual(promotionRank({ agency_id: "ES" }), 1);
  assert.strictEqual(promotionRank({ agency_id: "FS" }), 2);
  assert.strictEqual(promotionRank({ agency_id: "ÖBB" }), Infinity);
});

check("a joint or re-labelled train counts if any of its operators is promoted", () => {
  assert.strictEqual(promotionRank({ agency_id: "ÖBB/FS" }), 2);
  assert.strictEqual(promotionRank({ agency_id: "X", bot_agency_id: "FS" }), 2);
});

check("promoted first by rank; everyone else keeps the order it came in", () => {
  const table = { FS: { rank: 1 }, SJ: { rank: 2 } };
  const routes = [
    { route_id: "a", agency_id: "ÖBB" },
    { route_id: "b", agency_id: "SJ" },
    { route_id: "c", agency_id: "PKP" },
    { route_id: "d", agency_id: "FS" },
    { route_id: "e", agency_id: "FS" },
  ];
  assert.deepStrictEqual(orderByPromotion(routes, table).map((r) => r.route_id), ["d", "e", "b", "a", "c"]);
  assert.deepStrictEqual(orderByPromotion([], table), []);
  assert.deepStrictEqual(orderByPromotion(null, table), []);
});

check("the bottom bar orders by promotion before it dedups a shared corridor", () => {
  const src = fs.readFileSync(new URL("../src/components/TrainBottomBar/TrainBottomBar.js", import.meta.url), "utf8");
  const order = src.indexOf("orderByPromotion(");
  const dedup = src.indexOf("routeMap.set(");
  assert.ok(order > 0 && dedup > order, "orderByPromotion must run before the routeMap dedup");
});

console.log(`\n[verify-operator-promotion] ${passed} checks passed`);
