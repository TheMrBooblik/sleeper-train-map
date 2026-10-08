// tests/verify-nj-fares.mjs
// ÖBB Nightjet / EuroNight fares from nightjet.com's price search: Vienna
// dates, the journey priced, reading an answer (berths only), what an answer
// proves about the nights around it, the budgeted calendar pass, the weekly
// probe's URL, and the stamp onto the nj_standalone_ rows. No network.
// Run: npm run verify-nj-fares
//
// The answer fixtures follow the endpoint's published shape (an array of
// { departure, arrival, bestOffers: { se, le, be: { name, price } } }, per
// martinlangbecker/night-train-apis nightjet-api.yaml "Train Price Search");
// they are not captured from nightjet.com, which a dev sandbox cannot reach.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  berthClasses,
  buildOffersUrl,
  fetchNjOffers,
  fillNjFareCalendars,
  journeysFromOffers,
  nightsProven,
  NJ_CLASS_BY_OFFER,
  pricedJourney,
  pricingEnds,
  viennaDate,
  viennaMidnightMs,
} from "../scripts/lib/nj-fares.mjs";
import { buildProbeUrl, probeCandidates, probePrices } from "../scripts/adapters/nightjet-offers.mjs";
import { calendarWindow, FARE_CALENDAR_VERSION } from "../scripts/lib/fare-calendar.mjs";
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
  assert.deepStrictEqual(out["2026-10-19"], { none: true, checkedAt: TODAY });
  assert.deepStrictEqual(out["2026-10-20"], { classes: { couchette: 59.9, sleeperBed: 99.9 }, checkedAt: TODAY });
  assert.deepStrictEqual(out["2026-10-21"], { none: true, checkedAt: TODAY });
  assert.deepStrictEqual(out["2026-10-22"], { none: true, checkedAt: TODAY });
  assert.deepStrictEqual(out["2026-10-24"], { classes: { couchette: 59.9 }, checkedAt: TODAY });
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
  assert.deepStrictEqual(trains["NJ 40491"].fareCalendar.nights["2026-10-09"], { none: true, checkedAt: TODAY });
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
  assert.deepStrictEqual(nights["2026-10-09"], { none: true, checkedAt: TODAY });
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

  const many = {};
  for (let i = 0; i < 8; i++) many[`NJ ${400 + i}`] = structuredClone(TRAIN);
  const stopped = await fillNjFareCalendars(many, null, {
    today: TODAY,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>Access denied</html>" }),
    spacingMs: 0,
    log: () => {},
  });
  assert.strictEqual(stopped.stopped, true);
  assert.strictEqual(stopped.errors, 5);
  assert.strictEqual(stopped.retries, 0, "a block page is not retried");
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

await check("pricedJourney: the priced ends by id and ÖBB's name, Vienna clocks, the arrival's day", () => {
  // 16:01 UTC in October is 18:01 in Vienna (summer time), 04:46 UTC 06:46.
  assert.deepStrictEqual(pricedJourney(AMS_SBG), {
    fromId: "8400058",
    toId: "8100002",
    from: "Amsterdam Centraal",
    to: "Salzburg Hbf",
    departure: "18:01",
    arrival: "06:46",
    days: 1,
  });
  // The same train read off a winter run keeps its local clock.
  const winter = structuredClone(AMS_SBG);
  winter.stations[0].departure = "2026-12-07T17:01:00.000Z";
  winter.stations[2].arrival = "2026-12-08T05:46:00.000Z";
  assert.deepStrictEqual(
    [pricedJourney(winter).departure, pricedJourney(winter).arrival],
    ["18:01", "06:46"],
  );
  // The car-train terminal is booked from the station beside it, at that
  // station's own departure — the journey the calendar priced.
  const carTrain = {
    stations: [
      { id: "8100004", name: "Wien Hbf (Autoreisezuganlage)", departure: "2026-10-07T20:34:00.000Z" },
      { id: "8103000", name: "Wien Hbf", arrival: "2026-10-07T20:36:00.000Z", departure: "2026-10-07T20:44:00.000Z" },
      { id: "8100090", name: "Bregenz Bahnhof", arrival: "2026-10-08T06:57:00.000Z" },
    ],
  };
  assert.deepStrictEqual(
    [pricedJourney(carTrain).fromId, pricedJourney(carTrain).departure],
    ["8103000", "22:44"],
  );
  // No times, or an arrival before the departure: no journey to book.
  assert.strictEqual(pricedJourney(TRAIN), null);
  const backwards = structuredClone(AMS_SBG);
  backwards.stations[2].arrival = "2026-10-07T04:46:00.000Z";
  assert.strictEqual(pricedJourney(backwards), null);
});

await check("pricedJourney: every committed NJ/EN train with a calendar has one, and the page carries it", () => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/scraped/nightjet-trains.json"), "utf8"));
  const trains = file.data?.trains ?? file.trains;
  const calendared = Object.entries(trains).filter(([, t]) => t.fareCalendar);
  assert.ok(calendared.length > 40);
  for (const [key, train] of calendared) {
    assert.deepStrictEqual(train.fareCalendar.journey, pricedJourney(train), `${key}'s recorded journey`);
    assert.ok([0, 1].includes(train.fareCalendar.journey.days), `${key} arrives ${train.fareCalendar.journey.days} days on`);
  }
  // The published rows carry it with the calendar (stampOfficialFares).
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
  const journey = pricedJourney(AMS_SBG);
  const link = buildDatedBookingLink({
    agencyId: "ÖBB",
    origin: "Amsterdam Centraal",
    dest: "Salzburg Hbf",
    journey,
  });
  assert.ok(link, "ÖBB has a journey link");
  const href = datedBookingHref(link.template, {
    bookingDate: link.dateFor("2026-12-07"),
    bookingArrivalDate: link.arrivalDateFor("2026-12-07"),
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
  // The arrival moves with the night, across a month and a year.
  assert.strictEqual(link.arrivalDateFor("2026-10-31"), "2026-11-01");
  assert.strictEqual(link.arrivalDateFor("2026-12-31"), "2027-01-01");
  assert.strictEqual(link.dateFor("2026-10-31"), "2026-10-31");
});

await check("buildDatedBookingLink: no journey, or one short of anything the link needs, stays undated", () => {
  const journey = pricedJourney(AMS_SBG);
  const args = { agencyId: "ÖBB", origin: "Amsterdam Centraal", dest: "Salzburg Hbf" };
  // The plain ÖBB search has no date, so no journey means no dated link …
  assert.strictEqual(buildDatedBookingLink(args), null);
  // … and so does a journey a wrong train could be booked from.
  for (const broken of [
    { ...journey, departure: "18:1" },
    { ...journey, arrival: "25:00" },
    { ...journey, fromId: "008400058" },
    { ...journey, toId: undefined },
    { ...journey, to: "" },
    { ...journey, days: -1 },
    { ...journey, days: 1.5 },
  ]) {
    assert.strictEqual(buildDatedBookingLink({ ...args, journey: broken }), null, JSON.stringify(broken));
  }
  // The route's ordinary CTA is untouched: station names, no date.
  assert.strictEqual(
    buildBookingUrl(args),
    "https://shop.oebbtickets.at/en/ticket?stationOrigName=Amsterdam&stationDestName=Salzburg%20Hbf&cref=pingwi",
  );
  // An operator without a journey link ignores one (Trenitalia keeps its own dated link).
  const trenitalia = buildDatedBookingLink({ agencyId: "FS", origin: "Milano Centrale", dest: "Siracusa", journey });
  assert.ok(trenitalia.template.endsWith("&departureDate={date}"));
  assert.strictEqual(trenitalia.arrivalDateFor, undefined);
});

await check("datedBookingHref: a night fills its date, and a journey link its arrival too", () => {
  const template = "https://x/?d={date}&a={arrivalDate}";
  assert.strictEqual(
    datedBookingHref(template, { bookingDate: "2026-10-20", bookingArrivalDate: "2026-10-21" }),
    "https://x/?d=2026-10-20&a=2026-10-21",
  );
  // No arrival for a link that names one: no link, never one ending before it starts.
  assert.strictEqual(datedBookingHref(template, { bookingDate: "2026-10-20", bookingArrivalDate: null }), null);
  // A date-only template (European Sleeper, Trenitalia) needs no arrival.
  assert.strictEqual(datedBookingHref("https://y/?d={date}", { bookingDate: "20-10-2026" }), "https://y/?d=20-10-2026");
  assert.strictEqual(datedBookingHref(null, { bookingDate: "2026-10-20" }), null);
  assert.strictEqual(datedBookingHref(template, null), null);
  assert.strictEqual(datedBookingHref(template, { bookingDate: null }), null);
});

await check("the connection page: every Nightjet calendar's nights carry a dated ÖBB link", () => {
  const published = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"));
  const rows = Object.values(published.data.viewMap).filter((r) => r.timetable_source === "nightjet");
  let checked = 0;
  for (const row of rows) {
    for (const dir of [0, 1]) {
      const calendar = row[`fare_calendar_${dir}`];
      if (!calendar) continue;
      // What src/lib/seo/data.js fareCalendarFor does for this direction.
      const link = buildDatedBookingLink({
        agencyId: row.agency_id,
        origin: row[`origin_trip_${dir}`],
        dest: row[`destination_trip_${dir}`],
        journey: calendar.journey,
      });
      assert.ok(link, `${row.route_id} dir ${dir} has a dated link`);
      const view = fareCalendarDays(calendar, {
        today: TODAY,
        bookingDate: link.dateFor,
        bookingArrivalDate: link.arrivalDateFor,
      });
      if (!view) continue;
      for (const night of view.days) {
        const url = new URL(datedBookingHref(link.template, night));
        const dep = url.searchParams.get("connectionDatetimeDeparture");
        const arr = url.searchParams.get("connectionDatetimeArrival");
        assert.ok(dep.startsWith(`${night.date}T`), `${row.route_id} ${night.date}: ${dep}`);
        assert.ok(arr > dep, `${row.route_id} ${night.date}: arrives ${arr} after ${dep}`);
        assert.strictEqual(url.searchParams.get("connectionOrigEva"), calendar.journey.fromId);
        assert.strictEqual(url.searchParams.get("connectionDestEva"), calendar.journey.toId);
      }
      checked++;
    }
  }
  assert.ok(checked > 40, `${checked} calendars checked`);
  // The page wires it: the journey into the link, the arrival into each night,
  // the component filling both, and each calendar's own direction as fallback.
  const dataSrc = fs.readFileSync(path.join(ROOT, "src/lib/seo/data.js"), "utf8");
  assert.ok(/journey:\s*calendar\.journey/.test(dataSrc), "fareCalendarFor passes the priced journey");
  assert.ok(/bookingArrivalDate:\s*link\?\.arrivalDateFor/.test(dataSrc), "…and each night's arrival");
  assert.ok(/dir\.fareCalendar\.bookingHref\s*=/.test(dataSrc), "each calendar gets its own direction's fallback");
  const pageSrc = fs.readFileSync(path.join(ROOT, "src/components/seo/FareCalendar.js"), "utf8");
  assert.ok(/datedBookingHref\(bookingTemplate, night\)/.test(pageSrc), "FareCalendar fills the night through datedBookingHref");
  assert.ok(/calendar\.bookingHref \|\| bookingHref/.test(pageSrc), "…and prefers its own direction's fallback");
});

await check("fillNjFareCalendars: the calendar records the journey it priced", async () => {
  const trains = { "NJ 40421": structuredClone(AMS_SBG) };
  await fillNjFareCalendars(trains, null, {
    today: TODAY,
    fetchImpl: fakeNightjet({ "NJ 40421": everyNight("2026-10-08", 60) }),
    spacingMs: 0,
    log: () => {},
  });
  assert.deepStrictEqual(trains["NJ 40421"].fareCalendar.journey, pricedJourney(AMS_SBG));
});

console.log(`\nverify-nj-fares: ${passed} checks passed`);
