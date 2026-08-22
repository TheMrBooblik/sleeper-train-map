// tests/verify-es-normalize.mjs
// Unit tests for the European Sleeper adapter's pure core
// (scripts/adapters/europeansleeper.mjs): the GTFS → journeys reduction, the
// station-coordinate resolution chain, and journey normalization into the
// standard trains-file shape (bare-number keys — BoT view-map names are bare).
//
// The fixture in tests/fixtures/es-gtfs mirrors the real mdb-3107 feed's
// awkward shape: empty route_long_name, no trip_short_name/direction_id, one
// trip and one service_id per operating date, calendar_dates.txt only, retained
// past dates, per-date diversions, and times past 24:00.
// Raw node, no network. Run: npm run verify-es
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import { loadGtfsDir } from "../scripts/lib/gtfs.mjs";
import {
  feedCoordIndex,
  journeysFromGtfs,
  makeStationResolver,
  mergePageOverFeed,
  normalizeEsTrains,
} from "../scripts/adapters/europeansleeper.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "es-gtfs",
);
const TODAY = "2026-06-12";
const ALLOWLIST = ["ES 452", "ES 474", "ES 500", "ES 501", "ES 999", "ES 900"];

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const gtfs = loadGtfsDir(FIXTURE);
const stats = {};
const journeys = journeysFromGtfs(gtfs, {
  routeShortNames: ALLOWLIST,
  today: TODAY,
  stats,
});
const byTrain = Object.fromEntries(journeys.map((j) => [j.train, j]));

check("allowlist: only listed routes are taken; misses are reported", () => {
  // ES 111 is in the feed but not allowlisted; ES 900 is allowlisted but absent.
  assert.deepStrictEqual(stats.matched.sort(), ["ES 452", "ES 474", "ES 500", "ES 501", "ES 999"]);
  assert.deepStrictEqual(stats.unmatched, ["ES 900"]);
  assert.strictEqual(stats.feedRouteCount, 6);
});

check("a route whose dates have all passed is dropped", () => {
  // ES 999 matched the allowlist but only ever ran on 2026-06-01.
  assert.ok(!("ES 999" in byTrain));
  assert.deepStrictEqual(
    journeys.map((j) => j.train).sort(),
    ["ES 452", "ES 474", "ES 500", "ES 501"],
  );
});

check("routing is the modal sequence, not the longest", () => {
  // ES 452 runs a 4-stop routing on 3 future dates and a 6-stop diversion on 1.
  // buildSleeperTrains' "most stations" rule would pick the diversion.
  const stops = byTrain["ES 452"].stops.map((s) => s.name);
  assert.deepStrictEqual(stops, [
    "Praha hl.n.",
    "Dresden Hbf",
    "Antwerpen Centraal",
    "Bruxelles Midi",
  ]);
});

check("past-dated trips can't win, even in the majority", () => {
  // The retired routing has 4 trips against the modal routing's 3, so it would
  // win outright if the date filter regressed. Bad Schandau is its tell.
  assert.ok(!byTrain["ES 452"].stops.some((s) => s.name === "Bad Schandau"));
});

check("station names are canonicalized to Back-on-Track spellings", () => {
  // Emitted here, not downstream: enrich-view-map writes these straight into via_*.
  const stops = byTrain["ES 452"].stops.map((s) => s.name);
  assert.ok(stops.includes("Bruxelles Midi")); // feed: "Bruxelles-Midi - Brussel-Zuid"
  assert.ok(stops.includes("Antwerpen Centraal")); // feed: "Antwerpen-Centraal"
  assert.strictEqual(byTrain["ES 474"].stops[1].name, "Paris Gare du Nord"); // feed: "Gare du Nord"
});

check("times past 24:00 wrap to wall-clock", () => {
  const stops = byTrain["ES 452"].stops;
  assert.strictEqual(stops[0].departure, "18:05");
  assert.strictEqual(stops[2].arrival, "08:43"); // 32:43
  assert.strictEqual(stops[3].arrival, "09:27"); // 33:27
  assert.strictEqual(byTrain["ES 474"].stops[1].arrival, "10:45"); // 34:45
});

check("service days union every future trip, not just the representative", () => {
  // Each operating date has its own service_id here, so reading one trip's
  // calendar would render a single weekday.
  assert.deepStrictEqual(byTrain["ES 452"].calendar.daysOfWeek, ["mon", "wed", "fri"]);
  assert.strictEqual(byTrain["ES 452"].calendar.validFrom, "2026-06-15");
  assert.strictEqual(byTrain["ES 452"].calendar.validUntil, "2026-06-22");
  assert.deepStrictEqual(byTrain["ES 474"].calendar.daysOfWeek, ["mon", "wed"]);
});

check("geometry: GTFS shape when present, station chain otherwise", () => {
  const shaped = polyline.decode(byTrain["ES 452"].polyline);
  assert.strictEqual(shaped.length, 3); // shp_1, not the diversion's shp_2
  assert.ok(Math.abs(shaped[0][0] - 50.082962) < 1e-4);
  assert.ok(Math.abs(shaped[2][1] - 4.336054) < 1e-4);

  // ES 474's trips carry no shape_id, so the chain through its stops is used.
  const chained = polyline.decode(byTrain["ES 474"].polyline);
  assert.strictEqual(chained.length, 2);
  assert.ok(Math.abs(chained[0][0] - 52.524944) < 1e-4);
});

check("station resolver: overrides beat BoT stops, BoT beats the feed", () => {
  const resolve = makeStationResolver({
    botStops: {
      "Praha hl.n.": { stop_name: "Praha hl.n.", stop_lat: 50.083, stop_lon: 14.435 },
      "Dresden Hbf": { stop_name: "Dresden Hbf", stop_lat: 51.04, stop_lon: 13.73 },
      Broken: { stop_name: "Broken", stop_lat: null, stop_lon: 1 },
    },
    overrides: { "praha HL.N.": { lat: 50.0, lon: 14.4 } },
    fallback: { "Dresden Hbf": { lat: 1, lon: 2 }, Roosendaal: { lat: 51.54, lon: 4.458 } },
  });
  assert.deepStrictEqual(resolve("Praha hl.n."), { lat: 50.0, lon: 14.4 });
  assert.deepStrictEqual(resolve("Dresden Hbf"), { lat: 51.04, lon: 13.73 });
  assert.deepStrictEqual(resolve("Roosendaal"), { lat: 51.54, lon: 4.458 }); // feed-only station
  assert.strictEqual(resolve("Broken"), null);
  assert.strictEqual(resolve("Nowhere"), null);
});

check("feed coord index is keyed by canonical name", () => {
  const index = feedCoordIndex(gtfs);
  assert.ok(index["Bruxelles Midi"], "feed's Bruxelles-Midi should be canonicalized");
  assert.ok(Math.abs(index["Bruxelles Midi"].lat - 50.835777) < 1e-4);
});

check("end to end: GTFS → standard trains shape with bare-number keys", () => {
  const trains = normalizeEsTrains(journeys, {
    resolveStation: makeStationResolver({ fallback: feedCoordIndex(gtfs) }),
    today: TODAY,
  });
  assert.deepStrictEqual(Object.keys(trains).sort(), ["452", "474", "500", "501"]);

  const t = trains["452"];
  assert.strictEqual(t.lineName, "452");
  assert.strictEqual(t.operator, "European Sleeper");
  assert.strictEqual(t.frequency, "2026/06/15-06/22: Mon, Wed, Fri");
  assert.strictEqual(t.stations.length, 4);
  assert.ok(t.polyline.length > 0);
  // The T separator is load-bearing: enrich-view-map's toHHMM matches /T(\d{2}:\d{2})/.
  assert.strictEqual(t.stations[0].departure, `${TODAY}T18:05:00`);
  assert.strictEqual(t.stations[0].arrival, `${TODAY}T18:05:00`);
  assert.strictEqual(t.stations[3].arrival, `${TODAY}T09:27:00`);
  assert.deepStrictEqual(t.stations[0].location, {
    latitude: 50.082962,
    longitude: 14.436094,
  });
});

check("normalize: journeys without a number or with <2 stops are dropped", () => {
  const trains = normalizeEsTrains(
    [
      {
        train: "ES 453",
        calendar: "2026: Mon, Wed, Fri",
        stops: [
          { name: "Bruxelles Midi", arrival: null, departure: "19:04" },
          { name: "Praha hl.n.", arrival: "10:56", departure: null },
        ],
      },
      { train: "no-number", stops: [{ name: "A" }, { name: "B" }] },
      { train: "455", stops: [{ name: "only-one" }] },
    ],
    { resolveStation: () => null, today: "2026-06-12" },
  );
  assert.deepStrictEqual(Object.keys(trains), ["453"]);
  const t = trains["453"];
  assert.strictEqual(t.polyline, null); // no geometry supplied
  assert.strictEqual(t.frequency, "2026: Mon, Wed, Fri"); // string calendars pass through
  assert.strictEqual(t.stations[0].departure, "2026-06-12T19:04:00");
  assert.strictEqual(t.stations[0].arrival, null);
  assert.strictEqual(t.stations[0].location, null); // unresolved coords stay null
});

check("normalize: calendar objects render to BoT-style strings", () => {
  const trains = normalizeEsTrains(
    [
      {
        train: "452",
        calendar: {
          daysOfWeek: ["mon", "wed", "fri"],
          validFrom: "2026-01-01",
          validUntil: "2026-12-31",
        },
        stops: [
          { name: "A", departure: "18:04" },
          { name: "B", arrival: "09:27" },
        ],
      },
    ],
    { resolveStation: () => null, today: "2026-06-12" },
  );
  assert.strictEqual(trains["452"].frequency, "2026: Mon, Wed, Fri");
});

check("the December timetable change splits a route into two periods", () => {
  // ES 500 runs Mon/Wed/Fri via Bad Schandau until the change, then Tue/Thu/Sun
  // via Roosendaal. Read as one window it would advertise six weekdays and the
  // December routing; split, each period is itself.
  const j = byTrain["ES 500"];
  assert.deepStrictEqual(j.calendar.daysOfWeek, ["mon", "wed", "fri"]);
  assert.deepStrictEqual(j.stops.map((s) => s.name), [
    "Praha hl.n.",
    "Bad Schandau",
    "Bruxelles Midi",
  ]);
  assert.ok(j.future, "the upcoming period is carried alongside");
  assert.strictEqual(j.future.activeFrom, "2026-12-15");
  assert.deepStrictEqual(j.future.calendar.daysOfWeek, ["tue", "thu", "sun"]);
  assert.deepStrictEqual(j.future.stops.map((s) => s.name), [
    "Praha hl.n.",
    "Roosendaal",
    "Bruxelles Midi",
  ]);
});

check("a change that keeps the days and endpoints is not a second line", () => {
  // ES 501 swaps one intermediate stop in December but runs the same days
  // between the same places. A second line would trace almost exactly the first.
  const j = byTrain["ES 501"];
  assert.deepStrictEqual(j.calendar.daysOfWeek, ["mon", "wed", "fri"]);
  assert.strictEqual(j.future, undefined);
});

check("normalize carries the upcoming period onto the train", () => {
  const trains = normalizeEsTrains(journeys, {
    resolveStation: makeStationResolver({ fallback: feedCoordIndex(gtfs) }),
    today: TODAY,
  });
  assert.strictEqual(trains["500"].future.activeFrom, "2026-12-15");
  assert.strictEqual(trains["500"].future.stations.length, 3);
  assert.ok(trains["500"].future.frequency.includes("Tue, Thu, Sun"));
  assert.ok(trains["500"].frequency.includes("Mon, Wed, Fri"));
  assert.strictEqual(trains["501"].future, undefined);
});

// ── The operator's page laid over the feed ──────────────────────────────────
// europeansleeper.eu is the source of truth for stops and times; the feed keeps
// geometry and fills in trains the page isn't showing yet.

const feedJourney = (train, extra = {}) => ({
  train,
  polyline: `poly_${train.replace(/\D/g, "")}`,
  stops: [
    { name: "Berlin-Spandau", arrival: null, departure: "17:52" },
    { name: "Paris Gare du Nord", arrival: "10:57", departure: null },
  ],
  calendar: { daysOfWeek: ["mon", "wed", "fri"], validFrom: "2026-08-19", validUntil: "2026-12-11" },
  ...extra,
});

const pageJourney = {
  train: "ES 474",
  number: "474",
  stops: [
    { name: "Berlin Gesundbrunnen", arrival: null, departure: "17:25" },
    { name: "Hamburg-Harburg", arrival: "21:47", departure: "21:55" },
    { name: "Paris Nord", arrival: "11:23", departure: null },
  ],
  daysOfWeek: ["mon", "wed", "fri"],
};

check("merge: the page's stops and times replace the feed's", () => {
  const [j] = mergePageOverFeed([feedJourney("ES 474")], [pageJourney]);
  assert.strictEqual(j.timetableSource, "europeansleeper.eu");
  assert.deepStrictEqual(j.stops.map((s) => s.name), [
    "Berlin Gesundbrunnen",
    "Hamburg-Harburg",
    "Paris Nord",
  ]);
  assert.strictEqual(j.stops[0].departure, "17:25");
  assert.strictEqual(j.stops[2].arrival, "11:23");
  // Spandau is the feed's idea alone and must not survive the merge.
  assert.ok(!j.stops.some((s) => s.name.includes("Spandau")));
});

check("merge: geometry stays the feed's", () => {
  // The whole point of keeping GTFS: the page has stop names, not track.
  const [j] = mergePageOverFeed([feedJourney("ES 474")], [pageJourney]);
  assert.strictEqual(j.polyline, "poly_474");
});

check("merge: the feed's validity window survives the page's days", () => {
  // The page states which weekdays a train runs but never a date range, so the
  // range has to come from the feed or the frequency string loses its period.
  const [j] = mergePageOverFeed(
    [feedJourney("ES 474")],
    [{ ...pageJourney, daysOfWeek: ["tue", "thu", "sun"] }],
  );
  assert.deepStrictEqual(j.calendar.daysOfWeek, ["tue", "thu", "sun"]);
  assert.strictEqual(j.calendar.validFrom, "2026-08-19");
  assert.strictEqual(j.calendar.validUntil, "2026-12-11");
});

check("merge: a page train with no stated days keeps the feed's", () => {
  // The Brussels–Milan paragraph names no train number, so 400/401 parse with
  // daysOfWeek null — that must not blank out the days the feed knows.
  const [j] = mergePageOverFeed(
    [feedJourney("ES 400")],
    [{ ...pageJourney, train: "ES 400", number: "400", daysOfWeek: null }],
  );
  assert.deepStrictEqual(j.calendar.daysOfWeek, ["mon", "wed", "fri"]);
});

check("merge: a train the page omits is untouched", () => {
  // ES 400/401 don't run until September, so the page renders nothing for them.
  const feed = feedJourney("ES 400");
  const [j] = mergePageOverFeed([feed], [pageJourney]);
  assert.strictEqual(j.timetableSource, "gtfs");
  assert.deepStrictEqual(j.stops, feed.stops);
  assert.deepStrictEqual(j.calendar, feed.calendar);
});

check("merge: an unreachable page degrades to pure GTFS", () => {
  const feed = [feedJourney("ES 474"), feedJourney("ES 452")];
  for (const empty of [[], null, undefined]) {
    const merged = mergePageOverFeed(feed, empty);
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.every((j) => j.timetableSource === "gtfs"));
    assert.ok(merged.every((j) => j.polyline));
  }
});

check("merge: the upcoming December period stays the feed's", () => {
  // The page can't be asked for a future date, so it has nothing to say here.
  const future = { activeFrom: "2026-12-14", stops: [{ name: "A" }, { name: "B" }] };
  const [j] = mergePageOverFeed([feedJourney("ES 474", { future })], [pageJourney]);
  assert.deepStrictEqual(j.future, future);
});

check("merge: a page train the feed has no route for is reported, not invented", () => {
  // It would have no geometry, and the allowlist is what decides which routes
  // we carry — so it is logged rather than added.
  const lines = [];
  const merged = mergePageOverFeed(
    [feedJourney("ES 474")],
    [pageJourney, { train: "ES 999", number: "999", stops: pageJourney.stops }],
    (m) => lines.push(m),
  );
  assert.strictEqual(merged.length, 1);
  assert.ok(
    lines.some((l) => l.includes("999")),
    `expected a log line naming 999, got ${JSON.stringify(lines)}`,
  );
});

check("merge: provenance reaches the built train", () => {
  const merged = mergePageOverFeed(
    [feedJourney("ES 474"), feedJourney("ES 400")],
    [pageJourney],
  );
  const trains = normalizeEsTrains(merged, { resolveStation: () => null, today: "2026-08-20" });
  assert.strictEqual(trains["474"].timetableSource, "europeansleeper.eu");
  assert.strictEqual(trains["400"].timetableSource, "gtfs");
});

console.log(`\n[verify-es] ${passed} checks passed`);
