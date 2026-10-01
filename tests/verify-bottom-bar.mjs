// tests/verify-bottom-bar.mjs
// The map's bottom bar (TrainBottomBar): which trains lead a station's list
// (src/lib/operatorPromotion.mjs, data/overrides/operator-promotion.json) and
// how each is named — from the selected station, toward where the train goes
// (src/lib/stationFirst.mjs) — and that the line tooltip, the route chip and
// the detail panel name a train the same way. Run: npm run verify-bottom-bar

import assert from "node:assert";
import fs from "node:fs";
import {
  orderByPromotion,
  promotionRank,
} from "../src/lib/operatorPromotion.mjs";
import {
  disambiguateLabels,
  orderTripsStationFirst,
  selectedCityMatcher,
  stationFirstEndpoints,
  tripDirection,
} from "../src/lib/stationFirst.mjs";

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
    // One chip per route, never per pair of endpoints: grouping by
    // origin–destination hid NJ 493 behind NJ 491 (Hamburg–Wien by two
    // different corridors), and a chip opens only its first route.
    assert.ok(
      /const routeKey = el\?\.route_id\?\.toString\(\);/.test(src),
      "the bar keys a chip by route_id",
    );
  },
);

check("routes sharing both endpoints are different trains, so each gets its own chip", () => {
  // The measurement behind keying by route_id: routes sharing both endpoints
  // are different trains, so the bar must show each of them.
  const byEnds = new Map();
  for (const r of Object.values(viewMap)) {
    const k = [r.origin_trip_0, r.destination_trip_0].sort().join(" | ");
    byEnds.set(k, [...(byEnds.get(k) ?? []), r]);
  }
  const hamburg = byEnds.get("Hamburg Altona | Wien Hbf") ?? [];
  assert.ok(
    hamburg.length >= 2 &&
      new Set(hamburg.map((r) => r.via_0)).size === hamburg.length,
    "Hamburg–Wien is several trains on different corridors, each needing a chip",
  );
});

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

check("a one-way train ending in the selected city keeps its real direction", () => {
  // NJ 13487 runs Zürich → Wien Hbf only, calling at Wien Meidling on the way
  // in. Hidden behind NJ 13467 while the bar grouped chips by endpoints; once
  // shown, a click on Vienna named it "Wien Meidling – Wien Hbf".
  const r = row("nj_standalone_NJ_13487");
  assert.ok(/Wien Meidling/.test(r.via_0 || ""), "it calls at Wien Meidling");
  const ends = stationFirstEndpoints(r, {
    inSelectedCity: city("wien"),
    coordsOf,
  });
  assert.deepStrictEqual([ends.from, ends.to], ["Zürich HB", "Wien Hbf"]);
});

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

check(
  "the scroll fade sits outside the scrolling element, so it cannot scroll into a chip",
  () => {
    const src = fs.readFileSync(
      new URL(
        "../src/components/TrainBottomBar/TrainBottomBar.js",
        import.meta.url,
      ),
      "utf8",
    );
    const css = fs.readFileSync(
      new URL("../src/styles/globals.css", import.meta.url),
      "utf8",
    );
    // The fault: a ::after on the overflow-x-scroll element scrolled with the
    // chips and, once the bar was scrolled, covered one ("Bruxelles ▯idi").
    assert.ok(
      !/bottom-bar-scroll-fade/.test(src + css),
      "no pseudo-element fade on the scroll container",
    );
    const scroller = src.indexOf('data-testid="bottom-bar-scroll"');
    const fade = src.indexOf('data-testid="bottom-bar-fade"');
    const scrollerClose = src.lastIndexOf("</div>", fade);
    assert.ok(
      scroller > 0 && fade > scrollerClose,
      "the fade is rendered after the scroller closes, as its sibling",
    );
  },
);

// ─── The same name everywhere on the map ────────────────────────────────────

const readSrc = (rel) =>
  fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

check("the city test: display name equal, or the raw name contains it", () => {
  const norm = (n) => n.replace(/ (Centrale|Porta Garibaldi)$/, "");
  const inMilan = selectedCityMatcher("Milano", norm);
  assert.ok(inMilan("Milano Centrale"));
  assert.ok(inMilan("Milano Porta Garibaldi"));
  assert.ok(!inMilan("Bruxelles Midi"));
  assert.ok(!inMilan(""));
  assert.ok(
    !selectedCityMatcher("", norm)("Milano Centrale"),
    "no selection matches nothing",
  );
});

check(
  "a trip card's direction: direction_id, else a number only one direction has",
  () => {
    const row = { trip_short_name_0: "ICN 796", trip_short_name_1: "ICN 797" };
    assert.strictEqual(tripDirection(row, { trip_short_name: "ICN 797" }), 1);
    assert.strictEqual(
      tripDirection(row, { trip_short_name: "ICN 797", direction_id: 0 }),
      0,
    );
    const shared = { trip_short_name_0: "D 346", trip_short_name_1: "D 346" };
    assert.strictEqual(
      tripDirection(shared, { trip_short_name: "D 346" }),
      null,
    );
    assert.strictEqual(
      tripDirection(shared, { trip_short_name: "D 346", direction_id: 1 }),
      1,
    );
  },
);

check(
  "the panel's order: the other direction moves back, nothing else does",
  () => {
    const trips = [
      { id: "a0", route_id: "a", direction_id: 0 },
      { id: "a1", route_id: "a", direction_id: 1 },
      { id: "x", route_id: "b" },
    ];
    const dir = (t) => tripDirection(null, t);
    assert.deepStrictEqual(
      orderTripsStationFirst(trips, { a: 1 }, dir).map((t) => t.id),
      ["a1", "x", "a0"],
    );
    assert.strictEqual(
      orderTripsStationFirst(trips, null, dir),
      null,
      "no preference → the caller's own order",
    );
    assert.strictEqual(orderTripsStationFirst(trips, { z: 0 }, dir), null);
  },
);

check(
  "from Milano the panel opens on ICN 797, the train the chip named",
  () => {
    const r = row("icn_ICN_796");
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("milano"),
      coordsOf,
    });
    // The panel's own synthetic trips for a tripless row, now carrying direction_id.
    const trips = [0, 1].map((d) => ({
      route_id: r.route_id,
      trip_short_name: r[`trip_short_name_${d}`],
      direction_id: d,
    }));
    const ordered = orderTripsStationFirst(
      trips,
      { [r.route_id]: ends.direction },
      (t) => tripDirection(r, t),
    );
    assert.strictEqual(ordered[0].trip_short_name, "ICN 797");
  },
);

check(
  "the line tooltip and the route chip name the train from the selected station",
  () => {
    const src = readSrc("components/Map/DynamicMap.js");
    const uses = src.match(/stationFirstFor\?\.\(route\)/g) ?? [];
    assert.ok(
      uses.length >= 2,
      `tooltip and route chip both ask stationFirstFor (found ${uses.length})`,
    );
    assert.ok(
      /firstDirectionByRoute=\{firstDirectionByRoute\}/.test(src),
      "the panel is told which train to open on",
    );
    assert.ok(
      /selectedCityMatcher\(/.test(src) && /stationFirstEndpoints\(/.test(src),
    );
    const bar = readSrc("components/TrainBottomBar/TrainBottomBar.js");
    assert.ok(
      /selectedCityMatcher\(/.test(bar),
      "the bar uses the same city test",
    );
  },
);

check(
  "the panel puts the station-first train ahead of its own onward-stops guess",
  () => {
    const src = readSrc("components/TrainDetailPanel/TrainDetailPanel.js");
    const first = src.indexOf("orderTripsStationFirst(");
    const fallback = src.indexOf("const onwardCount");
    assert.ok(
      first > 0 && fallback > first,
      "station-first order is tried before onwardCount",
    );
    // A synthetic card with no direction read as direction 0: ICN 797's
    // timetable link was built with 796's origin station.
    const push = src.slice(
      src.indexOf("const pushDirection"),
      src.indexOf('pushDirection("0")'),
    );
    assert.ok(
      /direction_id: Number\(suffix\)/.test(push),
      "synthetic trips carry their direction",
    );
  },
);

console.log(`\n[verify-bottom-bar] ${passed} checks passed`);
