// tests/verify-marker-grouping.mjs
// Unit tests for groupCityMarkers (src/components/Map/utils/), which collapses a
// city's stations into one map dot.
//
// The bucket key is normalizeStationNameForDisplay, a SUBSTRING matcher. So one
// station that merely shares a city's name — "Florence Amtrak Station" in South
// Carolina against Firenze — dragged the Florence dot to [40.6, -19.1], the
// middle of the Atlantic, and neither city had a marker where it belongs; hence
// the proximity clustering.
//
// The marker then sits on its cluster's ANCHOR — a real station — rather than at
// the average of its members, because an average is never a place. See
// pickAnchorStation: with one station in a bucket the average costs nothing, but
// the moment a second arrives the dot slides into the countryside between them.
//
// Raw node, no network. Run: npm run verify-marker-grouping
import assert from "node:assert";
import {
  groupCityMarkers,
  pickAnchorStation,
} from "../src/components/Map/utils/groupCityMarkers.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const stop = (id, lat, lon, extra = {}) => ({
  stop_id: id,
  stop_lat: lat,
  stop_lon: lon,
  ...extra,
});

// Stand-ins for the two normalizers the map passes in: display collapses to the
// city, lookup is the identity (the fixtures are already canonical).
const display = (name) => {
  if (String(name).includes("Florence") || String(name).startsWith("Firenze")) return "Florence";
  if (String(name).startsWith("Berlin")) return "Berlin";
  return name;
};
const lookup = (name) => name;
const citiesFor = (ids, over = {}) =>
  Object.fromEntries(ids.map((id) => [id, { stop_id: id, stop_route_ids: "1", ...(over[id] ?? {}) }]));

const FIRENZE_CASTELLO = stop("Firenze Castello", 43.8145, 11.2225);
const FIRENZE_CAMPO_MARTE = stop("Firenze Campo Marte", 43.7813, 11.2745);
const FLORENCE_SC = stop("Florence Amtrak Station", 34.1987, -79.7573);

check("a city on two continents becomes two markers, each in its place", () => {
  const stops = [FIRENZE_CASTELLO, FIRENZE_CAMPO_MARTE, FLORENCE_SC];
  const out = groupCityMarkers(
    stops,
    citiesFor(stops.map((s) => s.stop_id)),
    true,
    display,
    lookup,
  );
  assert.strictEqual(out.length, 2, `expected 2 markers, got ${out.length}`);
  const italy = out.find((m) => m.stop_lon > 0);
  const carolina = out.find((m) => m.stop_lon < 0);
  assert.ok(italy && carolina, "one marker per continent");
  // Both keep the display name — it is the position that has to be honest.
  assert.strictEqual(italy.displayName, "Florence");
  assert.strictEqual(carolina.displayName, "Florence");
  assert.ok(Math.abs(italy.stop_lat - 43.798) < 0.05 && Math.abs(italy.stop_lon - 11.248) < 0.05);
  assert.ok(Math.abs(carolina.stop_lat - 34.199) < 0.01 && Math.abs(carolina.stop_lon + 79.757) < 0.01);
  // The bug this guards: the average of all three lands in the ocean.
  assert.ok(!out.some((m) => m.stop_lon < 0 && m.stop_lon > -30), "no marker in the Atlantic");
});

check("a sprawling real city still collapses to one marker", () => {
  // Spandau to Ostbahnhof is ~20 km; splitting Berlin would be a regression.
  const stops = [
    stop("Berlin Hbf", 52.525, 13.3695),
    stop("Berlin Gesundbrunnen", 52.5487, 13.3886),
    stop("Berlin-Spandau", 52.5345, 13.1976),
    stop("Berlin Ostbahnhof", 52.5103, 13.4348),
  ];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].groupSize, 4);
  assert.ok(out[0].isGrouped);
});

check("a lone far-off station is a marker, not a dropped station", () => {
  const stops = [FIRENZE_CASTELLO, FLORENCE_SC];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((m) => m.isGrouped === false), "single-member clusters are not grouped");
  assert.deepStrictEqual(
    out.map((m) => m.stop_id).sort(),
    ["Firenze Castello", "Florence Amtrak Station"],
  );
});

check("clusters chain through intermediate stations", () => {
  // Three stations 50 km apart in a line: single-link keeps them together even
  // though the ends are 100 km apart, which is what a real corridor city needs.
  const stops = [
    stop("Berlin A", 52.0, 13.0),
    stop("Berlin B", 52.45, 13.0),
    stop("Berlin C", 52.9, 13.0),
  ];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].groupSize, 3);
});

check("the grouped marker still prefers a main station's own coordinates", () => {
  const stops = [
    stop("Berlin Hbf", 52.525, 13.3695, { coordinatesSource: "custom" }),
    stop("Berlin Ostbahnhof", 52.5103, 13.4348),
  ];
  const cities = citiesFor(stops.map((s) => s.stop_id), {
    "Berlin Hbf": { isViaStation: false },
    "Berlin Ostbahnhof": { isViaStation: true },
  });
  const out = groupCityMarkers(stops, cities, true, display, lookup);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].stop_lat, 52.525);
  assert.strictEqual(out[0].stop_lon, 13.3695);
});

check("ungrouped mode is untouched by clustering", () => {
  const stops = [FIRENZE_CASTELLO, FLORENCE_SC];
  const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), false, display, lookup);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((m) => m.isGrouped === false));
  assert.strictEqual(out[0].displayName, "Firenze Castello");
});

check("degenerate input yields nothing rather than throwing", () => {
  assert.deepStrictEqual(groupCityMarkers([], {}, true, display, lookup), []);
  assert.deepStrictEqual(groupCityMarkers(null, {}, true, display, lookup), []);
  // Stations with no route metadata never become markers.
  assert.deepStrictEqual(groupCityMarkers([FLORENCE_SC], {}, true, display, lookup), []);
});

// ── The anchor: which station a grouped marker sits on ─────────────────────
// Every one of these is a case where a simpler rule picks the wrong station.
{
  const lookupId = (n) => n;
  const cityData = (spec) =>
    Object.fromEntries(
      Object.entries(spec).map(([id, [routes, isVia]]) => [
        id,
        { stop_id: id, stop_route_ids: Array.from({ length: routes }, (_, i) => `r${i}`).join(","), isViaStation: isVia },
      ]),
    );

  check("the marker sits on the endpoint, not between it and a via station", () => {
    // Oslo, the reported bug. The bucket was one station until the Entur
    // enrichment added Oslo Airport Gardermoen to a via list; the average of the
    // two then sat 18.6 km outside Oslo, on no station at all.
    const oslo = stop("Oslo S", 59.9104, 10.755);
    const gardermoen = stop("Oslo Airport Gardermoen", 60.1978, 11.0964);
    const anchor = pickAnchorStation(
      [gardermoen, oslo],
      cityData({ "Oslo S": [3, false], "Oslo Airport Gardermoen": [1, true] }),
      lookupId,
    );
    assert.strictEqual(anchor.stop_id, "Oslo S");
    assert.strictEqual(anchor.stop_lat, 59.9104);
  });

  check("a declared main station beats whichever member comes first", () => {
    // "First non-via member" — the old rule — picks the airport for Frankfurt
    // and Gesundbrunnen for Berlin.
    const frankfurt = pickAnchorStation(
      [
        stop("Frankfurt (Main) Flughafen Fernbahnhof", 50.0513, 8.5705),
        stop("Frankfurt(Main)Hbf", 50.1069, 8.6638),
      ],
      cityData({
        "Frankfurt (Main) Flughafen Fernbahnhof": [6, false],
        "Frankfurt(Main)Hbf": [4, false],
      }),
      lookupId,
    );
    assert.strictEqual(frankfurt.stop_id, "Frankfurt(Main)Hbf");
  });

  check("a declared main station beats a busier one", () => {
    // München Ost serves more routes in the payload than München Hbf.
    const munich = pickAnchorStation(
      [stop("München Ost", 48.1273, 11.6049), stop("München Hbf", 48.1402, 11.5586)],
      cityData({ "München Ost": [16, false], "München Hbf": [9, false] }),
      lookupId,
    );
    assert.strictEqual(munich.stop_id, "München Hbf");
  });

  check("a direction is not a rank: Nord is never promoted by its name", () => {
    // The trap in a naive name rule: adding "nord" to the pattern picks
    // Bruxelles Nord over Midi and Paris Gare du Nord over Austerlitz. Asserted
    // by putting Nord FIRST — if the name rule fired for it, it would win from
    // any position; since it does not, the busiest-endpoint rule decides and
    // Midi takes it on route count.
    const brussels = pickAnchorStation(
      [stop("Bruxelles Nord", 50.8598, 4.3606), stop("Bruxelles Midi", 50.8358, 4.3353)],
      cityData({ "Bruxelles Nord": [4, false], "Bruxelles Midi": [6, false] }),
      lookupId,
    );
    assert.strictEqual(brussels.stop_id, "Bruxelles Midi");

    // And a real principal name still beats a direction word beside it.
    const cologne = pickAnchorStation(
      [stop("Köln Süd", 50.917, 6.955), stop("Köln Hbf", 50.9432, 6.9587)],
      cityData({ "Köln Süd": [9, false], "Köln Hbf": [6, false] }),
      lookupId,
    );
    assert.strictEqual(cologne.stop_id, "Köln Hbf");
  });

  check("with no main-station name and no endpoint, the busiest station wins", () => {
    const out = pickAnchorStation(
      [stop("A", 1, 1), stop("B", 2, 2)],
      cityData({ A: [1, true], B: [4, true] }),
      lookupId,
    );
    assert.strictEqual(out.stop_id, "B");
  });

  check("a tie keeps the earlier member, so the anchor cannot flip", () => {
    // With no declared main station and equal route counts the choice is
    // arbitrary — but it must be STABLE, or the dot moves between renders for
    // no reason. It still lands on a real station either way, which is the
    // property that matters.
    const members = [stop("A", 1, 1), stop("B", 2, 2)];
    const cities = cityData({ A: [2, false], B: [2, false] });
    assert.strictEqual(pickAnchorStation(members, cities, lookupId).stop_id, "A");
    assert.strictEqual(pickAnchorStation(members, cities, lookupId).stop_id, "A");
  });

  check("a grouped marker always lands exactly on one of its own stations", () => {
    // The invariant the average broke. Asserted through groupCityMarkers rather
    // than pickAnchorStation, so it covers the wiring and not just the choice.
    const stops = [
      stop("Berlin Hbf", 52.525, 13.3695),
      stop("Berlin Gesundbrunnen", 52.5487, 13.3886),
      stop("Berlin-Spandau", 52.5345, 13.1976),
    ];
    const out = groupCityMarkers(stops, citiesFor(stops.map((s) => s.stop_id)), true, display, lookup);
    assert.strictEqual(out.length, 1);
    const m = out[0];
    assert.ok(
      m.groupedStations.some((s) => s.stop_lat === m.stop_lat && s.stop_lon === m.stop_lon),
      "the marker is not at any member's coordinates",
    );
    assert.strictEqual(m.stop_id, "Berlin Hbf");
  });
}

console.log(`\n[verify-marker-grouping] ${passed} checks passed`);
