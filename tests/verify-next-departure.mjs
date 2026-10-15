// tests/verify-next-departure.mjs
// A train on sale but not running now says when it runs again.
//
// nightjet.com answers "this train, today" with the train's next journey. EN
// 1276/1277 Rijeka–Warszawa, a summer EuroNight whose 2026 season ended on
// 28/30 August, came back dated June 2027 — and the row dropped that date: the
// map drew it as a running train, the connection page and its Google snippet
// read like any running corridor, and the answer itself arrived thinned (no
// polyline, no Wien stops), so the line ran straight from Wiener Neustadt to
// Ostrava.
//
// Covered here:
//   - src/lib/nextDeparture.mjs: the threshold, the row's next run (every
//     direction or none), the previous season and its word, the formatting;
//   - the build: next_departure_{dir} only past the threshold, and the
//     replaced Back-on-Track row's season as previous_service_{dir};
//   - the adapter: a train whose answer starts later is re-read on that date,
//     and only an answer about the same journey replaces the first;
//   - the map helpers: a faded future line and future-station markers;
//   - the snippet and the FAQ;
//   - nightjet.com's and lefrecce.it's UTC instants as station clocks;
//   - the committed payload's EN 1276/1277.
//
// Raw node, no network. Run: npm run verify-next-departure
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UPCOMING_AFTER_DAYS,
  formatDayDate,
  formatSeasonRange,
  previousSeason,
  rowNextDeparture,
  seasonWord,
  upcomingDepartureForTrain,
  upcomingRun,
} from "../src/lib/nextDeparture.mjs";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
import { validateRegistry } from "../scripts/lib/registry.mjs";
import { fetchTrainForNextRun, richerAnswer } from "../scripts/adapters/nightjet.mjs";
import {
  getFutureRouteStartDate,
  upcomingPreviewRouteIds,
} from "../src/components/Map/utils/routeStyleUtils.js";
import { CONTROL, FACTS, connectionSnippet } from "../src/lib/seo/snippet.mjs";
import { buildConnectionFaq } from "../src/lib/seo/routeFaq.mjs";
import { getStationTimesForTrain, stationClock } from "../src/lib/seo/stationTimes.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const REGISTRY = readJson("data/sources/registry.json");
const NJ_ENTRY = REGISTRY.find((e) => e.id === "nightjet");
const TODAY = "2026-10-15";

// ── nextDeparture.mjs ────────────────────────────────────────────────────────

const train = (departure, lastSeenAt = "2026-10-15T08:22:18.147Z") => ({
  lastSeenAt,
  stations: [{ name: "A", departure }, { name: "B", arrival: departure }],
});

await check("a next run is stamped only past the threshold, on the Vienna calendar", () => {
  assert.equal(UPCOMING_AFTER_DAYS, 14);
  assert.equal(upcomingDepartureForTrain(train("2027-06-25T12:06:00.000Z")), "2027-06-25");
  assert.equal(upcomingDepartureForTrain(train("2026-10-16T17:06:00.000Z")), null, "running tomorrow");
  assert.equal(upcomingDepartureForTrain(train("2026-10-29T17:00:00.000Z")), null, "14 days is still running");
  assert.equal(upcomingDepartureForTrain(train("2026-10-30T17:00:00.000Z")), "2026-10-30");
  // 23:30 UTC on 12 December is 00:30 on the 13th in Vienna.
  assert.equal(upcomingDepartureForTrain(train("2026-12-12T23:30:00.000Z")), "2026-12-13");
  assert.equal(upcomingDepartureForTrain(train("25.06.2027")), null, "only ISO date-times are read");
  assert.equal(upcomingDepartureForTrain({ stations: [] }), null);
});

const row = (extra = {}) => ({
  route_id: "r",
  trip_short_name_0: "EN 1277",
  origin_trip_0: "Warszawa Wschodnia",
  destination_trip_0: "Rijeka",
  trip_short_name_1: "EN 1276",
  origin_trip_1: "Rijeka",
  destination_trip_1: "Warszawa Wschodnia",
  ...extra,
});

await check("a row is upcoming only when every direction it states runs later", () => {
  const both = row({ next_departure_0: "2027-06-25", next_departure_1: "2027-06-27" });
  assert.equal(rowNextDeparture(both, TODAY), "2027-06-25", "the earliest of the two");
  assert.equal(rowNextDeparture(row({ next_departure_0: "2027-06-25" }), TODAY), null, "the return runs now");
  assert.equal(rowNextDeparture(both, "2027-06-25"), null, "the season has started");
  assert.equal(rowNextDeparture(row(), TODAY), null);
  assert.equal(
    rowNextDeparture({ trip_short_name_0: "NJ 1", next_departure_0: "2027-01-01" }, TODAY),
    "2027-01-01",
    "a one-way row",
  );
});

await check("the previous season spans both directions and names itself only when the dates say it", () => {
  const r = row({
    previous_service_0: "2026/06/28-08/30: Daily, except Saturday",
    previous_service_1: "2026/06/26-08/28: Daily, except Sunday",
  });
  assert.deepEqual(previousSeason(r), { start: "2026-06-26", end: "2026-08-30", days: "" });
  assert.equal(seasonWord(previousSeason(r)), "summer");
  assert.equal(seasonWord({ start: "2026-12-13", end: "2027-03-20" }), "winter");
  assert.equal(seasonWord({ start: "2026-03-01", end: "2026-10-30" }), "", "spring to autumn is no one season");
  assert.equal(formatSeasonRange(previousSeason(r)), "26 Jun – 30 Aug 2026");
  assert.equal(formatSeasonRange({ start: "2026-12-13", end: "2027-03-20" }), "13 Dec 2026 – 20 Mar 2027");
  assert.equal(previousSeason(row({ previous_service_0: "2026: Mon, Wed, Fri" })), null, "no window, no season");
  assert.equal(formatDayDate("2027-06-25"), "Fri 25 Jun 2027");
  assert.equal(formatDayDate("2027-06-27"), "Sun 27 Jun 2027");
});

await check("upcomingRun: seasonal only with a past season, 'not running now' without one", () => {
  const seasonal = upcomingRun(
    row({
      next_departure_0: "2027-06-25",
      next_departure_1: "2027-06-27",
      previous_service_0: "2026/06/28-08/30: Daily, except Saturday",
      previous_service_1: "2026/06/26-08/28: Daily, except Sunday",
    }),
    TODAY,
  );
  assert.equal(seasonal.seasonal, true);
  assert.equal(seasonal.badge, "Summer only");
  assert.equal(seasonal.headline, "Summer seasonal train — next season from 25 Jun 2027");
  assert.deepEqual(
    seasonal.departures.map((d) => `${d.train} ${d.dateText}`),
    ["EN 1277 Fri 25 Jun 2027", "EN 1276 Sun 27 Jun 2027"],
  );
  const bare = upcomingRun(row({ next_departure_0: "2026-12-13", next_departure_1: "2026-12-13" }), TODAY);
  assert.equal(bare.seasonal, false);
  assert.equal(bare.badge, "Not running now");
  assert.equal(bare.headline, "Not running now — next departure 13 Dec 2026");
  assert.equal(upcomingRun(row(), TODAY), null);
});

// ── the build ────────────────────────────────────────────────────────────────

const at = (name, lat, lon, departure) => ({ name, location: { latitude: lat, longitude: lon }, departure, arrival: departure });
const buildWorld = () => ({
  stops: [
    { stop_id: "Rijeka", stop_name: "Rijeka", stop_lat: 45.33, stop_lon: 14.43 },
    { stop_id: "Warszawa Wschodnia", stop_name: "Warszawa Wschodnia", stop_lat: 52.25, stop_lon: 21.05 },
    { stop_id: "Wien Hbf", stop_name: "Wien Hbf", stop_lat: 48.18, stop_lon: 16.38 },
    { stop_id: "Zürich HB", stop_name: "Zürich HB", stop_lat: 47.38, stop_lon: 8.54 },
  ],
  viewMap: {
    113: {
      route_id: 113,
      agency_id: "PKP",
      trip_short_name_0: "EN 1276",
      service_id_0: "2026/06/26-08/28: Daily, except Sunday",
      origin_trip_0: "Rijeka",
      destination_trip_0: "Warszawa Wschodnia",
      trip_short_name_1: "EN 1277",
      service_id_1: "2026/06/28-08/30: Daily, except Saturday",
      origin_trip_1: "Warszawa Wschodnia",
      destination_trip_1: "Rijeka",
      is_active: "Y",
    },
  },
  trips: {},
});
const SEEN = "2026-10-15T08:22:18.147Z";
const buildTrains = () => ({
  "EN 1277": {
    lineName: "EN 1277", operator: "EuroNight", agency_id: "PKP", agencyFrom: "bot", fare: null, polyline: "p1277", lastSeenAt: SEEN,
    stations: [at("Warszawa Wschodnia", 52.25, 21.05, "2027-06-25T12:06:00.000Z"), at("Rijeka", 45.33, 14.43, "2027-06-26T08:00:00.000Z")],
  },
  "EN 1276": {
    lineName: "EN 1276", operator: "EuroNight", agency_id: "PKP", agencyFrom: "bot", fare: null, polyline: "p1276", lastSeenAt: SEEN,
    stations: [at("Rijeka", 45.33, 14.43, "2027-06-27T17:19:00.000Z"), at("Warszawa Wschodnia", 52.25, 21.05, "2027-06-28T12:06:00.000Z")],
  },
  "NJ 470": {
    lineName: "NJ 470", operator: "Nightjet", agency_id: "ÖBB", agencyFrom: "home", fare: null, polyline: "p470", lastSeenAt: SEEN,
    stations: [at("Zürich HB", 47.38, 8.54, "2026-10-15T16:32:00.000Z"), at("Wien Hbf", 48.18, 16.38, "2026-10-16T05:00:00.000Z")],
  },
});
const build = (entry = NJ_ENTRY) => {
  const { stops, viewMap, trips } = buildWorld();
  return buildInitialData({
    stops, viewMap, trips,
    operatorTrains: { nightjet: buildTrains() },
    registry: [{ ...structuredClone(entry), probe: undefined }],
    seenIndex: null,
    routePrices: {},
  }).viewMap;
};

await check("build: an out-of-season train carries its next run and the season it replaced", () => {
  const vm = build();
  assert.equal(vm[113], undefined, "Back-on-Track's row is replaced, as before");
  const r = vm.nj_standalone_EN_1277;
  assert.ok(r, Object.keys(vm).join(", "));
  assert.equal(r.nj_polyline_0, "p1277", "nightjet.com's own line and stops are kept");
  assert.equal(r.next_departure_0, "2027-06-25");
  assert.equal(r.next_departure_1, "2027-06-27");
  assert.equal(r.previous_service_0, "2026/06/28-08/30: Daily, except Saturday", "EN 1277's own season");
  assert.equal(r.previous_service_1, "2026/06/26-08/28: Daily, except Sunday", "EN 1276's own season");
  assert.equal(r.service_id_0, undefined, "never a service string: routeSeasonHasClosed would hide it");
});

await check("build: a running train's row gains nothing, so it does not change nightly", () => {
  const r = build().nj_standalone_NJ_470;
  assert.ok(r);
  assert.equal("next_departure_0" in r, false);
  assert.equal("previous_service_0" in r, false);
});

await check("build: opt-in per source, and the registry rejects a bad zone", () => {
  const off = structuredClone(NJ_ENTRY);
  delete off.synthetic.nextDeparture;
  assert.equal("next_departure_0" in build(off).nj_standalone_EN_1277, false);
  assert.deepEqual(validateRegistry(REGISTRY), []);
  const bad = structuredClone(REGISTRY);
  bad.find((e) => e.id === "nightjet").synthetic.nextDeparture = { timeZone: "Europe/Wein" };
  const errors = validateRegistry(bad);
  assert.ok(errors.some((e) => /nextDeparture\.timeZone/.test(e)), errors.join("; "));
});

// ── the adapter ──────────────────────────────────────────────────────────────

const answer = (departure, { polyline = null, stops = 2 } = {}) => ({
  lineName: "EN 1276",
  polyline,
  stations: Array.from({ length: stops }, (_, i) => ({ name: `S${i}`, departure: i === 0 ? departure : null, arrival: departure })),
});

await check("adapter: a train whose answer starts later is re-read on that date", async () => {
  const asked = [];
  const thin = answer("2027-06-27T17:19:00.000Z", { stops: 27 });
  const full = answer("2027-06-27T17:19:00.000Z", { polyline: "full", stops: 29 });
  const got = await fetchTrainForNextRun("EN 1276", TODAY, async (n, d) => {
    asked.push(d);
    return d === TODAY ? thin : full;
  });
  assert.deepEqual(asked, [TODAY, "2027-06-27"]);
  assert.equal(got, full, "Wien Meidling, Wien Hbf and the polyline come back");
});

await check("adapter: a train running tonight costs one request", async () => {
  let calls = 0;
  const tonight = answer("2026-10-15T16:32:00.000Z", { polyline: "x" });
  const got = await fetchTrainForNextRun("NJ 470", TODAY, async () => (calls++, tonight));
  assert.equal(calls, 1);
  assert.equal(got, tonight);
});

await check("adapter: only an answer about the same journey, and a fuller one, replaces the first", () => {
  const first = answer("2027-06-27T17:19:00.000Z", { stops: 27 });
  assert.equal(richerAnswer(first, null), first, "a failed re-read keeps the first");
  assert.equal(richerAnswer(first, answer("2027-06-29T17:19:00.000Z", { polyline: "x", stops: 29 })), first, "another night's journey");
  assert.equal(richerAnswer(first, answer("2027-06-27T17:19:00.000Z", { stops: 20 })), first, "fewer stops, no line");
  const better = answer("2027-06-27T17:19:00.000Z", { polyline: "x", stops: 20 });
  assert.equal(richerAnswer(first, better), better, "a polyline outweighs stop count");
});

// ── the map ──────────────────────────────────────────────────────────────────

await check("map: the line is a future one and its stops are next season's", () => {
  const r = row({ route_id: "nj_standalone_EN_1277", next_departure_0: "2027-06-25", next_departure_1: "2027-06-27" });
  const now = new Date(2026, 9, 15, 12);
  assert.equal(getFutureRouteStartDate(r.route_id, {}, r), rowNextDeparture(r), "faded, with its date on hover");
  assert.equal(getFutureRouteStartDate(r.route_id, {}), null, "callers without the row behave as before");
  assert.ok(upcomingPreviewRouteIds({ [r.route_id]: r }, now).has(r.route_id));
  assert.equal(upcomingPreviewRouteIds({ x: row({ route_id: "x" }) }, now).size, 0);
});

// ── the snippet and the FAQ ──────────────────────────────────────────────────

const RUN = upcomingRun(
  row({
    next_departure_0: "2027-06-25",
    next_departure_1: "2027-06-27",
    previous_service_0: "2026/06/28-08/30: Daily, except Saturday",
    previous_service_1: "2026/06/26-08/28: Daily, except Sunday",
  }),
  TODAY,
);

await check("snippet: a corridor with nothing running leads with when it runs again, under either variant", () => {
  for (const variant of [CONTROL, FACTS]) {
    const s = connectionSnippet({
      cityA: "Rijeka",
      cityB: "Warsaw",
      trainCount: 1,
      operatorNames: "PKP Intercity",
      variant,
      upcoming: { run: RUN, trainLabel: "EN 1277/1276", operator: "PKP Intercity", stopCount: 29 },
    });
    assert.equal(s.title, "Rijeka to Warsaw Night Train — Summer Only, from 25 Jun 2027");
    assert.ok(s.title.length <= 60);
    assert.match(s.description, /^Summer-only night train: PKP Intercity EN 1277\/1276 runs Rijeka–Warsaw again from 25 June 2027\./);
    assert.match(s.description, /Last season 26 Jun – 30 Aug 2026\./);
    assert.ok(s.description.length <= 160, s.description);
    assert.equal(s.intro, "Run by PKP Intercity. The timetable below is for next season.");
  }
});

await check("snippet: long city names shed the season before the date", () => {
  const s = connectionSnippet({
    cityA: "Mönchengladbach",
    cityB: "Rijeka",
    trainCount: 1,
    upcoming: { run: RUN },
  });
  assert.equal(s.title, "Mönchengladbach to Rijeka Night Train — from 25 Jun 2027");
  const longest = connectionSnippet({ cityA: "Mönchengladbach", cityB: "Constantinople", trainCount: 1, upcoming: { run: RUN } });
  assert.equal(longest.title, "Mönchengladbach to Constantinople Night Train | Pingwi", "never cut mid-date");
});

await check("snippet: without `upcoming` nothing changes", () => {
  const plain = connectionSnippet({ cityA: "Vienna", cityB: "Zurich", trainCount: 2, operatorNames: "ÖBB" });
  assert.equal(plain.title, "Night Trains Vienna to Zurich — Times, Stops & Tickets | Pingwi");
});

await check("FAQ: 'when does it run' comes first, and only when there is something to say", () => {
  const faq = buildConnectionFaq({ originCity: "Rijeka", destCity: "Warsaw", trainCount: 1, seasonText: "Next season from 25 June 2027." });
  assert.equal(faq[0].q, "When does the Rijeka to Warsaw night train run?");
  const plain = buildConnectionFaq({ originCity: "Rijeka", destCity: "Warsaw", trainCount: 1 });
  assert.ok(!plain.some((f) => /When does/.test(f.q)));
});

// ── station clocks ───────────────────────────────────────────────────────────

await check("a feed's UTC instant prints as the station's clock, and nothing else moves", () => {
  assert.equal(stationClock("2027-06-25T12:06:00.000Z", "Europe/Vienna"), "14:06", "CEST");
  assert.equal(stationClock("2026-12-12T23:30:00.000Z", "Europe/Vienna"), "00:30", "CET, past midnight");
  assert.equal(stationClock("2026-10-14T18:25:00+00:00", "Europe/Rome"), "20:25");
  assert.equal(stationClock("22:47", "Europe/Vienna"), "22:47", "a station clock");
  assert.equal(stationClock("2026-10-15T15:45:00", "Europe/Vienna"), "2026-10-15T15:45:00", "no zone: a clock");
  assert.equal(stationClock("2027-06-25T12:06:00.000Z", null), "2027-06-25T12:06:00.000Z", "an unlisted feed");
  const stops = getStationTimesForTrain("EN 1277", { origin: "Warszawa Wschodnia", destination: "Rijeka" });
  if (stops?.[0]?.departure) assert.equal(stops[0].departure, "14:06", "nightjet.com's 12:06Z");
});

// ── the committed payload ────────────────────────────────────────────────────

await check("payload: EN 1276/1277 is a summer train whose next season starts 25 June 2027", () => {
  const vm = readJson("public/data/published/initial-data.json").data.viewMap;
  const r = Object.values(vm).find((x) => x.route_id === "nj_standalone_EN_1277");
  assert.ok(r, "the nightjet.com row is published");
  // Once the 2027 season opens the row runs and carries no date: nothing to pin.
  if (r.next_departure_0 && r.next_departure_0 <= "2027-06-25") {
    const run = upcomingRun(r, TODAY);
    assert.ok(run, "not running in October");
    assert.equal(run.nextDeparture, "2027-06-25");
    assert.equal(run.badge, "Summer only");
    assert.equal(run.previousText, "26 Jun – 30 Aug 2026");
  }
  // Nothing running gains a date: every stamped row's next run is past the
  // threshold of the night it was scraped.
  for (const x of Object.values(vm)) {
    for (const dir of [0, 1]) {
      if (!x[`next_departure_${dir}`]) continue;
      assert.ok(x[`next_departure_${dir}`] > "2026-10-29", `${x.route_id} ${x[`next_departure_${dir}`]}`);
    }
  }
});

console.log(`\nverify-next-departure: ${passed} checks passed`);
