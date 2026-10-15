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
import { borrowTrackGeometry, fetchTrainForNextRun, richerAnswer } from "../scripts/adapters/nightjet.mjs";
import { haversineKm } from "../scripts/lib/sibling-path.mjs";
import polyline from "@mapbox/polyline";
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
  assert.equal(seasonal.headline, "Summer seasonal train, next season from 25 Jun 2027");
  assert.deepEqual(
    seasonal.departures.map((d) => `${d.train} ${d.dateText}`),
    ["EN 1277 Fri 25 Jun 2027", "EN 1276 Sun 27 Jun 2027"],
  );
  const bare = upcomingRun(row({ next_departure_0: "2026-12-13", next_departure_1: "2026-12-13" }), TODAY);
  assert.equal(bare.seasonal, false);
  assert.equal(bare.badge, "Not running now");
  assert.equal(bare.headline, "Not running now, next departure 13 Dec 2026");
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

await check("build: a train pairs with the return in its own period, and a later one cannot take its partner", () => {
  // nightjet.com's Wien–Brussels corridor on 15 October 2026, in feed order:
  // NJ 469 (now), NJ 449 (February, no polyline), NJ 468 (December), NJ 448
  // (now). Paired by feed order, NJ 448 sat on a row with NJ 449 and the map
  // drew February's routing as straight lines over tonight's train.
  const wien = (dep) => at("Wien Hbf", 48.18, 16.38, dep);
  const bru = (dep) => at("Brüssel Midi", 50.84, 4.34, dep);
  const nj = (name, stations, polyline) => ({
    lineName: name, operator: "Nightjet", agency_id: "ÖBB", agencyFrom: "home", fare: null, polyline, lastSeenAt: SEEN, stations,
  });
  const trains = {
    "NJ 469": nj("NJ 469", [bru("2026-10-16T17:06:00.000Z"), wien("2026-10-17T08:00:00.000Z")], "p469"),
    "NJ 449": nj("NJ 449", [bru("2027-02-08T16:56:00.000Z"), wien("2027-02-09T08:00:00.000Z")], "p449"),
    "NJ 468": nj("NJ 468", [wien("2026-12-13T18:36:00.000Z"), bru("2026-12-14T09:00:00.000Z")], "p468"),
    "NJ 448": nj("NJ 448", [wien("2026-10-15T16:13:00.000Z"), bru("2026-10-16T07:59:00.000Z")], "p448"),
  };
  const stops = [
    { stop_id: "Wien Hbf", stop_name: "Wien Hbf", stop_lat: 48.18, stop_lon: 16.38 },
    { stop_id: "Brüssel Midi", stop_name: "Brüssel Midi", stop_lat: 50.84, stop_lon: 4.34 },
  ];
  const vm = buildInitialData({
    stops, viewMap: {}, trips: {}, operatorTrains: { nightjet: trains },
    registry: [{ ...structuredClone(NJ_ENTRY), probe: undefined }], seenIndex: null, routePrices: {},
  }).viewMap;
  const pairOf = (id) => [vm[id]?.trip_short_name_0, vm[id]?.trip_short_name_1].join(" / ");
  assert.equal(pairOf("nj_standalone_NJ_469"), "NJ 469 / NJ 448", "the two running tonight");
  assert.equal(pairOf("nj_standalone_NJ_449"), "NJ 449 / NJ 468", "the two on sale for later");
  assert.equal(vm.nj_standalone_NJ_469.nj_polyline_1, "p448");
  // A later train with no same-period partner does not take a running one's:
  // NJ 429 (February) had taken NJ 420 from NJ 421.
  const ams = (dep) => at("Amsterdam Centraal", 52.38, 4.9, dep);
  const ibk = (dep) => at("Innsbruck Hbf", 47.26, 11.4, dep);
  const vm2 = buildInitialData({
    stops: [...stops, { stop_id: "Amsterdam Centraal", stop_name: "Amsterdam Centraal", stop_lat: 52.38, stop_lon: 4.9 },
      { stop_id: "Innsbruck Hbf", stop_name: "Innsbruck Hbf", stop_lat: 47.26, stop_lon: 11.4 }],
    viewMap: {}, trips: {},
    operatorTrains: { nightjet: {
      "NJ 429": nj("NJ 429", [ams("2027-02-07T18:00:00.000Z"), ibk("2027-02-08T08:00:00.000Z")], "p429"),
      "NJ 421": nj("NJ 421", [ams("2026-10-15T18:00:00.000Z"), ibk("2026-10-16T08:00:00.000Z")], "p421"),
      "NJ 420": nj("NJ 420", [ibk("2026-10-15T19:00:00.000Z"), ams("2026-10-16T09:00:00.000Z")], "p420"),
    } },
    registry: [{ ...structuredClone(NJ_ENTRY), probe: undefined }], seenIndex: null, routePrices: {},
  }).viewMap;
  assert.equal([vm2.nj_standalone_NJ_421?.trip_short_name_0, vm2.nj_standalone_NJ_421?.trip_short_name_1].join(" / "), "NJ 421 / NJ 420");
  assert.equal(vm2.nj_standalone_NJ_429?.trip_short_name_1, undefined, "the February train stands alone");
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
    assert.equal(s.title, "Rijeka to Warsaw Night Train: Summer Only, from 25 Jun 2027");
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
  assert.equal(s.title, "Mönchengladbach to Rijeka Night Train, from 25 Jun 2027");
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

await check("a train sent without a route line is drawn along other trains' track, never as chords", () => {
  const st = (name, lat, lon) => ({ name, location: { latitude: lat, longitude: lon } });
  // A donor riding A → B → C along a bend, and a train calling at A and C only.
  const bend = [];
  for (let i = 0; i <= 40; i++) bend.push([48 + i * 0.01, 14 + Math.sin(i / 8) * 0.05]);
  const trains = {
    "NJ 1": { polyline: polyline.encode(bend), stations: [st("A", 48, 14), st("C", 48.4, bend[40][1])] },
    "NJ 2": {
      polyline: polyline.encode([[48, 14], [48.4, bend[40][1]], [52, 4]]),
      stations: [st("A", 48, 14), st("C", 48.4, bend[40][1]), st("Far", 52, 4)],
    },
  };
  const rebuilt = borrowTrackGeometry(trains, new Set(["NJ 1"]));
  assert.deepEqual(rebuilt, ["NJ 2 (1/2 stretches)"]);
  const drawn = polyline.decode(trains["NJ 2"].polyline);
  assert.ok(drawn.length > 30, "A → C follows the donor's bend");
  assert.deepEqual(drawn.at(-1), [52, 4], "a stretch no donor rides stays a chord, and every stop stays a vertex");
  assert.equal(polyline.decode(trains["NJ 1"].polyline).length, 41, "a line of nightjet.com's own is never rewritten");

  // The committed answer for NJ 449: its line was its 16 stops, and is now track.
  const file = readJson("public/data/scraped/nightjet-trains.json");
  const nj449 = file.trains?.["NJ 449"] ?? file.data?.trains?.["NJ 449"];
  if (nj449) {
    const line = polyline.decode(nj449.polyline);
    assert.ok(line.length > nj449.stations.length * 10, `NJ 449 has ${line.length} vertices for ${nj449.stations.length} stops`);
    let worst = 0;
    for (let i = 0; i < line.length - 1; i++) worst = Math.max(worst, haversineKm(line[i], line[i + 1]));
    assert.ok(worst < 20, `NJ 449's longest straight stretch is ${worst.toFixed(1)} km`);
  }
});

console.log(`\nverify-next-departure: ${passed} checks passed`);
