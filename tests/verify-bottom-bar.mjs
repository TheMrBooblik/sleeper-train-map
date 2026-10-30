// tests/verify-bottom-bar.mjs
// The map's bottom bar (TrainBottomBar): which trains lead a station's list
// (src/lib/operatorPromotion.mjs, data/overrides/operator-promotion.json) and
// which of a route's two trains it names — the one boarded at the selected
// station (src/lib/stationFirst.mjs), labelled by where that train starts and
// ends — and that the line tooltip, the route chip and the detail panel pick
// the same train; and which trains a click on a
// second station opens (routesBetweenStations). Run: npm run verify-bottom-bar

import assert from "node:assert";
import fs from "node:fs";
import {
  orderByPromotion,
  promotionRank,
  stackPathsByPromotion,
} from "../src/lib/operatorPromotion.mjs";
import {
  directionBetween,
  disambiguateLabels,
  endpointsInDirection,
  orderTripsStationFirst,
  routesBetweenStations,
  selectedCityMatcher,
  stationFirstEndpoints,
  trainEndpoints,
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
// A row with its direction-1 fields stripped: the one-way shape 45 rows in the
// payload have, made from a real row so its stop names carry coordinates.
const oneWay = (id) =>
  Object.fromEntries(Object.entries(row(id)).filter(([k]) => !/_1$/.test(k)));

// ─── Order ──────────────────────────────────────────────────────────────────

check("European Sleeper, then Trenitalia, then RegioJet, by the committed table", () => {
  assert.strictEqual(promotionRank({ agency_id: "ES" }), 1);
  assert.strictEqual(promotionRank({ agency_id: "FS" }), 2);
  assert.strictEqual(promotionRank({ agency_id: "RJ" }), 3);
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
  "map lines stack promoted operators on top, rank 1 last, hovered above all",
  () => {
    const table = { ES: { rank: 1 }, FS: { rank: 2 } };
    const rows = {
      bud: { agency_id: "MÁV" }, // Berlin–Budapest, shares track with ES
      es: { agency_id: "ES" },
      icn: { agency_id: "FS" },
      nj: { agency_id: "ÖBB" },
      esFuture: { agency_id: "ES" },
    };
    const paths = [
      { key: "es-0", routeId: "es" },
      { key: "bud-0", routeId: "bud" },
      { key: "icn-0", routeId: "icn" },
      { key: "es-1", routeId: "es" },
      { key: "nj-0", routeId: "nj" },
      { key: "esFuture-0", routeId: "esFuture", isFuture: true },
    ];
    const routeOf = (p) => rows[p.routeId];
    const keys = (opts) =>
      stackPathsByPromotion(paths, routeOf, { table, ...opts }).map(
        (p) => p.key,
      );
    // Drawn later = on top: European Sleeper over Trenitalia over the rest;
    // a faded future timetable is not promoted over a running train.
    assert.deepStrictEqual(keys(), [
      "bud-0",
      "nj-0",
      "esFuture-0",
      "icn-0",
      "es-0",
      "es-1",
    ]);
    // The hovered route rises above even European Sleeper.
    assert.deepStrictEqual(keys({ raisedRouteId: "bud" }).slice(-1), [
      "bud-0",
    ]);
    assert.deepStrictEqual(stackPathsByPromotion(null, routeOf), []);
  },
);

check(
  "the map draws lines in promotion order and re-raises mounted layers",
  () => {
    const src = fs.readFileSync(
      new URL("../src/components/Map/DynamicMap.js", import.meta.url),
      "utf8",
    );
    assert.ok(
      /stackPathsByPromotion\(/.test(src),
      "DynamicMap must order its route lines with stackPathsByPromotion",
    );
    // Re-ordering keyed React children never moves a mounted Leaflet layer,
    // so the order alone only holds for the first mount.
    assert.ok(
      /bringToFront\(\)/.test(src),
      "DynamicMap must bring promoted / hovered layers to the front",
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
  "a city only the return direction serves is still found (ICN 798 via Parma)",
  () => {
    // 797 Torino→Salerno calls at Milano and Roma Ostiense only; 798 back
    // calls at Roma Tiburtina, Orvieto, Parma and Piacenza on the way north.
    const r = row("icn_ICN_797");
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("parma"),
      coordsOf,
    });
    assert.strictEqual(ends.from, "Parma");
    assert.strictEqual(ends.to, "Torino Porta Nuova");
    assert.strictEqual(ends.direction, 1);
    assert.strictEqual(r[`trip_short_name_${ends.direction}`], "ICN 798");
  },
);

check(
  "the bar names a train by where it really starts and ends, never from the click",
  () => {
    // From Brussels, ES 452/453 is the train toward Berlin (direction 1), and
    // its chip reads Paris – Berlin: where that train starts, where it ends.
    const r = Object.values(viewMap).find(
      (x) =>
        x.agency_id === "ES" &&
        /Berlin/.test(x.origin_trip_0 || "") &&
        /Paris/.test(x.destination_trip_0 || ""),
    );
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("brux"),
      coordsOf,
    });
    const train = trainEndpoints(r, ends.direction);
    assert.strictEqual(train.from, r.origin_trip_1);
    assert.strictEqual(train.to, r.destination_trip_1);
    assert.ok(/Paris/.test(train.from) && /Berlin/.test(train.to));
    // Direction 1 of a row stating no return endpoints is direction 0 reversed.
    assert.deepStrictEqual(
      trainEndpoints({ origin_trip_0: "A", destination_trip_0: "B" }, 1),
      { from: "B", to: "A" },
    );
    assert.deepStrictEqual(trainEndpoints(r, 0), {
      from: r.origin_trip_0,
      to: r.destination_trip_0,
    });
    const bar = fs.readFileSync(
      new URL(
        "../src/components/TrainBottomBar/TrainBottomBar.js",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(
      /trainEndpoints\(el, ends\.direction\)/.test(bar) &&
        /origin: train\.from/.test(bar) &&
        /destination: train\.to/.test(bar),
      "the chip prints the train's own endpoints",
    );
  },
);

check("a one-way row never points against its only train", () => {
  const r = oneWay("icn_ICN_758"); // Lecce → Milano Centrale, its return (ICN 765) stripped
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
  "from Parma the panel opens on ICN 798, the train the chip named",
  () => {
    const r = row("icn_ICN_797");
    const ends = stationFirstEndpoints(r, {
      inSelectedCity: city("parma"),
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
    assert.strictEqual(ordered[0].trip_short_name, "ICN 798");
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

// ─── A second station: the trains between the two ───────────────────────────

check("the direction that calls at the first station before the second", () => {
  const es = row("237"); // ES 452 Praha → Bruxelles, 453 back
  const opts = (from, to) => ({ inFrom: city(from), inTo: city(to) });
  assert.strictEqual(directionBetween(es, opts("praha", "bruxelles")), 0);
  assert.strictEqual(directionBetween(es, opts("bruxelles", "praha")), 1);
  // Two intermediate stops, in both orders.
  assert.strictEqual(directionBetween(es, opts("dresden", "amsterdam")), 0);
  assert.strictEqual(directionBetween(es, opts("amsterdam", "dresden")), 1);
  // A place the stop lists do not name proves nothing about order.
  assert.strictEqual(directionBetween(es, opts("praha", "nowhere")), null);
});

check("a one-way row met from its far end is not a ride", () => {
  const icn = oneWay("icn_ICN_758"); // Lecce → Milano only
  const opts = (from, to) => ({ inFrom: city(from), inTo: city(to) });
  assert.strictEqual(directionBetween(icn, opts("bari", "bologna")), 0);
  assert.strictEqual(directionBetween(icn, opts("bologna", "bari")), -1);
  assert.deepStrictEqual(
    routesBetweenStations([icn], opts("bologna", "bari")),
    [],
    "the train does not take you from Bologna to Bari",
  );
});

check("known directions lead, in the order given; unknown ones follow", () => {
  const opts = { inFrom: city("praha"), inTo: city("bruxelles") };
  const mystery = { route_id: "x", origin_trip_0: "A", destination_trip_0: "B" };
  const between = routesBetweenStations([mystery, row("237")], opts);
  assert.deepStrictEqual(
    between.map((b) => [String(b.route.route_id), b.direction]),
    [
      ["237", 0],
      ["x", null],
    ],
  );
});

check("the chip names the train running toward the second station", () => {
  const es = row("237");
  // From Dresden toward Prague is ES 453's way, not the farther-end guess.
  const ends = endpointsInDirection(es, 1, { inFrom: city("dresden") });
  assert.strictEqual(ends.from, "Dresden Hbf");
  assert.strictEqual(ends.to, "Praha hl.n.");
  assert.strictEqual(ends.direction, 1);
  assert.strictEqual(
    endpointsInDirection(oneWay("icn_ICN_758"), 1, { inFrom: city("bari") }),
    null,
    "a one-way row has no direction 1",
  );
});

check("the map opens the trains between two stations before switching", () => {
  const src = readSrc("components/Map/DynamicMap.js");
  const body = src.slice(src.indexOf("const handleMarkerClick = useCallback("));
  const pair = body.indexOf("openRoutesToStop(filteredStop)");
  const select = body.indexOf("setStopId(stop_id)");
  assert.ok(pair > 0 && select > pair, "a shared route is tried first");
  assert.ok(
    /fromSearch: true/.test(src),
    "a header search still selects the station it names",
  );
});

console.log(`\n[verify-bottom-bar] ${passed} checks passed`);
