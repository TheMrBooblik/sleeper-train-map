// tests/verify-bottom-bar.mjs
// The map's bottom bar (TrainBottomBar): which trains lead a station's list
// (src/lib/operatorPromotion.mjs, data/overrides/operator-promotion.json) and
// how each is named — from the selected station, toward where the train goes
// (src/lib/bottomBarRoutes.mjs). Run: npm run verify-bottom-bar

import assert from "node:assert";
import fs from "node:fs";
import {
  orderByPromotion,
  promotionRank,
} from "../src/lib/operatorPromotion.mjs";
import {
  disambiguateLabels,
  stationFirstEndpoints,
} from "../src/lib/bottomBarRoutes.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const payload = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/published/initial-data.json", import.meta.url),
    "utf8",
  ),
);
const viewMap = (payload.data ?? payload).viewMap;
const row = (id) => {
  const r =
    viewMap[id] ??
    Object.values(viewMap).find((x) => String(x.route_id) === String(id));
  assert.ok(r, `route ${id} is in the published payload`);
  return r;
};
const coords = new Map(
  (payload.data ?? payload).stops
    .filter((s) => Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon))
    .map((s) => [s.stop_id, [s.stop_lat, s.stop_lon]]),
);
const coordsOf = (name) => coords.get(name) ?? null;
const city = (word) => (name) => String(name).toLowerCase().includes(word);

// ─── Order ──────────────────────────────────────────────────────────────────

check("European Sleeper, then Trenitalia, by the committed table", () => {
  assert.strictEqual(promotionRank({ agency_id: "ES" }), 1);
  assert.strictEqual(promotionRank({ agency_id: "FS" }), 2);
  assert.strictEqual(promotionRank({ agency_id: "ÖBB" }), Infinity);
});

check(
  "a joint or re-labelled train counts if any of its operators is promoted",
  () => {
    assert.strictEqual(promotionRank({ agency_id: "ÖBB/FS" }), 2);
    assert.strictEqual(
      promotionRank({ agency_id: "X", bot_agency_id: "FS" }),
      2,
    );
  },
);

check(
  "promoted first by rank; everyone else keeps the order it came in",
  () => {
    const table = { FS: { rank: 1 }, SJ: { rank: 2 } };
    const routes = [
      { route_id: "a", agency_id: "ÖBB" },
      { route_id: "b", agency_id: "SJ" },
      { route_id: "c", agency_id: "PKP" },
      { route_id: "d", agency_id: "FS" },
      { route_id: "e", agency_id: "FS" },
    ];
    assert.deepStrictEqual(
      orderByPromotion(routes, table).map((r) => r.route_id),
      ["d", "e", "b", "a", "c"],
    );
    assert.deepStrictEqual(orderByPromotion([], table), []);
    assert.deepStrictEqual(orderByPromotion(null, table), []);
  },
);

check(
  "a train that does not run yet goes last — even a promoted operator's",
  () => {
    const table = { ES: { rank: 1 }, FS: { rank: 2 } };
    const routes = [
      { route_id: "239", agency_id: "ES" }, // Amsterdam–Milano, "Postponed to 2027"
      { route_id: "icn", agency_id: "FS" },
      { route_id: "nj", agency_id: "ÖBB" },
      { route_id: "es_400", agency_id: "ES" },
    ];
    const isNotRunning = (r) => r.route_id === "239";
    assert.deepStrictEqual(
      orderByPromotion(routes, table, { isNotRunning }).map((r) => r.route_id),
      ["es_400", "icn", "nj", "239"],
    );
  },
);

check(
  "the bottom bar orders before it dedups, and demotes trains not running yet",
  () => {
    const src = fs.readFileSync(
      new URL(
        "../src/components/TrainBottomBar/TrainBottomBar.js",
        import.meta.url,
      ),
      "utf8",
    );
    const order = src.indexOf("orderByPromotion(");
    const dedup = src.indexOf("routeMap.set(");
    assert.ok(
      order > 0 && dedup > order,
      "orderByPromotion must run before the routeMap dedup",
    );
    assert.ok(
      /isNotRunning/.test(src) && /hasUnknownStart\(/.test(src),
      "the bar passes a not-running test",
    );
  },
);

// ─── Names: from the selected station ───────────────────────────────────────

check(
  "a click on Milan names European Sleeper from Milan, not from Brussels",
  () => {
    const es400 = row("es_400");
    // es_400 is stated Milano → Bruxelles; its twin row 240 was Bruxelles → Milano.
    const ends = stationFirstEndpoints(es400, {
      inSelectedCity: city("milan"),
      coordsOf,
    });
    assert.ok(/Milano/.test(ends.from), ends.from);
    assert.ok(/Bruxelles/.test(ends.to), ends.to);
    // …and a click on Brussels names the same train from Brussels.
    const back = stationFirstEndpoints(es400, {
      inSelectedCity: city("brux"),
      coordsOf,
    });
    assert.ok(
      /Bruxelles/.test(back.from) && /Milano/.test(back.to),
      `${back.from} – ${back.to}`,
    );
  },
);

check(
  "an intermediate stop names the farther end — the longer night on the train",
  () => {
    // ES 452/453 Berlin Gesundbrunnen ↔ Paris, calling at Bruxelles Midi:
    // Berlin is ~650 km away, Paris ~260 km, so from Brussels it reads "– Berlin".
    const r = Object.values(viewMap).find(
      (x) =>
        x.agency_id === "ES" &&
        /Berlin/.test(x.origin_trip_0 || "") &&
        /Paris/.test(x.destination_trip_0 || ""),
    );
    assert.ok(r, "ES Berlin–Paris row");
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("brux"),
      coordsOf,
    });
    assert.ok(/Bruxelles/.test(ends.from), ends.from);
    assert.ok(/Berlin/.test(ends.to), ends.to);
    assert.strictEqual(
      ends.direction,
      1,
      "toward the row's origin is the return train",
    );
  },
);

check(
  "a city only the return direction serves is still found (ICN 797 via Milano)",
  () => {
    const r = row("icn_ICN_796"); // 796 Salerno→Torino along the coast, 797 back inland via Milano
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("milano"),
      coordsOf,
    });
    assert.strictEqual(ends.from, "Milano Porta Garibaldi");
    assert.strictEqual(ends.to, "Salerno");
    assert.strictEqual(ends.direction, 1);
    assert.strictEqual(r[`trip_short_name_${ends.direction}`], "ICN 797");
  },
);

check("a one-way row never points against its only train", () => {
  const r = row("icn_ICN_752"); // Lecce → Milano Centrale, no return row of its own
  // From Bologna (intermediate) Lecce is farther, but the train goes to Milano.
  const mid = stationFirstEndpoints(r, {
    inSelectedCity: city("bologna"),
    coordsOf,
  });
  assert.strictEqual(mid.from, "Bologna Centrale");
  assert.strictEqual(mid.to, "Milano Centrale");
  // At its terminus it only arrives: the real direction is kept.
  const end = stationFirstEndpoints(r, {
    inSelectedCity: city("milano"),
    coordsOf,
  });
  assert.deepStrictEqual([end.from, end.to], ["Lecce", "Milano Centrale"]);
});

check("identical labels get the train number; unique ones stay bare", () => {
  assert.deepStrictEqual(
    disambiguateLabels([
      { from: "Bologna Centrale", to: "München Hbf", trainNumber: "NJ 238" },
      { from: "Bologna Centrale", to: "Roma Termini", trainNumber: "ICN 1" },
      { from: "Bologna Centrale", to: "München Hbf", trainNumber: "NJ 294" },
    ]),
    ["NJ 238", "", "NJ 294"],
  );
});

check("chips can never be wider than the screen", () => {
  const src = fs.readFileSync(
    new URL(
      "../src/components/TrainBottomBar/TrainBottomBar.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    /max-w-\[calc\(100vw-1rem\)\]/.test(src),
    "each chip is capped at the viewport",
  );
  assert.ok(
    /className="truncate"/.test(src),
    "the destination truncates rather than overflowing",
  );
});

check("the scroll fade sits outside the scrolling element, so it cannot scroll into a chip", () => {
  const src = fs.readFileSync(new URL("../src/components/TrainBottomBar/TrainBottomBar.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
  // The fault: a ::after on the overflow-x-scroll element scrolled with the
  // chips and, once the bar was scrolled, covered one ("Bruxelles ▯idi").
  assert.ok(!/bottom-bar-scroll-fade/.test(src + css), "no pseudo-element fade on the scroll container");
  const scroller = src.indexOf('data-testid="bottom-bar-scroll"');
  const fade = src.indexOf('data-testid="bottom-bar-fade"');
  const scrollerClose = src.lastIndexOf("</div>", fade);
  assert.ok(scroller > 0 && fade > scrollerClose, "the fade is rendered after the scroller closes, as its sibling");
});

console.log(`\n[verify-bottom-bar] ${passed} checks passed`);
