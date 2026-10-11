// tests/verify-nj-fares.mjs
// ÖBB Nightjet / EuroNight fares from nightjet.com's price search: Vienna
// dates, the journey priced, reading an answer (berths priced; the seat and
// each figure's product kept beside them), what an answer proves about the
// nights around it, the budgeted calendar pass (the coming week first, every
// night checked against its seat, a block stopping it), the weekly probe's
// URL, and the stamp onto the nj_standalone_ rows. No network.
// Run: npm run verify-nj-fares
//
// The answer fixtures follow the endpoint's published shape (an array of
// { departure, arrival, bestOffers: { se, le, be: { name, price } } }, per
// martinlangbecker/night-train-apis nightjet-api.yaml "Train Price Search");
// they are not captured from nightjet.com, which a dev sandbox cannot reach.

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  berthClasses,
  berthsAtOrBelowSeat,
  buildOffersUrl,
  fetchNjOffers,
  fillNjFareCalendars,
  journeysFromOffers,
  nightsProven,
  NJ_CLASS_BY_OFFER,
  NJ_FARE_NEAR_DAYS,
  offerProduct,
  pricedJourney,
  pricingEnds,
  viennaDate,
  viennaDateTime,
  viennaMidnightMs,
} from "../scripts/lib/nj-fares.mjs";
import { describeBlock, detectBlock, HONEST_USER_AGENT } from "../scripts/lib/http-block.mjs";
import { buildProbeUrl, probeCandidates, probePrices } from "../scripts/adapters/nightjet-offers.mjs";
import { fareWarning, priceTrains } from "../scripts/adapters/nightjet.mjs";
import { sourceHealthRecord } from "../scripts/scrape-data.mjs";
import {
  calendarWindow,
  cheapestClass,
  cheapestNight,
  FARE_CALENDAR_BUDGET,
  FARE_CALENDAR_DAYS,
  FARE_CALENDAR_VERSION,
  planFareSearches,
} from "../scripts/lib/fare-calendar.mjs";
import { datedBookingHref, fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { buildBookingUrl, buildDatedBookingLink } from "../src/lib/operatorBooking.js";
import { fareClassLabel, fareClassRows } from "../src/lib/fareClasses.mjs";
import { stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const TODAY = "2026-10-07";

/** A departure at 19:08 Vienna time on `date`, as nightjet.com writes it. */
function evening(date, clock = "19:08") {
  // October 2026 until the 25th is summer time (+02:00), after it +01:00.
  const offset = date < "2026-10-25" || date >= "2027-03-28" ? "+02:00" : "+01:00";
  return `${date}T${clock}:00${offset}`;
}

function journey(date, { le = 59.9, be = 99.9, se = 29.9 } = {}) {
  const bestOffers = {};
  if (se != null) bestOffers.se = { name: "Sparschiene", price: se };
  if (le != null) bestOffers.le = { name: "Sparschiene inkl. Reservierung", price: le };
  if (be != null) bestOffers.be = { name: "Sparschiene inkl. Reservierung", price: be };
  return { departure: evening(date), arrival: evening(date, "23:59"), bestOffers };
}

const TRAIN = {
  lineName: "NJ 40491",
  stations: [
    { id: "8002553", name: "Hamburg-Altona" },
    { id: "8000261", name: "München Hbf" },
    { id: "8100108", name: "Innsbruck Hbf" },
  ],
};

await check("viennaMidnightMs / viennaDate: Vienna's calendar, across both clock changes", () => {
  assert.strictEqual(new Date(viennaMidnightMs("2026-10-20")).toISOString(), "2026-10-19T22:00:00.000Z");
  // 25 October: clocks go back at 03:00, so midnight is still summer time.
  assert.strictEqual(new Date(viennaMidnightMs("2026-10-25")).toISOString(), "2026-10-24T22:00:00.000Z");
  assert.strictEqual(new Date(viennaMidnightMs("2026-10-26")).toISOString(), "2026-10-25T23:00:00.000Z");
  assert.strictEqual(new Date(viennaMidnightMs("2027-03-28")).toISOString(), "2027-03-27T23:00:00.000Z");
  assert.strictEqual(viennaMidnightMs("not a date"), null);
  assert.strictEqual(viennaDate("2026-10-20T19:08:00+02:00"), "2026-10-20");
  // 22:30 UTC is half past midnight in Vienna: the next day.
  assert.strictEqual(viennaDate("2026-10-07T22:30:00Z"), "2026-10-08");
  assert.strictEqual(viennaDate(viennaMidnightMs("2026-11-02")), "2026-11-02");
  assert.strictEqual(viennaDate(viennaMidnightMs("2026-11-02") - 1), "2026-11-01");
  assert.strictEqual(viennaDate({ utc: 1760461680000, local: "2025-10-14T19:08:00" }), "2025-10-14");
  assert.strictEqual(viennaDate("tomorrow"), null);
  assert.strictEqual(viennaDate("08.10.2026 19:08"), null, "not 10 August: only ISO date-times are read");
  assert.strictEqual(viennaDate(null), null);
});

await check("buildOffersUrl: the train name encoded, Vienna midnight in ms, three journeys forward", () => {
  assert.strictEqual(
    buildOffersUrl({ trainName: "NJ 40491", fromId: "8002553", toId: "8100108", date: "2026-10-20" }),
    "https://www.nightjet.com/nj-booking-ocp/destinations/offers/NJ%2040491/8002553/8100108/" +
      `${Date.parse("2026-10-19T22:00:00Z")}?forward=true&max=3`,
  );
});

await check("buildProbeUrl: the weekly probe asks the same price search the calendar does", () => {
  assert.strictEqual(
    buildProbeUrl({ lineName: "NJ 40491", from: "8002553", to: "8100108", date: "2026-10-20" }),
    buildOffersUrl({ trainName: "NJ 40491", fromId: "8002553", toId: "8100108", date: "2026-10-20" }),
  );
  assert.ok(!buildProbeUrl({ lineName: "NJ 1", from: "8100002", to: "8103000", date: "2026-10-20" }).includes("/connection/"));
});

await check("pricingEnds: the train's own ends, a car-train terminal swapped for the station beside it", () => {
  assert.deepStrictEqual(pricingEnds(TRAIN), {
    fromId: "8002553", toId: "8100108", from: "Hamburg-Altona", to: "Innsbruck Hbf", substituted: false,
  });
  const carTrain = {
    stations: [
      { id: "8100004", name: "Wien Hbf (Autoreisezuganlage)" },
      { id: "8103000", name: "Wien Hbf" },
      { id: "8100090", name: "Bregenz Bahnhof" },
    ],
  };
  assert.deepStrictEqual(pricingEnds(carTrain), {
    fromId: "8103000", toId: "8100090", from: "Wien Hbf", to: "Bregenz Bahnhof", substituted: true,
  });
  const reversed = { stations: [...carTrain.stations].reverse() };
  assert.strictEqual(pricingEnds(reversed).toId, "8103000");
  // A qualifier whose neighbour is another station is the train's real end.
  const tief = { stations: [{ id: "8098160", name: "Berlin Hbf (tief)" }, { id: "8011113", name: "Berlin Südkreuz" }, { id: "8503000", name: "Zürich HB" }] };
  assert.strictEqual(pricingEnds(tief).fromId, "8098160");
  assert.strictEqual(pricingEnds({ stations: [{ id: "NSR:1", name: "A" }, { id: "8100108", name: "B" }] }), null);
  assert.strictEqual(pricingEnds({ stations: [{ id: "8100108", name: "A" }] }), null);
  assert.strictEqual(pricingEnds(null), null);
});

await check("pricingEnds: every committed NJ/EN train is priceable, and only the car trains substitute", () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"));
  const trains = file.data?.trains ?? file.trains;
  const unpriced = Object.keys(trains).filter((k) => !pricingEnds(trains[k]));
  assert.deepStrictEqual(unpriced, []);
  for (const [key, train] of Object.entries(trains)) {
    const ends = pricingEnds(train);
    if (!ends.substituted) continue;
    const names = train.stations.map((s) => s.name);
    assert.ok(
      [names[0], names.at(-1)].some((n) => /\(Autoreisezuganlage\)$/.test(n)),
      `${key} substituted without a car-train terminal: ${names[0]} … ${names.at(-1)}`,
    );
  }
});

await check("berthClasses: couchette and one sleeper bed priced, the seat left out", () => {
  const { classes, offerNames, seen } = berthClasses({
    se: { name: "Sparschiene", price: 29.9 },
    le: { name: "Sparschiene inkl. Reservierung", price: 59.9 },
    be: { name: "Komfortticket inkl. Reservierung", price: "119,90" },
  });
  assert.deepStrictEqual(classes, { couchette: 59.9, sleeperBed: 119.9 });
  assert.deepStrictEqual(seen, ["se", "le", "be"]);
  assert.deepStrictEqual(offerNames, ["Sparschiene inkl. Reservierung", "Komfortticket inkl. Reservierung"]);
  assert.deepStrictEqual(Object.values(NJ_CLASS_BY_OFFER).sort(), ["couchette", "sleeperBed"]);
  assert.deepStrictEqual(berthClasses({ se: { price: 29.9 } }).classes, {});
  assert.deepStrictEqual(berthClasses({ le: { price: 0 }, be: { price: null } }).classes, {});
  assert.deepStrictEqual(berthClasses(null).classes, {});
});

await check("journeysFromOffers: a list of journeys by Vienna date; an error object is not 'no train'", () => {
  const answer = journeysFromOffers([
    journey("2026-10-20"),
    journey("2026-10-22", { le: null, be: null }),
    { departure: "garbage", bestOffers: { le: { price: 1 } } },
  ]);
  assert.deepStrictEqual(answer.dates, ["2026-10-20", "2026-10-22"]);
  assert.deepStrictEqual(answer.nights["2026-10-20"].classes, { couchette: 59.9, sleeperBed: 99.9 });
  assert.deepStrictEqual(answer.nights["2026-10-22"].classes, {});
  assert.strictEqual(answer.unreadable, 1);
  assert.strictEqual(answer.rows, 3);
  assert.deepStrictEqual(answer.seen, ["be", "le", "se"]);
  // One journey object on its own, and two journeys on one date keep the cheaper.
  assert.deepStrictEqual(journeysFromOffers(journey("2026-10-20")).dates, ["2026-10-20"]);
  const twice = journeysFromOffers([journey("2026-10-20", { le: 79.9 }), journey("2026-10-20", { le: 69.9, be: 89.9 })]);
  assert.deepStrictEqual(twice.nights["2026-10-20"].classes, { couchette: 69.9, sleeperBed: 89.9 });
  assert.deepStrictEqual(journeysFromOffers([]).dates, []);
  assert.throws(() => journeysFromOffers({ errorCode: "NJ-400", message: "bad station" }), /unexpected answer/);
  assert.throws(() => journeysFromOffers("<html>"), (err) => err.shape === true);
});

await check("nightsProven: returned nights priced, skipped nights before the last one have no train", () => {
  const answer = journeysFromOffers([
    journey("2026-10-20"),
    journey("2026-10-22", { le: null, be: null }), // seats only: nothing to sleep in
    journey("2026-10-24", { be: null }),
  ]);
  const out = nightsProven(answer, { from: "2026-10-19", today: TODAY });
  // Each entry also says why a night has no fare, and carries the night's seat
  // price and products beside its classes (the contract's checking fields).
  assert.deepStrictEqual(out["2026-10-19"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  assert.deepStrictEqual(out["2026-10-20"], {
    classes: { couchette: 59.9, sleeperBed: 99.9 },
    checkedAt: TODAY,
    // That night's own clocks, for the Book link.
    dep: "2026-10-20T19:08",
    arr: "2026-10-20T23:59",
    seat: 29.9,
    offers: { couchette: "Sparschiene", sleeperBed: "Sparschiene" },
  });
  assert.deepStrictEqual(out["2026-10-21"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  assert.deepStrictEqual(out["2026-10-22"], { none: true, checkedAt: TODAY, reason: "noBerth", seat: 29.9 });
  assert.deepStrictEqual(out["2026-10-24"], {
    classes: { couchette: 59.9 },
    checkedAt: TODAY,
    dep: "2026-10-24T19:08",
    arr: "2026-10-24T23:59",
    seat: 29.9,
    offers: { couchette: "Sparschiene" },
  });
  // After the last journey returned, nothing is known: the next request starts there.
  assert.strictEqual(out["2026-10-25"], undefined);
  assert.strictEqual(out["2026-10-18"], undefined, "before the night asked about");
  assert.deepStrictEqual(Object.keys(out).sort(), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
});

await check("nightsProven: nothing from that night on, or the next journey past the window, empties the rest", () => {
  const window = calendarWindow(TODAY);
  const empty = nightsProven(journeysFromOffers([]), { from: "2026-10-30", today: TODAY });
  assert.deepStrictEqual(Object.keys(empty), window.filter((d) => d >= "2026-10-30"));
  assert.ok(Object.values(empty).every((e) => e.none));
  // NJ 235 starts with the December timetable: its first journey is past the window.
  const later = nightsProven(journeysFromOffers([journey("2026-12-13")]), { from: "2026-10-08", today: TODAY });
  assert.deepStrictEqual(Object.keys(later), window);
  assert.ok(Object.values(later).every((e) => e.none));
});

await check("nightsProven: one empty answer never erases a night the calendar already prices", () => {
  // EN 40417 (Przemyśl → München), 10 October 2026: a daily train answered one
  // request with nothing, and the rest of its window became "no train" — 37
  // priced nights, 16 of them read hours earlier, while EN 40416 priced every
  // night the other way. The night asked about is the answer's own; the rest
  // keep their prices until a request about them answers.
  const held = {
    "2026-10-30": { classes: { couchette: 64.9 }, checkedAt: "2026-10-05" },
    "2026-10-31": { none: true, checkedAt: "2026-10-05", reason: "noBerth" },
    "2026-11-02": { classes: { couchette: 89.9 }, checkedAt: "2026-10-06" },
  };
  const out = nightsProven(journeysFromOffers([]), { from: "2026-10-30", today: TODAY, held });
  assert.deepStrictEqual(out["2026-10-30"], { none: true, checkedAt: TODAY, reason: "noJourney" }, "the night asked about");
  assert.strictEqual(out["2026-11-02"], undefined, "a priced night is not overwritten by inference");
  assert.deepStrictEqual(out["2026-10-31"], { none: true, checkedAt: TODAY, reason: "noJourney" }, "a night without a price is");
  assert.deepStrictEqual(out["2026-11-01"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  // A night the forward search jumped over is direct evidence, held price or not.
  const gap = nightsProven(journeysFromOffers([journey("2026-11-03")]), { from: "2026-11-01", today: TODAY, held });
  assert.deepStrictEqual(gap["2026-11-02"], { none: true, checkedAt: TODAY, reason: "noJourney" });
});

/**
 * A fake nightjet.com: per train, the dates it runs and their fares. `perAnswer`
 * caps the journeys one answer holds whatever `max` asks — 1 is what the live
 * endpoint did on its first run (2026-10-07), the notes' 3 the ceiling.
 */
function fakeNightjet(timetable, { status = {}, log = [], perAnswer = 3 } = {}) {
  return async (url) => {
    const m = url.match(/\/destinations\/offers\/([^/]+)\/(\d{7})\/(\d{7})\/(\d+)\?forward=true&max=(\d)/);
    assert.ok(m, `unexpected URL ${url}`);
    const train = decodeURIComponent(m[1]);
    const from = viennaDate(Number(m[4]));
    log.push({ train, from, fromId: m[2], toId: m[3] });
    const forced = typeof status[train] === "function" ? status[train]() : status[train];
    if (forced) {
      return { ok: false, status: forced, text: async () => (forced === 200 ? "" : `{"message":"refused ${forced}"}`) };
    }
    const runs = (timetable[train] ?? []).filter(([d]) => d >= from).slice(0, Math.min(Number(m[5]), perAnswer));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(runs.map(([d, fares]) => journey(d, fares))),
    };
  };
}

function everyNight(fromDate, n, fares = {}) {
  const out = [];
  let d = fromDate;
  for (let i = 0; i < n; i++) {
    out.push([d, typeof fares === "function" ? fares(i) : fares]);
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

await check("fillNjFareCalendars: a daily train's six weeks in a third as many requests", async () => {
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const log = [];
  const fetchImpl = fakeNightjet(
    { "NJ 40491": everyNight("2026-10-08", 60, (i) => ({ le: i === 10 ? 39.9 : 59.9 + i, be: 99.9 })) },
    { log },
  );
  const stats = await fillNjFareCalendars(trains, null, { today: TODAY, fetchImpl, spacingMs: 0, log: () => {} });
  assert.strictEqual(stats.requests, 14);
  assert.strictEqual(stats.priced, 42);
  assert.strictEqual(stats.none, 0);
  const cal = trains["NJ 40491"].fareCalendar;
  assert.strictEqual(cal.version, FARE_CALENDAR_VERSION);
  assert.strictEqual(cal.currency, "EUR");
  assert.deepStrictEqual(Object.keys(cal.nights), calendarWindow(TODAY));
  // The headline is the cheapest night, and each class keeps its own night.
  const fare = trains["NJ 40491"].fare;
  assert.strictEqual(fare.fromPrice, 39.9);
  assert.strictEqual(fare.seatClass, "couchette");
  assert.strictEqual(fare.travelDate, "2026-10-18");
  assert.strictEqual(fare.classes.sleeperBed, 99.9);
  assert.strictEqual(fare.classDates.sleeperBed, "2026-10-08");
  assert.strictEqual(fare.currency, "EUR");
  // Every request names the train's own ends, from Vienna midnight of the night asked.
  assert.ok(log.every((r) => r.train === "NJ 40491" && r.fromId === "8002553" && r.toId === "8100108"));
  assert.deepStrictEqual(log.slice(0, 3).map((r) => r.from), ["2026-10-08", "2026-10-11", "2026-10-14"]);
});

await check("fillNjFareCalendars: one journey per answer, as live — a night a request, reasons logged", async () => {
  const runs = everyNight("2026-10-08", 60).map(([d], i) => [d, i % 5 === 1 ? { le: null, be: null } : {}]);
  const trains = { "NJ 40491": structuredClone(TRAIN), "NJ 402": { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] } };
  const lines = [];
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet(
      { "NJ 40491": runs, "NJ 402": runs.filter((_, i) => i % 2 === 0) },
      { perAnswer: 1 },
    ),
    spacingMs: 0,
    log: (l) => lines.push(l),
  });
  // A daily train: every night its own request. Every other night: the skipped
  // night is settled by the answer for the next, so about half as many — 22,
  // the last asking about 18 Nov and answered with the 19th, past the window.
  assert.strictEqual(Object.keys(trains["NJ 40491"].fareCalendar.nights).length, 42);
  assert.strictEqual(Object.keys(trains["NJ 402"].fareCalendar.nights).length, 42);
  assert.strictEqual(stats.requests, 42 + 22);
  // Seats-only nights (every fifth from the second: 9 of 42) are on sale but have no berth.
  assert.deepStrictEqual(trains["NJ 40491"].fareCalendar.nights["2026-10-09"], {
    none: true, checkedAt: TODAY, reason: "noBerth", seat: 29.9,
  });
  const nj40491 = lines.find((l) => l.startsWith("[nj-fare] NJ 40491:") && l.includes("priced"));
  assert.ok(/ 33\/42 night\(s\) priced/.test(nj40491), nj40491);
  assert.ok(nj40491.includes("tonight: 9 on sale without a berth, 0 without a journey"), nj40491);
  const nj402 = lines.find((l) => l.startsWith("[nj-fare] NJ 402:") && l.includes("priced"));
  // A running train asked about the window's last night is not "past the calendar".
  assert.ok(!lines.some((l) => l.startsWith("[nj-fare] NJ 402: next journey")), lines.join("\n"));
  assert.ok(nj402.includes("(tonight: 4 on sale without a berth, 21 without a journey)"), nj402);
});

await check("fillNjFareCalendars: a 3×/week train, a train not yet running, and the budget", async () => {
  const runs = everyNight("2026-10-08", 60).filter((_, i) => i % 7 === 0 || i % 7 === 2 || i % 7 === 4);
  const trains = {
    "NJ 402": { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] },
    "NJ 235": { stations: [{ id: "8103000", name: "Wien Hbf" }, { id: "8300262", name: "Rom Tiburtina" }] },
  };
  const lines = [];
  const fetchImpl = fakeNightjet({ "NJ 402": runs, "NJ 235": everyNight("2026-12-13", 30) });
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY, fetchImpl, spacingMs: 0, log: (l) => lines.push(l),
  });
  const nights = trains["NJ 402"].fareCalendar.nights;
  assert.strictEqual(Object.keys(nights).length, 42);
  assert.deepStrictEqual(nights["2026-10-09"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  assert.ok(nights["2026-10-10"].classes);
  // One request settles all six weeks for a train whose service starts later.
  const nj235 = trains["NJ 235"].fareCalendar.nights;
  assert.strictEqual(Object.keys(nj235).length, 42);
  assert.ok(Object.values(nj235).every((e) => e.none));
  assert.strictEqual(trains["NJ 235"].fare, undefined);
  assert.ok(lines.some((l) => l.includes("NJ 235: next journey on sale is 2026-12-13")));
  assert.ok(stats.requests <= 16, `requests ${stats.requests}`);

  // A tight budget stops the pass and says so; the nights it reached stay.
  const tight = { "NJ 40491": structuredClone(TRAIN) };
  const capped = await fillNjFareCalendars(tight, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60) }),
    spacingMs: 0,
    requests: 2,
    log: () => {},
  });
  assert.strictEqual(capped.requests, 2);
  assert.strictEqual(capped.capped, true);
  assert.strictEqual(Object.keys(tight["NJ 40491"].fareCalendar.nights).length, 6);
});

await check("fillNjFareCalendars: a flaky empty answer keeps last run's prices and tonight's own answers", async () => {
  const window = calendarWindow(TODAY);
  // Every night priced on an earlier run; the near week stale, so it is asked first.
  const previousNights = {};
  for (const d of window) previousNights[d] = { classes: { couchette: 70 }, checkedAt: "2026-10-05" };
  const previous = { "EN 40417": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: previousNights } } };
  const trains = { "EN 40417": { ...structuredClone(TRAIN), lineName: "EN 40417" } };
  const log = [];
  const lines = [];
  // Runs every night; the answer about the 9th comes back empty once.
  const daily = fakeNightjet({ "EN 40417": everyNight("2026-10-08", 60, { le: 55 }) }, { log, perAnswer: 1 });
  const fetchImpl = async (url) => {
    const from = viennaDate(Number(url.match(/\/(\d{13})\?/)[1]));
    if (from !== "2026-10-09") return daily(url);
    log.push({ from });
    return { ok: true, status: 200, text: async () => "[]" };
  };
  await fillNjFareCalendars(trains, previous, {
    today: TODAY, fetchImpl, spacingMs: 0, requests: 3, log: (l) => lines.push(l),
  });
  const nights = trains["EN 40417"].fareCalendar.nights;
  assert.deepStrictEqual(log.map((r) => r.from), ["2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.strictEqual(nights["2026-10-08"].classes.couchette, 55, "read tonight");
  assert.strictEqual(nights["2026-10-09"].reason, "noJourney", "the empty answer's own night");
  assert.strictEqual(nights["2026-10-10"].classes.couchette, 55, "the next request reads its own night");
  // The rest keep the price an earlier run read, rather than turning into "no train".
  const kept = window.filter((d) => d > "2026-10-10");
  assert.strictEqual(kept.length, 39);
  assert.ok(kept.every((d) => nights[d].classes?.couchette === 70), "earlier prices kept");
  assert.ok(lines.some((l) => /EN 40417: nothing on sale from 2026-10-09 on .*except 40 priced on an earlier run/.test(l)), lines.join("\n"));

  // Tonight's own answer outranks what a later empty answer infers: the 20th
  // is never-checked and asked before the stale 15th, which answers nothing.
  // The 20th sells seats only, so no held price protects it — only the rule.
  const prev2 = {};
  for (const d of window) if (d !== "2026-10-20") prev2[d] = { none: true, checkedAt: "2026-10-05", reason: "noBerth" };
  for (const d of window.slice(0, 7)) prev2[d] = { none: true, checkedAt: TODAY, reason: "noBerth" };
  const order = [];
  const t2 = { "EN 40417": { ...structuredClone(TRAIN), lineName: "EN 40417" } };
  await fillNjFareCalendars(t2, { "EN 40417": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: prev2 } } }, {
    today: TODAY,
    fetchImpl: async (url) => {
      const from = viennaDate(Number(url.match(/\/(\d{13})\?/)[1]));
      order.push(from);
      const body = from === "2026-10-20" ? [journey("2026-10-20", { le: null, be: null })] : [];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
    spacingMs: 0,
    requests: 2,
    log: () => {},
  });
  assert.deepStrictEqual(order, ["2026-10-20", "2026-10-15"]);
  const n2 = t2["EN 40417"].fareCalendar.nights;
  assert.deepStrictEqual(n2["2026-10-20"], { none: true, checkedAt: TODAY, reason: "noBerth", seat: 29.9 }, "tonight's answer stands");
  assert.strictEqual(n2["2026-10-15"].reason, "noJourney");
  assert.strictEqual(n2["2026-10-21"].reason, "noJourney", "unpriced nights are still inferred");
});

await check("fillNjFareCalendars: last night's calendar is built on, tonight's nights are not asked twice", async () => {
  const previousNights = {};
  for (const d of calendarWindow(TODAY).slice(0, 39)) previousNights[d] = { classes: { couchette: 70 }, checkedAt: "2026-10-06" };
  // Older than 14 days: dropped rather than shown.
  previousNights["2026-11-17"] = { classes: { couchette: 10 }, checkedAt: "2026-09-01" };
  const previous = { "NJ 40491": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: previousNights } } };
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const log = [];
  const stats = await fillNjFareCalendars(trains, previous, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60, { le: 55 }) }, { log }),
    spacingMs: 0,
    requests: 2,
    // The shared planner's own order. Nightjet's default puts the coming
    // week first; the check after the next one covers that.
    nearDays: 0,
    log: () => {},
  });
  // Never-checked nights first: the last three, then the stalest from the start.
  assert.deepStrictEqual(log.map((r) => r.from), ["2026-11-16", "2026-10-08"]);
  const nights = trains["NJ 40491"].fareCalendar.nights;
  assert.strictEqual(nights["2026-11-17"].classes.couchette, 55);
  assert.strictEqual(nights["2026-10-08"].classes.couchette, 55);
  assert.strictEqual(nights["2026-10-12"].classes.couchette, 70, "kept from last night");
  assert.strictEqual(trains["NJ 40491"].fare.fromPrice, 55);
  assert.strictEqual(stats.requests, 2);
  // A calendar written under another version is not trusted at all.
  const stale = { "NJ 40491": { fareCalendar: { version: 1, currency: "EUR", nights: previousNights } } };
  const fresh = { "NJ 40491": structuredClone(TRAIN) };
  await fillNjFareCalendars(fresh, stale, { today: TODAY, fetchImpl: async () => { throw new Error("offline"); }, spacingMs: 0, retryDelayMs: 0, log: () => {} });
  assert.strictEqual(fresh["NJ 40491"].fare, undefined);
});

await check("fillNjFareCalendars: a refused train is skipped, a server error retried once, a run of failures stops", async () => {
  const trains = {
    "NJ 40491": structuredClone(TRAIN),
    "EN 40237": { stations: [{ id: "8000096", name: "Stuttgart Hbf" }, { id: "7800020", name: "Zagreb Glavni Kolod." }] },
  };
  let flaky = 0;
  const lines = [];
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet(
      { "NJ 40491": everyNight("2026-10-08", 60), "EN 40237": everyNight("2026-10-08", 60) },
      { status: { "EN 40237": 400, "NJ 40491": () => (flaky++ === 0 ? 503 : 0) } },
    ),
    spacingMs: 0,
    retryDelayMs: 1,
    log: (l) => lines.push(l),
  });
  assert.strictEqual(stats.retries, 1);
  assert.strictEqual(Object.keys(trains["NJ 40491"].fareCalendar.nights).length, 42);
  assert.strictEqual(trains["EN 40237"].fareCalendar, undefined);
  assert.strictEqual(stats.errors, 1, "EN 40237 is asked once, then left for tonight");
  assert.ok(lines.some((l) => l.includes("EN 40237 2026-10-08: HTTP 400") && l.includes("refused 400")));

  // Five failures that are not a block (an answer that is no journey list)
  // stop the pass too. A block page stops it at the first: see further down.
  const many = {};
  for (let i = 0; i < 8; i++) many[`NJ ${400 + i}`] = structuredClone(TRAIN);
  const stopped = await fillNjFareCalendars(many, null, {
    today: TODAY,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"errorCode":"NJ-500","message":"no offers"}' }),
    spacingMs: 0,
    log: () => {},
  });
  assert.strictEqual(stopped.stopped, true);
  assert.strictEqual(stopped.errors, 5);
  assert.strictEqual(stopped.retries, 0, "a shape error is not retried");
  assert.strictEqual(stopped.blocked, null, "an error answer is not a block");
});

await check("fillNjFareCalendars: an answer that ignores the night asked blanks nothing", async () => {
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const lines = [];
  // A search that always answers from today, whatever moment it is given.
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([journey("2026-10-01"), journey("2026-10-02")]),
    }),
    spacingMs: 0,
    log: (l) => lines.push(l),
  });
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.none, 0);
  assert.strictEqual(trains["NJ 40491"].fareCalendar, undefined);
  assert.ok(lines.some((l) => l.includes("answered only journeys before 2026-10-08")));
});

await check("fillNjFareCalendars: a departure it cannot read is an error, not an empty answer", async () => {
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const lines = [];
  // One journey per answer, its departure in a format the reader does not know:
  // read as "no journey" it would blank all 42 nights in one request.
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ ...journey("2026-10-08"), departure: "08.10.2026 19:08" }]),
    }),
    spacingMs: 0,
    log: (l) => lines.push(l),
  });
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.none, 0, "no night marked as having no train");
  assert.strictEqual(stats.retries, 0, "a shape error is not retried");
  assert.strictEqual(trains["NJ 40491"].fareCalendar, undefined);
  assert.ok(lines.some((l) => l.includes("1 of 1 journey(s) without a readable departure")), lines.join("\n"));
});

await check("fetchNjOffers: HTTP errors carry status and body; HTML is a shape error", async () => {
  await assert.rejects(
    fetchNjOffers({ trainName: "NJ 1", fromId: "8100002", toId: "8103000", date: "2026-10-20" }, {
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad" }),
    }),
    (err) => err.status === 400 && err.body === "bad",
  );
  await assert.rejects(
    fetchNjOffers({ trainName: "NJ 1", fromId: "8100002", toId: "8103000", date: "2026-10-20" }, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<!doctype html>" }),
    }),
    (err) => err.shape === true,
  );
});

await check("probeCandidates: live nj_standalone_ routes with priceable ends", () => {
  const entry = { output: "nightjet-trains.json" };
  const seen = new Set(["nj_standalone_NJ_40491", "nj_standalone_NJ_19946"]);
  const candidates = probeCandidates(entry, { rootDir: ROOT, seenRoutes: seen });
  const byLine = Object.fromEntries(candidates.map((c) => [c.lineName, c]));
  assert.deepStrictEqual(Object.keys(byLine).sort(), ["NJ 19946", "NJ 40491"]);
  assert.strictEqual(byLine["NJ 19946"].from, "8103000", "Wien Hbf, not the car-train terminal");
});

await check("probePrices: a train the calendar prices is never sampled (its proposal would change nothing)", async () => {
  const entry = { output: "nightjet-trains.json", probe: { pricing: { sampleRoutes: 4 } } };
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"));
  const all = file.data?.trains ?? file.trains;
  const key = (name) => `nj_standalone_${name.replace(/\s+/g, "_")}`;
  const priced = Object.keys(all).filter((name) => all[name].fare && pricingEnds(all[name]));
  assert.ok(priced.length > 0, "the committed trains file carries calendar-priced trains");
  const seen = new Set(priced.map(key));
  const candidates = probeCandidates(entry, { rootDir: ROOT, seenRoutes: seen });
  assert.strictEqual(candidates.length, priced.length);
  assert.ok(candidates.every((c) => c.priced));
  // Every live route is priced, so nothing is left to sample, and no request
  // is made (there is no network here: one would throw).
  const out = await probePrices(entry, { rootDir: ROOT, seenRoutes: seen, prices: {} });
  assert.deepStrictEqual(out, { prices: [], attempted: 0, errors: [] });
});

await check("stampOfficialFares: an nj_standalone_ row takes each direction's fare and calendar", async () => {
  const trains = { "NJ 40491": structuredClone(TRAIN), "NJ 40420": structuredClone(TRAIN) };
  await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({
      "NJ 40491": everyNight("2026-10-08", 60, { le: 69.9, be: 109.9 }),
      "NJ 40420": everyNight("2026-10-08", 60, { le: 49.9, be: null }),
    }),
    spacingMs: 0,
    log: () => {},
  });
  const viewMap = {
    nj_standalone_NJ_40491: {
      route_id: "nj_standalone_NJ_40491",
      agency_id: "ÖBB",
      timetable_source: "nightjet",
      trip_short_name_0: "NJ 40491",
      trip_short_name_1: "NJ 40420",
    },
  };
  const registry = [{ id: "nightjet", enabled: true, official: true }];
  assert.strictEqual(stampOfficialFares(viewMap, {}, { nightjet: trains }, registry), 1);
  const row = viewMap.nj_standalone_NJ_40491;
  assert.strictEqual(row.fare_0.fromPrice, 69.9);
  assert.deepStrictEqual(row.fare_0.classes, { couchette: 69.9, sleeperBed: 109.9 });
  assert.strictEqual(row.fare_0.source, "nightjet");
  assert.strictEqual(row.fare_1.fromPrice, 49.9);
  assert.strictEqual(Object.keys(row.fare_calendar_0.nights).length, 42);
  assert.strictEqual(row.pricing.fromPrice, 49.9);
  assert.strictEqual(row.pricing.trainName, "NJ 40420");
  assert.strictEqual(row.pricing.type, "dynamic", "ÖBB's operator-pricing record");
  assert.strictEqual(row.pricing.seatClass, "couchette");

  // The page: both classes labelled, "from" because the fare is dynamic.
  assert.strictEqual(fareClassLabel("sleeperBed"), "Sleeper, one bed");
  const rows = fareClassRows(row.fare_0, { from: true });
  assert.deepStrictEqual(rows.map((r) => r.label), ["Couchette", "Sleeper, one bed"]);
  const view = fareCalendarDays(row.fare_calendar_0, { today: TODAY });
  assert.strictEqual(view.days.length, 42);
  assert.deepStrictEqual(view.days[0].classes.map((c) => c.label), ["Couchette", "Sleeper, one bed"]);
  assert.strictEqual(view.cheapestDate, "2026-10-08");
});

// --- The calendar's Book button: ÖBB's shop, on the night picked ------------

/** A train as the timetable scrape stores it: 7-digit ids, UTC ISO times. */
const AMS_SBG = {
  lineName: "NJ 40421",
  stations: [
    { id: "8400058", name: "Amsterdam Centraal", departure: "2026-10-07T16:01:00.000Z" },
    { id: "8000105", name: "Frankfurt(Main)Hbf", arrival: "2026-10-07T21:00:00.000Z", departure: "2026-10-07T21:05:00.000Z" },
    { id: "8100002", name: "Salzburg Hbf", arrival: "2026-10-08T04:46:00.000Z" },
  ],
};

/**
 * ÖBB's own link for this journey: the "Tickets" clickout its Scotty/HAFAS
 * timetable answered with for NJ 40421 on 7 December 2026 (a recorded
 * TripSearch response, henemm/oebb-nightjet-monitor
 * testdata/tripsearch_ams_sbg_2026-12-07.json, 2026-10-02). Ours differs in
 * the language path and the referrer only.
 */
const OEBB_CLICKOUT =
  "https://shop.oebbtickets.at/de/ticket?cref=scotty&connectionDatetimeDeparture=2026-12-07T18:01" +
  "&connectionDatetimeArrival=2026-12-08T06:46&connectionOrigEva=8400058&connectionDestEva=8100002" +
  "&stationOrigName=Amsterdam%20Centraal&stationDestName=Salzburg%20Hbf";

/** A journey as nightjet.com answers it, departing and arriving when told. */
function journeyAt(departure, arrival, fares = {}) {
  return { ...journey(departure.slice(0, 10), fares), departure, arrival };
}

await check("viennaDateTime: an answer's instant as Vienna wall-clock time, the shop's shape", () => {
  assert.strictEqual(viennaDateTime("2026-10-07T16:01:00.000Z"), "2026-10-07T18:01");
  assert.strictEqual(viennaDateTime("2026-12-07T18:01:00+01:00"), "2026-12-07T18:01");
  assert.strictEqual(viennaDateTime({ utc: Date.parse("2026-12-08T05:46:00Z") }), "2026-12-08T06:46");
  // The night the clocks go back: 01:30 UTC is 02:30 CET, after the change.
  assert.strictEqual(viennaDateTime("2026-10-25T01:30:00Z"), "2026-10-25T02:30");
  assert.strictEqual(viennaDateTime("08.10.2026 19:08"), null);
});

await check("journeysFromOffers / nightsProven: each priced night keeps its own departure and arrival", () => {
  const answer = journeysFromOffers([
    journeyAt("2026-10-08T18:01:00+02:00", "2026-10-09T06:46:00+02:00"),
    // Works: the same train leaves 25 minutes later two nights on.
    journeyAt("2026-10-10T18:26:00+02:00", "2026-10-11T07:20:00+02:00"),
    journeyAt("2026-10-11T18:01:00+02:00", "2026-10-12T06:46:00+02:00", { le: null, be: null }),
  ]);
  assert.deepStrictEqual(
    [answer.nights["2026-10-08"].dep, answer.nights["2026-10-08"].arr],
    ["2026-10-08T18:01", "2026-10-09T06:46"],
  );
  const proven = nightsProven(answer, { from: "2026-10-08", today: TODAY });
  assert.strictEqual(proven["2026-10-08"].dep, "2026-10-08T18:01");
  assert.strictEqual(proven["2026-10-10"].dep, "2026-10-10T18:26", "a works night keeps its own clock");
  assert.strictEqual(proven["2026-10-10"].arr, "2026-10-11T07:20");
  // A night with no train, and one with no berth, carry no clocks (nothing to book).
  assert.deepStrictEqual(proven["2026-10-09"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  assert.deepStrictEqual(proven["2026-10-11"], { none: true, checkedAt: TODAY, reason: "noBerth", seat: 29.9 });
  // An arrival that cannot be read, or one before the departure, leaves the night unclocked.
  const odd = journeysFromOffers([{ ...journey("2026-10-08"), arrival: "tomorrow" }]);
  assert.strictEqual(odd.nights["2026-10-08"].dep, undefined);
});

await check("pricedJourney: the priced ends by id and ÖBB's own name, the car-train terminal swapped", () => {
  assert.deepStrictEqual(pricedJourney(AMS_SBG), {
    fromId: "8400058",
    toId: "8100002",
    from: "Amsterdam Centraal",
    to: "Salzburg Hbf",
  });
  const carTrain = {
    stations: [
      { id: "8100004", name: "Wien Hbf (Autoreisezuganlage)" },
      { id: "8103000", name: "Wien Hbf" },
      { id: "8100090", name: "Bregenz Bahnhof" },
    ],
  };
  assert.strictEqual(pricedJourney(carTrain).fromId, "8103000", "booked where it is priced");
  assert.strictEqual(pricedJourney({ stations: [{ id: "8400058", name: "Amsterdam Centraal" }] }), null);
});

await check("pricedJourney: every committed NJ/EN calendar records its ends, and the page carries them", () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"));
  const trains = file.data?.trains ?? file.trains;
  const calendared = Object.entries(trains).filter(([, t]) => t.fareCalendar);
  assert.ok(calendared.length > 40);
  for (const [key, train] of calendared) {
    assert.deepStrictEqual(train.fareCalendar.journey, pricedJourney(train), `${key}'s recorded journey`);
  }
  const published = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"));
  const rows = Object.values(published.data.viewMap).filter((r) => r.timetable_source === "nightjet");
  let calendars = 0;
  for (const row of rows) {
    for (const dir of [0, 1]) {
      const cal = row[`fare_calendar_${dir}`];
      if (!cal) continue;
      calendars++;
      assert.deepStrictEqual(cal.journey, trains[row[`trip_short_name_${dir}`]].fareCalendar.journey);
    }
  }
  assert.ok(calendars > 40, `${calendars} published Nightjet calendars`);
});

await check("buildDatedBookingLink: ÖBB opens the priced train on the night picked, as ÖBB's own timetable does", () => {
  const nights = { "2026-12-07": { classes: { couchette: 59.9 }, dep: "2026-12-07T18:01", arr: "2026-12-08T06:46" } };
  const link = buildDatedBookingLink({
    agencyId: "ÖBB",
    origin: "Amsterdam Centraal",
    dest: "Salzburg Hbf",
    journey: pricedJourney(AMS_SBG),
    nightTimes: (iso) => nights[iso] ?? null,
  });
  assert.ok(link, "ÖBB has a journey link");
  const times = link.timesFor("2026-12-07");
  const href = datedBookingHref(link.template, {
    bookingDate: link.dateFor("2026-12-07"),
    bookingDeparture: times.departure,
    bookingArrival: times.arrival,
  });
  const ours = new URL(href);
  const theirs = new URL(OEBB_CLICKOUT);
  assert.strictEqual(ours.host, theirs.host);
  assert.strictEqual(ours.pathname, "/en/ticket");
  // Every parameter ÖBB sends, with ÖBB's value — the referrer aside.
  const params = (u) => [...u.searchParams].filter(([k]) => k !== "cref");
  assert.deepStrictEqual(params(ours), params(theirs));
  assert.strictEqual(ours.searchParams.get("cref"), "pingwi");
  // Byte for byte where it matters: a literal colon, %20 in the names.
  assert.ok(href.includes("connectionDatetimeDeparture=2026-12-07T18:01&"), href);
  assert.ok(href.includes("stationOrigName=Amsterdam%20Centraal&"), href);
});

await check("buildDatedBookingLink: a night without its own clocks, or a journey short of an end, gets no dated link", () => {
  const journeyEnds = pricedJourney(AMS_SBG);
  const args = { agencyId: "ÖBB", origin: "Amsterdam Centraal", dest: "Salzburg Hbf" };
  const nights = {
    "2026-12-07": { dep: "2026-12-07T18:01", arr: "2026-12-08T06:46" },
    "2026-12-08": { classes: { couchette: 59.9 } }, // priced before nights kept their clocks
    "2026-12-09": { dep: "2026-12-10T18:01", arr: "2026-12-11T06:46" }, // another night's
    "2026-12-10": { dep: "2026-12-10T18:01", arr: "2026-12-10T17:00" }, // arrives before it leaves
    "2026-12-11": { dep: "2026-12-11T18:1", arr: "2026-12-12T06:46" },
  };
  const link = buildDatedBookingLink({ ...args, journey: journeyEnds, nightTimes: (iso) => nights[iso] ?? null });
  assert.deepStrictEqual(link.timesFor("2026-12-07"), { departure: "2026-12-07T18:01", arrival: "2026-12-08T06:46" });
  for (const iso of ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12"]) {
    assert.strictEqual(link.timesFor(iso), null, iso);
  }
  // No journey (or no way to read the nights): the plain ÖBB search has no date.
  assert.strictEqual(buildDatedBookingLink(args), null);
  assert.strictEqual(buildDatedBookingLink({ ...args, journey: journeyEnds }), null);
  for (const broken of [
    { ...journeyEnds, fromId: "008400058" },
    { ...journeyEnds, toId: undefined },
    { ...journeyEnds, to: "" },
  ]) {
    assert.strictEqual(buildDatedBookingLink({ ...args, journey: broken, nightTimes: () => null }), null);
  }
  // The route's ordinary CTA is untouched: station names, no date.
  assert.strictEqual(
    buildBookingUrl(args),
    "https://shop.oebbtickets.at/en/ticket?stationOrigName=Amsterdam&stationDestName=Salzburg%20Hbf&cref=pingwi",
  );
  // An operator without a journey link ignores one (Trenitalia keeps its own dated link).
  const trenitalia = buildDatedBookingLink({ agencyId: "FS", origin: "Milano Centrale", dest: "Siracusa", journey: journeyEnds, nightTimes: () => null });
  assert.ok(trenitalia.template.endsWith("&departureDate={date}"));
  assert.strictEqual(trenitalia.timesFor("2026-12-07"), null);
});

await check("datedBookingHref: a night fills its date, and a connection link its own clocks", () => {
  const template = "https://x/?d={departure}&a={arrival}";
  const night = { bookingDate: "2026-10-20", bookingDeparture: "2026-10-20T18:01", bookingArrival: "2026-10-21T06:46" };
  assert.strictEqual(datedBookingHref(template, night), "https://x/?d=2026-10-20T18:01&a=2026-10-21T06:46");
  // No clocks for a link that names a connection: no link, never another night's.
  assert.strictEqual(datedBookingHref(template, { ...night, bookingDeparture: null }), null);
  assert.strictEqual(datedBookingHref(template, { ...night, bookingArrival: null }), null);
  // A date-only template (European Sleeper, Trenitalia) needs no clocks.
  assert.strictEqual(datedBookingHref("https://y/?d={date}", { bookingDate: "20-10-2026" }), "https://y/?d=20-10-2026");
  assert.strictEqual(datedBookingHref(null, night), null);
  assert.strictEqual(datedBookingHref(template, null), null);
  assert.strictEqual(datedBookingHref(template, { ...night, bookingDate: null }), null);
});

await check("the connection page: a Nightjet night links its own departure, or falls back to the route search", () => {
  const published = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"));
  const rows = Object.values(published.data.viewMap).filter((r) => r.timetable_source === "nightjet");
  let calendars = 0;
  let dated = 0;
  let undated = 0;
  for (const row of rows) {
    for (const dir of [0, 1]) {
      const calendar = row[`fare_calendar_${dir}`];
      if (!calendar) continue;
      calendars++;
      // What src/lib/seo/data.js fareCalendarFor does for this direction.
      const link = buildDatedBookingLink({
        agencyId: row.agency_id,
        origin: row[`origin_trip_${dir}`],
        dest: row[`destination_trip_${dir}`],
        journey: calendar.journey,
        nightTimes: (iso) => calendar.nights?.[iso] ?? null,
      });
      assert.ok(link, `${row.route_id} dir ${dir} has a journey link`);
      const view = fareCalendarDays(calendar, { today: TODAY, bookingDate: link.dateFor, bookingTimes: link.timesFor });
      for (const night of view?.days ?? []) {
        const href = datedBookingHref(link.template, night);
        const own = calendar.nights[night.date];
        if (!own?.dep) {
          assert.strictEqual(href, null, `${row.route_id} ${night.date} has no clock of its own, so no dated link`);
          undated++;
          continue;
        }
        const url = new URL(href);
        assert.strictEqual(url.searchParams.get("connectionDatetimeDeparture"), own.dep);
        assert.strictEqual(url.searchParams.get("connectionDatetimeArrival"), own.arr);
        assert.ok(own.dep.startsWith(`${night.date}T`));
        assert.strictEqual(url.searchParams.get("connectionOrigEva"), calendar.journey.fromId);
        assert.strictEqual(url.searchParams.get("connectionDestEva"), calendar.journey.toId);
        dated++;
      }
    }
  }
  assert.ok(calendars > 40, `${calendars} calendars`);
  console.log(`      (${dated} night(s) dated from their own clocks, ${undated} waiting for a re-check)`);
  // The page wires it: the journey and each night's clocks into the link, the
  // component filling them, and each calendar's own direction as fallback.
  const dataSrc = fs.readFileSync(path.join(ROOT, "src/lib/seo/data.js"), "utf8");
  assert.ok(/journey:\s*calendar\.journey/.test(dataSrc), "fareCalendarFor passes the priced journey");
  assert.ok(/nightTimes:\s*\(iso\)\s*=>\s*calendar\.nights/.test(dataSrc), "…and each night's own clocks");
  assert.ok(/bookingTimes:\s*link \? link\.timesFor/.test(dataSrc), "…into the calendar's nights");
  assert.ok(/dir\.fareCalendar\.bookingHref\s*=/.test(dataSrc), "each calendar gets its own direction's fallback");
  const pageSrc = fs.readFileSync(path.join(ROOT, "src/components/seo/FareCalendar.js"), "utf8");
  assert.ok(/datedBookingHref\(bookingTemplate, night\)/.test(pageSrc), "FareCalendar fills the night through datedBookingHref");
  assert.ok(/calendar\.bookingHref \|\| bookingHref/.test(pageSrc), "…and prefers its own direction's fallback");
});

await check("fillNjFareCalendars: the calendar records the journey it priced, each night its own clocks", async () => {
  const trains = { "NJ 40421": structuredClone(AMS_SBG) };
  await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40421": everyNight("2026-10-08", 60) }),
    spacingMs: 0,
    log: () => {},
  });
  const cal = trains["NJ 40421"].fareCalendar;
  assert.deepStrictEqual(cal.journey, pricedJourney(AMS_SBG));
  // fakeNightjet's journeys leave 19:08 and arrive 23:59 the same evening.
  assert.deepStrictEqual([cal.nights["2026-10-08"].dep, cal.nights["2026-10-08"].arr], ["2026-10-08T19:08", "2026-10-08T23:59"]);
  assert.ok(Object.values(cal.nights).filter((n) => !n.none).every((n) => n.dep && n.arr));
});

// --- What a night keeps so its figure can be checked -----------------------
// The seat price, the ÖBB product each figure is, and why a night has no fare.

await check("offerProduct / berthClasses: each berth figure names its ÖBB product; the seat is kept beside, never a class", () => {
  assert.strictEqual(offerProduct("Sparschiene inkl. Reservierung"), "Sparschiene");
  assert.strictEqual(offerProduct("Sparschiene Komfort inkl. Reservierung"), "Sparschiene Komfort");
  assert.strictEqual(offerProduct("Standard-Ticket inkl. Reservierung"), "Standard-Ticket");
  assert.strictEqual(offerProduct("Komfortticket"), "Komfortticket");
  assert.strictEqual(offerProduct(" inkl. Reservierung"), null);
  assert.strictEqual(offerProduct(null), null);
  const read = berthClasses({
    se: { name: "Sparschiene", price: 29.9 },
    le: { name: "Sparschiene inkl. Reservierung", price: 59.9 },
    be: { name: "Komfortticket inkl. Reservierung", price: "119,90" },
  });
  assert.deepStrictEqual(read.classes, { couchette: 59.9, sleeperBed: 119.9 });
  assert.strictEqual(read.seat, 29.9);
  assert.deepStrictEqual(read.offers, { couchette: "Sparschiene", sleeperBed: "Komfortticket" });
  // A figure the answer named no product for carries none; no seat, no seat price.
  const bare = berthClasses({ le: { price: 49.9 } });
  assert.deepStrictEqual(bare.offers, {});
  assert.strictEqual(bare.seat, null);
  assert.strictEqual(berthClasses({ SE: { price: "19,90" } }).seat, 19.9, "keys read case-insensitively, as the berths' are");
});

await check("journeysFromOffers: two journeys one night — each class keeps its own figure's product, the cheaper seat", () => {
  const run = (clock, bestOffers) => ({ departure: evening("2026-10-20", clock), arrival: evening("2026-10-20", "23:59"), bestOffers });
  const night = journeysFromOffers([
    run("19:08", {
      se: { name: "Sparschiene", price: 39.9 },
      le: { name: "Komfortticket inkl. Reservierung", price: 79.9 },
      be: { name: "Sparschiene inkl. Reservierung", price: 89.9 },
    }),
    run("21:15", {
      se: { name: "Sparschiene", price: 34.9 },
      le: { name: "Sparschiene inkl. Reservierung", price: 69.9 },
      be: { name: "Komfortticket inkl. Reservierung", price: 99.9 },
    }),
  ]).nights["2026-10-20"];
  assert.deepStrictEqual(night.classes, { couchette: 69.9, sleeperBed: 89.9 });
  assert.deepStrictEqual(night.offers, { couchette: "Sparschiene", sleeperBed: "Sparschiene" });
  assert.strictEqual(night.seat, 34.9);
});

await check("fillNjFareCalendars: the file says what each night is — seat, product, and why a night has no fare", async () => {
  // Every other night runs, and every third running night sells seats only.
  // The seat is far cheaper than any berth, so a reader that took it for a
  // class would show it.
  const runs = everyNight("2026-10-08", 60)
    .filter((_, i) => i % 2 === 0)
    .map(([d], i) => [d, i % 3 === 2 ? { le: null, be: null, se: 24.9 } : { se: 9.9 }]);
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const lines = [];
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": runs }, { perAnswer: 1 }),
    spacingMs: 0,
    log: (l) => lines.push(l),
  });
  const nights = trains["NJ 40491"].fareCalendar.nights;
  assert.deepStrictEqual(nights["2026-10-08"], {
    classes: { couchette: 59.9, sleeperBed: 99.9 },
    checkedAt: TODAY,
    dep: "2026-10-08T19:08",
    arr: "2026-10-08T23:59",
    seat: 9.9,
    offers: { couchette: "Sparschiene", sleeperBed: "Sparschiene" },
  });
  assert.deepStrictEqual(nights["2026-10-09"], { none: true, checkedAt: TODAY, reason: "noJourney" });
  assert.deepStrictEqual(nights["2026-10-12"], { none: true, checkedAt: TODAY, reason: "noBerth", seat: 24.9 });
  // Every reader of a price reads `classes`, and no class is the seat.
  const entries = Object.values(nights);
  for (const e of entries.filter((e) => !e.none)) {
    assert.ok(Object.keys(e.classes).every((c) => c === "couchette" || c === "sleeperBed"), JSON.stringify(e));
  }
  const fare = trains["NJ 40491"].fare;
  assert.strictEqual(fare.fromPrice, 59.9, "the seat's €9.90 is never the headline");
  assert.deepStrictEqual(Object.keys(fare.classes).sort(), ["couchette", "sleeperBed"]);
  assert.ok(!("seat" in fare) && !("seat" in fare.classes), JSON.stringify(fare));
  // The per-train log line's reasons are read off the file's own entries.
  const count = (reason) => entries.filter((e) => e.reason === reason).length;
  assert.ok(count("noBerth") > 0 && count("noJourney") > 0);
  const line = lines.find((l) => l.startsWith("[nj-fare] NJ 40491:") && l.includes("priced"));
  assert.ok(line.includes(`(tonight: ${count("noBerth")} on sale without a berth, ${count("noJourney")} without a journey)`), line);
  assert.strictEqual(stats.priced + stats.none, 42);
  assert.strictEqual(stats.seatCompared, stats.priced, "every priced night came with a seat price");
  assert.strictEqual(stats.suspect, 0);
  assert.ok(
    lines.includes(`[nj-fare] seat check: all ${stats.priced} priced night(s) with a seat price cost more than the seat`),
    lines.join("\n"),
  );
});

await check("cheapestNight / stampOfficialFares: a seat cheaper than every berth never reaches a fare", () => {
  const calendar = {
    version: FARE_CALENDAR_VERSION,
    currency: "EUR",
    nights: {
      "2026-10-10": { classes: { couchette: 64.9 }, checkedAt: TODAY, seat: 19.9, offers: { couchette: "Sparschiene" } },
      "2026-10-11": { none: true, checkedAt: TODAY, reason: "noBerth", seat: 14.9 },
    },
  };
  const fare = cheapestNight(calendar);
  assert.strictEqual(fare.fromPrice, 64.9);
  assert.strictEqual(fare.seatClass, "couchette");
  assert.deepStrictEqual(fare.classes, { couchette: 64.9 });
  assert.deepStrictEqual(cheapestClass(calendar.nights["2026-10-10"].classes), ["couchette", 64.9]);
  const trains = { "NJ 40491": { ...structuredClone(TRAIN), fareCalendar: calendar, fare } };
  const viewMap = { r: { route_id: "r", agency_id: "ÖBB", timetable_source: "nightjet", trip_short_name_0: "NJ 40491" } };
  stampOfficialFares(viewMap, {}, { nightjet: trains }, [{ id: "nightjet", enabled: true, official: true }]);
  assert.deepStrictEqual(viewMap.r.fare_0.classes, { couchette: 64.9 });
  assert.strictEqual(viewMap.r.pricing.fromPrice, 64.9);
  assert.deepStrictEqual(fareClassRows(viewMap.r.fare_0, { from: true }).map((r) => r.label), ["Couchette"]);
});

await check("fillNjFareCalendars: a berth at or below its night's seat is kept as read, counted, and named in the log", async () => {
  const fares = (i) =>
    i === 0
      ? { le: 34.9, se: 34.9 } // a couchette at the seat's price
      : i === 1
        ? { le: 59.9, be: 19.9, se: 29.9 } // a sleeper under it
        : {};
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const lines = [];
  const stats = await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60, fares) }),
    spacingMs: 0,
    log: (l) => lines.push(l),
  });
  assert.strictEqual(stats.suspect, 2);
  assert.strictEqual(stats.seatCompared, 42);
  assert.deepStrictEqual(stats.suspects, [
    { key: "NJ 40491", date: "2026-10-08", seat: 34.9, classes: { couchette: 34.9 } },
    { key: "NJ 40491", date: "2026-10-09", seat: 29.9, classes: { sleeperBed: 19.9 } },
  ]);
  // Kept as read: the check flags a figure, it does not overrule nightjet.com.
  const nights = trains["NJ 40491"].fareCalendar.nights;
  assert.strictEqual(nights["2026-10-08"].classes.couchette, 34.9);
  assert.strictEqual(nights["2026-10-09"].classes.sleeperBed, 19.9);
  const said = lines.filter((l) => l.startsWith("[nj-fare] seat check:"));
  assert.strictEqual(said.length, 1, "one summary line");
  assert.ok(said[0].startsWith("[nj-fare] seat check: 2 of 42 priced night(s) cost no more than that night's seat"), said[0]);
  assert.ok(said[0].includes("NJ 40491 2026-10-08 couchette €34.9 ≤ seat €34.9"), said[0]);
  assert.ok(said[0].includes("NJ 40491 2026-10-09 sleeperBed €19.9 ≤ seat €29.9"), said[0]);
  assert.deepStrictEqual(berthsAtOrBelowSeat(nights["2026-10-10"]), []);
  assert.deepStrictEqual(berthsAtOrBelowSeat({ none: true, seat: 10 }), []);
  assert.deepStrictEqual(berthsAtOrBelowSeat({ classes: { couchette: 10 } }), [], "no seat price, nothing to compare");

  // A night of many is named a dozen at a time; one without seats says so.
  const cheap = { "NJ 40491": structuredClone(TRAIN) };
  const many = [];
  await fillNjFareCalendars(cheap, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60, { le: 19.9, se: 29.9 }) }),
    spacingMs: 0,
    log: (l) => many.push(l),
  });
  assert.ok(many.some((l) => l.startsWith("[nj-fare] seat check: 42 of 42") && l.endsWith("; … and 30 more")), many.join("\n"));
  const seatless = [];
  const noSeat = await fillNjFareCalendars({ "NJ 40491": structuredClone(TRAIN) }, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60, { se: null }) }),
    spacingMs: 0,
    log: (l) => seatless.push(l),
  });
  assert.strictEqual(noSeat.seatCompared, 0);
  assert.ok(seatless.includes("[nj-fare] seat check: none of tonight's 42 priced night(s) came with a seat price to compare"));
});

// --- Asking honestly, and stopping when told no ------------------------------

await check("detectBlock: what counts as a refusal, and what does not", () => {
  assert.deepStrictEqual(detectBlock({ status: 403, headers: { "CF-RAY": "8d1f-VIE" } }), {
    status: 403, reason: "HTTP 403", vendor: "cloudflare",
  });
  assert.deepStrictEqual(detectBlock({ status: 200, headers: { "cf-mitigated": "challenge" }, body: "" }), {
    status: 200, reason: "cf-mitigated: challenge", vendor: "cloudflare",
  });
  assert.strictEqual(detectBlock({ status: 522, headers: {} }).vendor, "cloudflare");
  assert.strictEqual(detectBlock({ status: 451, headers: { "x-azure-ref": "20261007T031500Z-1" } }).vendor, "azure");
  // A plain server error, a refused station, and a JSON answer that happens to
  // carry a word from the list are not refusals of an automated client.
  assert.strictEqual(detectBlock({ status: 503, headers: {}, body: "upstream timeout" }), null);
  assert.strictEqual(detectBlock({ status: 400, headers: {}, body: '{"message":"bad station"}' }), null);
  assert.strictEqual(
    detectBlock({ status: 200, headers: { "content-type": "application/json" }, body: '[{"name":"Access Denied Hbf"}]' }),
    null,
  );
  assert.strictEqual(describeBlock({ status: 429, reason: "HTTP 429", vendor: null }), "blocked (HTTP 429)");
  assert.strictEqual(describeBlock(null), "");
});

/** Three refusals a WAF answers an automated client with, and what each reads as. */
const REFUSALS = [
  {
    name: "a Cloudflare 403",
    response: () => ({
      ok: false,
      status: 403,
      headers: new Headers({ "cf-ray": "8d1f2a3b4c5d6e7f-VIE", server: "cloudflare", "content-type": "text/html" }),
      text: async () => "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>",
    }),
    blocked: { status: 403, reason: "HTTP 403", vendor: "cloudflare" },
  },
  {
    name: "a 429",
    response: () => ({
      ok: false,
      status: 429,
      headers: { "retry-after": "60", "content-type": "application/json" },
      text: async () => '{"message":"Too Many Requests"}',
    }),
    blocked: { status: 429, reason: "HTTP 429", vendor: null },
  },
  {
    name: "a 200 challenge page",
    response: () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=UTF-8", server: "cloudflare" }),
      text: async () => '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>',
    }),
    blocked: { status: 200, reason: 'block page ("just a moment")', vendor: "cloudflare" },
  },
  {
    // A 5xx, which the pass would otherwise retry as a server error: from
    // Cloudflare's own range it means the request never reached nightjet.com.
    name: "a Cloudflare 522",
    response: () => ({
      ok: false,
      status: 522,
      headers: new Headers({ "cf-ray": "8d1f2a3b4c5d6e80-VIE", "content-type": "text/html" }),
      text: async () => "<!DOCTYPE html><title>Connection timed out | nightjet.com | Cloudflare</title>",
    }),
    blocked: { status: 522, reason: "HTTP 522 (Cloudflare)", vendor: "cloudflare" },
  },
];

/** nightjet.com answering the first `served` requests, then refusing every one. */
function refusingAfter(served, refusal, timetable = {}) {
  const calls = [];
  const fake = fakeNightjet(timetable);
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length > served ? refusal() : fake(url, init);
  };
  return { fetchImpl, calls };
}

await check("fetchNjOffers: every request says who is asking; a refusal is thrown as a block, not an HTTP error", async () => {
  let sent;
  const answer = await fetchNjOffers({ trainName: "NJ 40491", fromId: "8002553", toId: "8100108", date: "2026-10-20" }, {
    fetchImpl: async (url, init) => {
      sent = init;
      return { ok: true, status: 200, text: async () => JSON.stringify([journey("2026-10-20")]) };
    },
  });
  assert.deepStrictEqual(answer.dates, ["2026-10-20"]);
  assert.strictEqual(sent.headers["user-agent"], HONEST_USER_AGENT);
  assert.strictEqual(sent.headers.accept, "application/json");
  // Our own name and where to reach us; nothing a browser would send.
  assert.deepStrictEqual(Object.keys(sent.headers).sort(), ["accept", "user-agent"]);
  assert.ok(/pingwi\.com/.test(HONEST_USER_AGENT));
  assert.ok(!/mozilla|chrome|safari|applewebkit|gecko/i.test(HONEST_USER_AGENT), HONEST_USER_AGENT);
  await assert.rejects(
    fetchNjOffers({ trainName: "NJ 1", fromId: "8100002", toId: "8103000", date: "2026-10-20" }, {
      fetchImpl: async () => REFUSALS[0].response(),
    }),
    (err) =>
      err.blocked?.vendor === "cloudflare" && err.status === 403 && /blocked by cloudflare \(HTTP 403\)/.test(err.message),
  );
});

for (const refusal of REFUSALS) {
  await check(`fillNjFareCalendars: ${refusal.name} stops the whole pass at its first request — no retry, no next train`, async () => {
    // Last run's calendar for one train; tonight's other two have none yet.
    const previousNights = {};
    for (const d of calendarWindow(TODAY).slice(0, 10)) {
      previousNights[d] = { classes: { couchette: 64.9 }, checkedAt: "2026-10-06", seat: 29.9 };
    }
    const previous = {
      "NJ 40491": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: previousNights } },
    };
    const trains = {
      "NJ 40491": structuredClone(TRAIN),
      "NJ 402": { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] },
      "NJ 235": { stations: [{ id: "8103000", name: "Wien Hbf" }, { id: "8300262", name: "Rom Tiburtina" }] },
    };
    const { fetchImpl, calls } = refusingAfter(0, refusal.response);
    const lines = [];
    const stats = await fillNjFareCalendars(trains, previous, {
      today: TODAY,
      fetchImpl,
      spacingMs: 0,
      // A transient error would be retried after 1 ms: a block must not be.
      retryDelayMs: 1,
      log: (l) => lines.push(l),
    });
    assert.strictEqual(calls.length, 1, "one request, then nothing");
    assert.strictEqual(calls[0].init.headers["user-agent"], HONEST_USER_AGENT);
    assert.strictEqual(stats.requests, 1);
    assert.strictEqual(stats.retries, 0);
    assert.deepStrictEqual(stats.blocked, refusal.blocked);
    assert.strictEqual(stats.stopped, true);
    // Last run's nights are still the calendar, and still its headline.
    assert.deepStrictEqual(trains["NJ 40491"].fareCalendar.nights, previousNights);
    assert.strictEqual(trains["NJ 40491"].fare.fromPrice, 64.9);
    assert.strictEqual(trains["NJ 402"].fareCalendar, undefined);
    const said = lines.filter((l) => l.includes("blocked automated requests"));
    assert.strictEqual(said.length, 1, lines.join("\n"));
    const { reason, vendor } = refusal.blocked;
    assert.ok(
      said[0].startsWith(`[nj-fare] nightjet.com blocked automated requests (${reason}${vendor ? ` by ${vendor}` : ""}) at `),
      said[0],
    );
    assert.ok(said[0].includes("— stopping tonight's fare searches; calendars keep last run's nights"), said[0]);
  });
}

await check("fillNjFareCalendars: a block mid-pass keeps every night filled before it", async () => {
  const { fetchImpl, calls } = refusingAfter(3, REFUSALS[0].response, { "NJ 40491": everyNight("2026-10-08", 60) });
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const stats = await fillNjFareCalendars(trains, null, { today: TODAY, fetchImpl, spacingMs: 0, log: () => {} });
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(stats.requests, 4);
  // Three answers of three journeys each: nine nights, all tonight's.
  const nights = trains["NJ 40491"].fareCalendar.nights;
  assert.deepStrictEqual(Object.keys(nights), calendarWindow(TODAY).slice(0, 9));
  assert.ok(Object.values(nights).every((e) => e.checkedAt === TODAY && e.classes));
  assert.strictEqual(stats.priced, 9);
  assert.strictEqual(trains["NJ 40491"].fare.fromPrice, 59.9);
});

await check("probePrices: the weekly probe asks honestly too, and stops at a refusal rather than trying the next route", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-probe-"));
  try {
    // Two trains the calendar does not price, so both would be sampled.
    const unpriced = {
      "NJ 402": { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] },
      "NJ 235": { stations: [{ id: "8103000", name: "Wien Hbf" }, { id: "8300262", name: "Rom Tiburtina" }] },
    };
    fs.mkdirSync(path.join(rootDir, "public/data/scraped"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "public/data/scraped/nightjet-trains.json"), JSON.stringify({ data: { trains: unpriced } }));
    const calls = [];
    const out = await probePrices(
      { output: "nightjet-trains.json", probe: { pricing: { sampleRoutes: 4 } } },
      {
        rootDir,
        seenRoutes: new Set(["nj_standalone_NJ_402", "nj_standalone_NJ_235"]),
        prices: {},
        fetch: async (url, init) => {
          calls.push(init);
          return REFUSALS[0].response();
        },
      },
    );
    assert.strictEqual(out.attempted, 2);
    assert.strictEqual(calls.length, 1, "the second route is not asked");
    assert.strictEqual(calls[0].headers["user-agent"], HONEST_USER_AGENT);
    assert.strictEqual(out.errors.length, 1);
    assert.ok(/blocked by cloudflare \(HTTP 403\)/.test(out.errors[0]), out.errors[0]);
    assert.deepStrictEqual(out.prices, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

await check("the adapter: a blocked fare pass costs no train, keeps last run's calendars, and warns source-health", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-fares-"));
  try {
    const previousNights = { "2026-10-09": { classes: { couchette: 64.9 }, checkedAt: "2026-10-06" } };
    fs.mkdirSync(path.join(rootDir, "public/data/scraped"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "public/data/scraped/nightjet-trains.json"),
      JSON.stringify({
        data: { trains: { "NJ 40491": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: previousNights } } } },
      }),
    );
    const results = {
      "NJ 40491": structuredClone(TRAIN),
      "NJ 402": { stations: [{ id: "8503000", name: "Zürich HB" }, { id: "8400058", name: "Amsterdam Centraal" }] },
    };
    const calls = [];
    const entry = { output: "nightjet-trains.json", params: { fares: { enabled: true, days: 42, requestsPerRun: 720 } } };
    const stats = await priceTrains(results, entry, {
      today: TODAY,
      rootDir,
      fetch: async (url, init) => {
        calls.push(init);
        return REFUSALS[0].response();
      },
    });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(Object.keys(results).sort(), ["NJ 402", "NJ 40491"], "no train is lost to a fare block");
    assert.deepStrictEqual(results["NJ 40491"].fareCalendar.nights, previousNights);
    assert.deepStrictEqual(stats.blocked, REFUSALS[0].blocked);
    const warning = fareWarning(stats);
    assert.strictEqual(
      warning,
      "fare search blocked by cloudflare (HTTP 403) at request 1 — stopped for the night; calendars keep last run's nights",
    );
    assert.strictEqual(fareWarning(null), null);
    assert.strictEqual(fareWarning({ requests: 700, errors: 2, stopped: false, blocked: null }), null, "an ordinary night");
    assert.strictEqual(fareWarning({ failed: "boom" }), "fare pass failed: boom");
    assert.strictEqual(
      fareWarning({ requests: 9, errors: 5, stopped: true, blocked: null }),
      "fare search stopped after 5 failed request(s) of 9",
    );

    // source-health.json: a warning beside a success, never a failure.
    const now = "2026-10-07T03:20:00.000Z";
    const prior = {
      enabled: true,
      lastRunAt: "2026-10-06T03:20:00.000Z",
      lastSuccessAt: "2026-10-06T03:20:00.000Z",
      lastFailureAt: null,
      lastError: null,
      trainCount: 73,
      consecutiveFailures: 0,
    };
    const nj = { id: "nightjet", enabled: true };
    const warned = sourceHealthRecord(nj, { ok: true, trainCount: 73, warning }, prior, now);
    assert.deepStrictEqual(warned, { ...prior, lastRunAt: now, lastSuccessAt: now, lastWarning: warning, lastWarningAt: now });
    // The next ordinary night keeps the warning on record, dated, beside a newer success.
    const later = "2026-10-08T03:20:00.000Z";
    const next = sourceHealthRecord(nj, { ok: true, trainCount: 73, warning: null }, warned, later);
    assert.strictEqual(next.lastSuccessAt, later);
    assert.strictEqual(next.lastWarning, warning);
    assert.strictEqual(next.lastWarningAt, now);
    // A source that never warned grows no keys; one not run tonight is carried forward.
    assert.ok(!("lastWarning" in sourceHealthRecord(nj, { ok: true, trainCount: 1 }, prior, now)));
    assert.deepStrictEqual(sourceHealthRecord({ enabled: false }, undefined, warned, later), { ...warned, enabled: false });
    // And the run is wired to it: the adapter returns the warning, the runner keeps it.
    const adapterSrc = fs.readFileSync(path.join(ROOT, "scripts/adapters/nightjet.mjs"), "utf8");
    assert.ok(/return warning \? \{ warning \} : null;/.test(adapterSrc), "run() returns the fare warning");
    const runnerSrc = fs.readFileSync(path.join(ROOT, "scripts/scrape-data.mjs"), "utf8");
    assert.ok(/const outcome = await mod\.run\(entry, ctx\);/.test(runnerSrc), "the runner reads run()'s outcome");
    assert.ok(/warning: typeof outcome\?\.warning === "string"/.test(runnerSrc), "…and records its warning");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// --- The coming week first -------------------------------------------------

/**
 * planFareSearches as it was before `nearDays`, verbatim, so the shared
 * default — what Trenitalia and European Sleeper plan with — is held to it.
 */
function legacyPlanFareSearches(calendars, { today, days = FARE_CALENDAR_DAYS, budget = FARE_CALENDAR_BUDGET } = {}) {
  const dates = calendarWindow(today, days);
  const candidates = [];
  for (const key of Object.keys(calendars ?? {}).sort()) {
    const nights = calendars[key]?.nights ?? {};
    dates.forEach((date, i) => {
      const checkedAt = nights[date]?.checkedAt ?? null;
      if (checkedAt === today) return;
      candidates.push({ key, date, i, checkedAt });
    });
  }
  candidates.sort((a, b) => {
    if (!a.checkedAt !== !b.checkedAt) return a.checkedAt ? 1 : -1;
    if (a.checkedAt && a.checkedAt !== b.checkedAt)
      return a.checkedAt < b.checkedAt ? -1 : 1;
    if (a.i !== b.i) return a.i - b.i;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return candidates
    .slice(0, Math.max(0, budget))
    .map(({ key, date }) => ({ key, date }));
}

await check("planFareSearches nearDays: never-checked near nights, then near nights stalest first, then far never-checked, then the rest", () => {
  const calendars = {
    A: {
      nights: {
        "2026-10-08": { checkedAt: "2026-10-05" },
        "2026-10-10": { checkedAt: "2026-10-06" },
        "2026-10-11": { checkedAt: "2026-10-03" },
        "2026-10-13": { checkedAt: TODAY },
      },
    },
    B: { nights: { "2026-10-09": { checkedAt: "2026-10-04" }, "2026-10-12": { checkedAt: "2026-10-01" } } },
  };
  const at = (plan) => plan.map(({ key, date }) => `${key} ${date.slice(5)}`);
  assert.deepStrictEqual(at(planFareSearches(calendars, { today: TODAY, days: 6, budget: 99, nearDays: 3 })), [
    // (0) never checked, within three nights: nearest first, trains interleaved
    "B 10-08", "A 10-09", "B 10-10",
    // (1) within three nights, checked before today: stalest first
    "B 10-09", "A 10-08", "A 10-10",
    // (2) never checked, farther out: nearest first
    "B 10-11", "A 10-12", "B 10-13",
    // (3) the rest, stalest first — and A's night checked today is not redone
    "B 10-12", "A 10-11",
  ]);
  // Without it: never checked nearest first, then every check stalest first,
  // so the coming week's three-day-old checks wait behind a far night's.
  assert.deepStrictEqual(at(planFareSearches(calendars, { today: TODAY, days: 6, budget: 99 })), [
    "B 10-08", "A 10-09", "B 10-10", "B 10-11", "A 10-12", "B 10-13",
    "B 10-12", "A 10-11", "B 10-09", "A 10-08", "A 10-10",
  ]);
  // The budget still cuts the same list.
  assert.deepStrictEqual(at(planFareSearches(calendars, { today: TODAY, days: 6, budget: 4, nearDays: 3 })), [
    "B 10-08", "A 10-09", "B 10-10", "B 10-09",
  ]);
});

await check("planFareSearches: without nearDays, or at 0, the order is byte for byte the one it always was", () => {
  // A seeded LCG, so a failure names a trial that reproduces.
  let seed = 20261007;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const stamps = [null, null, "2026-09-25", "2026-09-30", "2026-10-03", "2026-10-06", TODAY];
  for (let trial = 0; trial < 300; trial++) {
    const days = 1 + Math.floor(rand() * 45);
    const trains = 1 + Math.floor(rand() * 6);
    const calendars = {};
    for (let t = 0; t < trains; t++) {
      const nights = {};
      for (const d of calendarWindow(TODAY, days)) {
        const checkedAt = stamps[Math.floor(rand() * stamps.length)];
        if (checkedAt) nights[d] = rand() < 0.5 ? { classes: { couchette: 50 }, checkedAt } : { none: true, checkedAt };
      }
      calendars[`T ${Math.floor(rand() * 1000)}`] = { nights };
    }
    const budget = Math.floor(rand() * trains * days * 1.2);
    const before = JSON.stringify(legacyPlanFareSearches(calendars, { today: TODAY, days, budget }));
    assert.strictEqual(JSON.stringify(planFareSearches(calendars, { today: TODAY, days, budget })), before, `trial ${trial}`);
    assert.strictEqual(
      JSON.stringify(planFareSearches(calendars, { today: TODAY, days, budget, nearDays: 0 })),
      before,
      `trial ${trial}, nearDays 0`,
    );
  }
});

await check("fillNjFareCalendars: Nightjet refreshes the coming week before anything else", async () => {
  assert.strictEqual(NJ_FARE_NEAR_DAYS, 7);
  // Last night's calendar: 39 nights checked the day before yesterday, the last three never.
  const previousNights = {};
  for (const d of calendarWindow(TODAY).slice(0, 39)) previousNights[d] = { classes: { couchette: 70 }, checkedAt: "2026-10-05" };
  const previous = { "NJ 40491": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: previousNights } } };
  const trains = { "NJ 40491": structuredClone(TRAIN) };
  const log = [];
  await fillNjFareCalendars(trains, previous, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40491": everyNight("2026-10-08", 60, { le: 55 }) }, { log }),
    spacingMs: 0,
    requests: 4,
    log: () => {},
  });
  // Three journeys an answer: the week from tomorrow in three requests, then
  // the far nights never checked — where the shared order would have started.
  assert.deepStrictEqual(log.map((r) => r.from), ["2026-10-08", "2026-10-11", "2026-10-14", "2026-11-16"]);
  const nights = trains["NJ 40491"].fareCalendar.nights;
  assert.strictEqual(nights["2026-10-14"].classes.couchette, 55);
  assert.strictEqual(nights["2026-10-20"].classes.couchette, 70, "a farther night keeps last run's check");
  // The nightly adapter passes it on, overridable as params.fares.nearDays.
  const adapterSrc = fs.readFileSync(path.join(ROOT, "scripts/adapters/nightjet.mjs"), "utf8");
  assert.ok(/nearDays = NJ_FARE_NEAR_DAYS/.test(adapterSrc) && /\bnearDays,\n/.test(adapterSrc), "the adapter threads it through");
});

console.log(`\nverify-nj-fares: ${passed} checks passed`);
