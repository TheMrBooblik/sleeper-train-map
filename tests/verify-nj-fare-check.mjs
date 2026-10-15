// tests/verify-nj-fare-check.mjs
// The Nightjet fare check (scripts/probe-nj-fares.mjs + scripts/lib/nj-fare-check.mjs):
// which nights it samples, how it reads an answer independently of the
// nightly reader, what it flags, the summary maths, robots.txt, the ÖBB shop's
// request bodies and offer shape, the dated shop link, and the whole probe
// run end to end against fake hosts — answering normally, blocking with a
// Cloudflare 403, and the shop refusing its token. No network.
// Run: npm run verify-nj-fare-check
//
// The nightjet.com answers follow the shape the first live run confirmed
// ([{ departure, arrival, bestOffers: { se, le, be: { name, price } } }]).
// The shop answers are SYNTHETIC: the timetable follows a 2019 sample in
// hoenic07/oebb-api-docs and the v6 offers a third-party parser (OenFare,
// Feb 2026); no shop answer has been seen from here, so these pin the
// probe's reading of that shape, not the shape itself.

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays,
  checklistRecords,
  compareNight,
  CSV_COLUMNS,
  daysBetween,
  disputedVerdict,
  extractShopOffers,
  findAnomalies,
  findShopConnection,
  FLAGS,
  formatTable,
  hash32,
  leadBucket,
  liveNight,
  median,
  nightlyReading,
  normalizeConfig,
  offersBody,
  parseOfferPrice,
  parseRobots,
  pickSpread,
  planSample,
  productName,
  readBestOffers,
  repeatDifferences,
  robotsDisallowed,
  robotsVerdict,
  shopDateTime,
  shopLink,
  storedNight,
  summarize,
  timetableBody,
  toCsv,
  trainCategory,
  viennaToday,
} from "../scripts/lib/nj-fare-check.mjs";
import { buildOffersUrl } from "../scripts/lib/nj-fares.mjs";
import { detectBlock, HONEST_USER_AGENT } from "../scripts/lib/http-block.mjs";
import { runProbe } from "../scripts/probe-nj-fares.mjs";
import { buildDatedBookingLink } from "../src/lib/operatorBooking.js";
import { datedBookingHref } from "../src/lib/fareCalendarView.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// 12:00 in Vienna on 10 October 2026.
const NOW = Date.parse("2026-10-10T10:00:00Z");
const TODAY = "2026-10-10";

/** Vienna's offset on a date in autumn 2026 (clocks go back on the 25th). */
const offset = (date) => (date < "2026-10-25" ? "+02:00" : "+01:00");
const at = (date, clock) => `${date}T${clock}:00${offset(date)}`;

const sp = (price, name = "Sparschiene inkl. Reservierung") => ({ name, price });

/** A night as the scraper writes it, new fields included. */
function priced(couchette, sleeperBed, extra = {}) {
  const classes = {};
  if (couchette != null) classes.couchette = couchette;
  if (sleeperBed != null) classes.sleeperBed = sleeperBed;
  return { classes, checkedAt: "2026-10-08", ...extra };
}

function calendarOf(fn, { from = -2, to = 40 } = {}) {
  const nights = {};
  for (let i = from; i <= to; i++) {
    const d = addDays(TODAY, i);
    const entry = fn(d, i);
    if (entry) nights[d] = entry;
  }
  return { version: 3, currency: "EUR", nights };
}

const st = (id, name) => ({ id, name });

/** Eight trains, each carrying one kind of night the sample has to find. */
function fixtureTrains() {
  return {
    "NJ 466": {
      lineName: "NJ 466",
      stations: [st("8103000", "Wien Hbf"), st("8100002", "Salzburg Hbf"), st("8503000", "Zürich HB")],
      fareCalendar: calendarOf((d) => priced(59.9, 99.9, {
        seat: 29.9, dep: `${d}T21:39`, arr: `${addDays(d, 1)}T09:30`,
        offers: { couchette: "Sparschiene", sleeperBed: "Sparschiene" },
      })),
    },
    "NJ 464": {
      lineName: "NJ 464",
      stations: [st("8100173", "Graz Hbf"), st("8503000", "Zürich HB")],
      // Seat-level couchettes on two nights and a bed below the couchette on one.
      fareCalendar: calendarOf((d, i) => (i === 9 ? priced(39.9, 94.9) : i === 10 ? priced(34.9, 94.9, { seat: 34.9 })
        : i === 12 ? priced(79.9, 64.9) : priced(69.9, 109.9))),
    },
    "EN 40458": {
      lineName: "EN 40458",
      stations: [st("5400014", "Praha hl.n."), st("8503000", "Zürich HB")],
      fareCalendar: calendarOf(() => priced(null, 296)),
    },
    "NJ 40421": {
      lineName: "NJ 40421",
      stations: [st("8400058", "Amsterdam Centraal"), st("8103000", "Wien Hbf")],
      fareCalendar: calendarOf(() => ({ none: true, checkedAt: "2026-10-08", reason: "noBerth", seat: 49.9 })),
    },
    "NJ 421": {
      lineName: "NJ 421",
      stations: [st("8400058", "Amsterdam Centraal"), st("8100108", "Innsbruck Hbf")],
      fareCalendar: calendarOf(() => priced(89.9, 149.9)),
    },
    "NJ 493": {
      lineName: "NJ 493",
      stations: [st("8002553", "Hamburg-Altona"), st("8103000", "Wien Hbf")],
      fareCalendar: calendarOf(() => ({ none: true, checkedAt: "2026-10-07" })),
    },
    "NJ 40491": {
      lineName: "NJ 40491",
      stations: [st("8002553", "Hamburg-Altona"), st("8100108", "Innsbruck Hbf")],
      fareCalendar: calendarOf(() => priced(99.9, null)),
    },
    "NJ 402": {
      lineName: "NJ 402",
      stations: [st("8011160", "Berlin Hbf"), st("8000261", "München Hbf")],
      fareCalendar: calendarOf(() => priced(84.9, 129.9)),
    },
  };
}

const BASE_CONFIG = {
  disputed: [],
  maxRequests: 60,
  spacingSeconds: 2,
  anomaliesPerKind: 4,
  perLeadBucket: 2,
  repeats: 3,
  repeatMinGapSeconds: 300,
  shop: { enabled: false },
};

// ── Dates, sampling ─────────────────────────────────────────────────────────

await check("lead buckets and Vienna's today", () => {
  assert.deepStrictEqual([1, 3, 4, 7, 8, 14, 15, 21, 22, 42, 43, 0].map(leadBucket),
    ["1–3", "1–3", "4–7", "4–7", "8–14", "8–14", "15–21", "15–21", "22–42", "22–42", "43+", "past"]);
  assert.strictEqual(daysBetween("2026-10-10", "2026-10-31"), 21);
  assert.strictEqual(daysBetween("2026-10-10", "not a date"), null);
  // 22:30 UTC on the 10th is already the 11th in Vienna.
  assert.strictEqual(viennaToday(Date.parse("2026-10-10T22:30:00Z")), "2026-10-11");
  assert.strictEqual(viennaToday(NOW), TODAY);
  assert.strictEqual(hash32("2026-10-10|C|NJ 466|2026-10-20"), hash32("2026-10-10|C|NJ 466|2026-10-20"));
  assert.notStrictEqual(hash32("a"), hash32("b"));
});

await check("normalizeConfig: defaults, the shop off unless switched on, a bad disputed entry reported not thrown", () => {
  const empty = normalizeConfig(undefined);
  assert.strictEqual(empty.maxRequests, 60);
  assert.strictEqual(empty.shop.enabled, false, "the shop step is opt-in");
  assert.deepStrictEqual(empty.problems, []);
  const c = normalizeConfig({
    maxRequests: "lots",
    disputed: [
      { train: "NJ  466", date: "2026-10-20", shop: { price: "119,90", product: "Sparschiene", compartment: "Liegewagen 6er" } },
      { train: "NJ 466", date: "20.10.2026" },
      { date: "2026-10-20" },
    ],
  });
  assert.strictEqual(c.maxRequests, 60);
  assert.strictEqual(c.disputed.length, 1);
  assert.deepStrictEqual(c.disputed[0].train, "NJ 466", "spacing in a train name is normalised");
  assert.strictEqual(c.disputed[0].shop.price, 119.9, "the owner's price may be written as the shop prints it");
  assert.strictEqual(c.problems.length, 3, c.problems.join("\n"));
});

await check("the committed config is valid and turns the shop step on, with a three-night ceiling", () => {
  const c = normalizeConfig(readJson("data/sources/nj-fare-check.json"));
  assert.deepStrictEqual(c.problems, []);
  assert.strictEqual(c.maxRequests, 60);
  assert.strictEqual(c.spacingSeconds, 2);
  assert.deepStrictEqual(c.shop, { enabled: true, maxTrainNights: 3, spacingSeconds: 5 });
  assert.ok(c.spacingSeconds >= 2 && c.shop.spacingSeconds >= 5, "never faster than the agreed spacing");
  assert.deepStrictEqual(c.coupledPairs, [["NJ 40421", "NJ 421"], ["NJ 493", "NJ 40491"]]);
  assert.ok(c.partnerTrains.includes("EN 40458") && c.partnerTrains.includes("EN 50462"));
});

await check("storedNight: an entry written before seat/offers/reason existed reads as unknown, not as wrong", () => {
  assert.deepStrictEqual(storedNight({ none: true, checkedAt: "2026-10-07" }),
    { status: "none", checkedAt: "2026-10-07", seat: null, reason: null });
  assert.deepStrictEqual(storedNight({ none: true, checkedAt: "2026-10-08", reason: "noBerth", seat: 49.9 }),
    { status: "none", checkedAt: "2026-10-08", seat: 49.9, reason: "noBerth" });
  const p = storedNight(priced(59.9, null, { seat: 29.9, offers: { couchette: "Sparschiene" } }));
  assert.strictEqual(p.status, "priced");
  assert.strictEqual(p.couchette, 59.9);
  assert.strictEqual(p.sleeperBed, null);
  assert.strictEqual(p.seat, 29.9);
  assert.strictEqual(storedNight(undefined).status, "missing");
});

await check("findAnomalies: each kind, read from the stored nights after today only", () => {
  const trains = fixtureTrains();
  const a = findAnomalies(trains, { today: TODAY });
  const nights = (kind) => a[kind].map((x) => `${x.key} ${x.night}`);
  assert.deepStrictEqual(nights("seatLevel"), [`NJ 464 ${addDays(TODAY, 9)}`, `NJ 464 ${addDays(TODAY, 10)}`]);
  assert.deepStrictEqual(nights("leAtOrBelowSeat"), [`NJ 464 ${addDays(TODAY, 10)}`], "34.9 couchette beside a 34.9 seat");
  assert.deepStrictEqual(nights("sleeperBelowCouchette"), [`NJ 464 ${addDays(TODAY, 12)}`]);
  assert.strictEqual(a.sleeperOnly.length, 40, "EN 40458's 40 nights after today, never the two past ones");
  assert.ok(a.sleeperOnly.every((x) => x.key === "EN 40458" && x.night > TODAY));
  assert.strictEqual(a.partnerPricing.length, 40, "€296 is off the .9 ladder");
  assert.strictEqual(findAnomalies(trains, { today: TODAY, partnerTrains: [] }).partnerPricing.length, 0);
});

await check("pickSpread: one night per train before any train's second, in a seeded order", () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ key: "A", night: addDays(TODAY, i + 1) })),
    { key: "B", night: addDays(TODAY, 3) },
    { key: "C", night: addDays(TODAY, 4) },
  ];
  const picked = pickSpread(items, 4, { seed: TODAY, salt: "x" });
  assert.deepStrictEqual(new Set(picked.slice(0, 3).map((i) => i.key)), new Set(["A", "B", "C"]));
  assert.strictEqual(picked.length, 4);
  assert.deepStrictEqual(pickSpread(items, 4, { seed: TODAY, salt: "x" }), picked, "deterministic for a seed");
  assert.strictEqual(pickSpread(items, 20, { seed: TODAY }).length, items.length);
});

await check("planSample: disputed first, then anomalies, a stratified spread on distinct trains, repeats of the spread", () => {
  const trains = fixtureTrains();
  const config = normalizeConfig({
    ...BASE_CONFIG,
    disputed: [
      { train: "NJ 466", date: addDays(TODAY, 5) },
      { train: "NJ 466", date: TODAY },
      { train: "NJ 999", date: addDays(TODAY, 5) },
      // Also an anomaly: asked once, with both reasons.
      { train: "NJ 464", date: addDays(TODAY, 9) },
    ],
  });
  const plan = planSample(trains, config, { today: TODAY });
  const groups = plan.requests.map((r) => r.group).join("");
  assert.ok(/^A+B+C+D+$/.test(groups), groups);
  assert.deepStrictEqual(plan.requests.filter((r) => r.group === "A").map((r) => `${r.key} ${r.night}`),
    [`NJ 466 ${addDays(TODAY, 5)}`, `NJ 464 ${addDays(TODAY, 9)}`]);
  assert.ok(plan.notes.some((n) => n.includes("NJ 466 2026-10-10") && n.includes("not after today")));
  assert.ok(plan.notes.some((n) => n.includes("NJ 999") && n.includes("not in the trains file")));
  const dual = plan.requests.find((r) => r.key === "NJ 464" && r.night === addDays(TODAY, 9));
  assert.deepStrictEqual(dual.reasons, ["disputed", "couchette at seat level"]);
  assert.strictEqual(new Set(plan.requests.filter((r) => r.group !== "D").map((r) => `${r.key}|${r.night}`)).size,
    plan.requests.filter((r) => r.group !== "D").length, "no night asked twice except as a repeat");
  assert.ok(plan.requests.every((r) => r.night > TODAY), "only nights after today");

  // Coupled pairs: both trains, same nights.
  for (const [a, b] of config.coupledPairs) {
    const na = plan.requests.filter((r) => r.key === a && r.reasons.includes(`coupled with ${b}`)).map((r) => r.night);
    const nb = plan.requests.filter((r) => r.key === b && r.reasons.includes(`coupled with ${a}`)).map((r) => r.night);
    assert.strictEqual(na.length, 2);
    assert.deepStrictEqual(na.sort(), nb.sort());
  }

  // C: at most perLeadBucket per bucket, each train once, every night priced.
  const spread = plan.requests.filter((r) => r.group === "C");
  const perBucket = {};
  for (const r of spread) perBucket[r.bucket] = (perBucket[r.bucket] ?? 0) + 1;
  assert.ok(Object.values(perBucket).every((n) => n <= 2), JSON.stringify(perBucket));
  assert.strictEqual(new Set(spread.map((r) => r.key)).size, spread.length, "distinct trains");
  assert.ok(spread.every((r) => plan.stored[r.id].status === "priced"));

  // D: repeats of C requests, same night, pointing at their first ask.
  const repeats = plan.requests.filter((r) => r.group === "D");
  assert.strictEqual(repeats.length, Math.min(3, spread.length));
  for (const r of repeats) {
    const first = plan.requests.find((x) => x.id === r.repeatOf);
    assert.strictEqual(first.group, "C");
    assert.deepStrictEqual([first.key, first.night], [r.key, r.night]);
  }
  assert.ok(plan.requests.length <= config.maxRequests - 1, "robots.txt is one of the host's requests");
});

await check("planSample: deterministic for a date, a different spread on another", () => {
  const trains = fixtureTrains();
  const config = normalizeConfig(BASE_CONFIG);
  const a = planSample(trains, config, { today: TODAY });
  const b = planSample(trains, config, { today: TODAY });
  assert.deepStrictEqual(a.requests, b.requests);
  const spreadOn = (seed) => planSample(trains, normalizeConfig({ ...BASE_CONFIG, seed }), { today: TODAY })
    .requests.filter((r) => r.group === "C").map((r) => `${r.key} ${r.night}`).join();
  const seeds = ["2026-10-11", "2026-10-12", "2026-10-13"].map(spreadOn);
  assert.ok(seeds.some((s) => s !== spreadOn(TODAY)), "the seed moves the spread");
});

await check("planSample: the request cap keeps the order of priority and reports what it dropped", () => {
  const trains = fixtureTrains();
  const config = normalizeConfig({ ...BASE_CONFIG, maxRequests: 8, disputed: [{ train: "NJ 466", date: addDays(TODAY, 5) }] });
  const plan = planSample(trains, config, { today: TODAY });
  assert.strictEqual(plan.requests.length, 7, "eight requests, robots.txt being one");
  assert.strictEqual(plan.requests[0].group, "A");
  assert.ok(plan.dropped.length > 0);
  assert.ok(plan.dropped.some((r) => r.group === "D") || !plan.requests.some((r) => r.group === "C"));
  assert.ok(plan.dropped.every((r) => r.id === null && r.key && r.night && r.reasons.length));
  const kept = new Set(plan.requests.map((r) => `${r.key}|${r.night}`));
  assert.ok(plan.dropped.filter((r) => r.group !== "D").every((r) => !kept.has(`${r.key}|${r.night}`)));
});

await check("planSample on the committed trains file: within the cap, after today, a spread on distinct trains", () => {
  const file = readJson("public/data/scraped/nightjet-trains.json");
  const trains = file.data?.trains ?? file.trains;
  const config = normalizeConfig(readJson("data/sources/nj-fare-check.json"));
  const today = viennaToday(Date.now());
  const plan = planSample(trains, config, { today });
  assert.ok(plan.requests.length <= config.maxRequests - 1);
  assert.ok(plan.requests.every((r) => r.night > today));
  const spread = plan.requests.filter((r) => r.group === "C");
  assert.strictEqual(new Set(spread.map((r) => r.key)).size, spread.length);
});

// ── Reading an answer ───────────────────────────────────────────────────────

await check("parseOfferPrice: numbers, decimal commas, thousands points, and nothing that is not a price", () => {
  const cases = [
    [119.9, 119.9], ["119.90", 119.9], ["119,90", 119.9], ["€ 119,90", 119.9], ["1.119,90", 1119.9],
    ["1,119.90", 1119.9], ["1.119", 1119], ["54.9", 54.9], [" 49 € ", 49], ["296", 296],
    [0, null], ["0,00", null], ["-5", null], ["abc", null], ["", null], [null, null], [undefined, null], [NaN, null],
  ];
  for (const [input, want] of cases) assert.strictEqual(parseOfferPrice(input), want, JSON.stringify(input));
});

await check("readBestOffers: every class kept with its product, the reservation suffix off, unknown keys listed", () => {
  assert.strictEqual(productName("Sparschiene Komfort inkl. Reservierung"), "Sparschiene Komfort");
  assert.strictEqual(productName("Komfortticket"), "Komfortticket");
  assert.strictEqual(productName(null), null);
  const r = readBestOffers({
    se: { name: "Sparschiene", price: "29,90" },
    LE: { name: "Sparschiene inkl. Reservierung", price: 59.9 },
    le: { name: "Komfortticket inkl. Reservierung", price: 89.9 },
    xx: { name: "?", price: 1 },
  });
  assert.deepStrictEqual(r.se, { price: 29.9, name: "Sparschiene", product: "Sparschiene" });
  assert.deepStrictEqual(r.le, { price: 59.9, name: "Sparschiene inkl. Reservierung", product: "Sparschiene" }, "the cheaper of a key written twice");
  assert.strictEqual(r.be, null, "a class the answer does not carry is null, not zero");
  assert.deepStrictEqual(r.other, ["xx"]);
  assert.deepStrictEqual(readBestOffers({ le: { price: "n/a" } }).le, null);
  assert.deepStrictEqual(readBestOffers(null), { se: null, le: null, be: null, other: [] });
});

const NIGHT = "2026-10-20";
const journey = (date, offers, clock = "21:39") => ({
  departure: at(date, clock), arrival: at(addDays(date, 1), "09:30"), bestOffers: offers,
});

await check("liveNight: priced, seats only, another night, nothing on sale, and answers it cannot read", () => {
  const p = liveNight([journey(NIGHT, { se: sp(29.9, "Sparschiene"), le: sp(59.9), be: sp(99.9) })], NIGHT);
  assert.strictEqual(p.status, "priced");
  assert.deepStrictEqual(p.classes, { couchette: 59.9, sleeperBed: 99.9 });
  assert.deepStrictEqual([p.dep, p.arr], ["2026-10-20T21:39", "2026-10-21T09:30"]);
  assert.strictEqual(p.se.price, 29.9);

  const seatsOnly = liveNight([journey(NIGHT, { se: sp(29.9, "Sparschiene") })], NIGHT);
  assert.deepStrictEqual([seatsOnly.status, seatsOnly.reason], ["none", "noBerth"]);
  assert.strictEqual(seatsOnly.se.price, 29.9, "the seat is kept to say why");

  const later = liveNight([journey("2026-10-22", { le: sp(59.9) })], NIGHT);
  assert.deepStrictEqual([later.status, later.reason, later.depNight], ["none", "noJourney", "2026-10-22"]);

  const nothing = liveNight([], NIGHT);
  assert.deepStrictEqual([nothing.status, nothing.reason], ["none", "noJourney"]);

  assert.strictEqual(liveNight({ error: "x" }, NIGHT).status, "unreadable");
  assert.strictEqual(liveNight([{ departure: "20.10.2026 21:39", bestOffers: {} }], NIGHT).status, "unreadable");
  const early = liveNight([journey("2026-10-18", { le: sp(59.9) })], NIGHT);
  assert.strictEqual(early.status, "unreadable", "journeys only before the night asked: the search misread the moment");
  // 23:30 UTC on the 20th is half past one on the 21st in Vienna.
  const late = liveNight([{ departure: "2026-10-20T23:30:00Z", arrival: "2026-10-21T08:00:00Z", bestOffers: { le: sp(59.9) } }], NIGHT);
  assert.strictEqual(late.depNight, "2026-10-21");
});

await check("nightlyReading: the nightly reader's view of the same answer, and where the two disagree", () => {
  const body = [journey(NIGHT, { le: sp(59.9), be: sp(99.9) })];
  assert.deepStrictEqual(nightlyReading(body, NIGHT), { classes: { couchette: 59.9, sleeperBed: 99.9 } });
  assert.ok(nightlyReading("<html>", NIGHT).error);
  // A thousands point the nightly reader's parsePrice cannot read: the check says so.
  const thousands = [journey(NIGHT, { le: sp("1.119,90") })];
  const live = liveNight(thousands, NIGHT);
  const cmp = compareNight({
    key: "NJ 466", night: NIGHT, stored: storedNight(priced(59.9, null)), live, today: TODAY,
    reader: nightlyReading(thousands, NIGHT),
  });
  assert.ok(cmp.flags.includes(FLAGS.readerDiff), cmp.flags.join(" "));
  const agree = compareNight({
    key: "NJ 466", night: NIGHT, stored: storedNight(priced(59.9, 99.9)), live: liveNight(body, NIGHT), today: TODAY,
    reader: nightlyReading(body, NIGHT),
  });
  assert.ok(!agree.flags.includes(FLAGS.readerDiff));
});

// ── Flags and summary ───────────────────────────────────────────────────────

await check("compareNight: each flag on the night that earns it, the deltas, the stored check's age, exact match", () => {
  const flagsOf = (stored, offers, opts = {}) => compareNight({
    key: opts.key ?? "NJ 466", night: NIGHT, stored: storedNight(stored),
    live: liveNight(opts.body ?? [journey(opts.date ?? NIGHT, offers)], NIGHT), today: TODAY,
  });

  const same = flagsOf(priced(59.9, 99.9), { se: sp(29.9, "Sparschiene"), le: sp(59.9), be: sp(99.9) });
  assert.deepStrictEqual(same.flags, []);
  assert.strictEqual(same.exact, true);
  assert.strictEqual(same.ageDays, 2);
  assert.deepStrictEqual([same.deltaCouchette, same.deltaSleeper], [0, 0]);

  const moved = flagsOf(priced(59.9, 99.9), { le: sp(69.9), be: sp(99.9) });
  assert.deepStrictEqual(moved.flags, [FLAGS.deltaCouchette]);
  assert.strictEqual(moved.deltaCouchette, 10);
  assert.strictEqual(moved.exact, false);

  assert.ok(flagsOf(priced(29.9, null), { se: sp(29.9, "Sparschiene"), le: sp(29.9) }).flags.includes(FLAGS.leAtOrBelowSe));
  assert.ok(flagsOf(priced(79.9, 64.9), { le: sp(79.9), be: sp(64.9) }).flags.includes(FLAGS.beBelowLe));
  assert.ok(flagsOf(priced(59.9, null), { le: sp(59.9) }, { date: "2026-10-22" }).flags.includes(FLAGS.depNotNight));
  // The stored clock is what the Book link opens the shop with.
  const clock = (dep) => priced(59.9, null, { dep, arr: "2026-10-21T09:30" });
  assert.ok(flagsOf(clock("2026-10-20T21:10"), { le: sp(59.9) }).flags.includes(FLAGS.depMoved));
  assert.deepStrictEqual(flagsOf(clock("2026-10-20T21:39"), { le: sp(59.9) }).flags, []);
  const gone = flagsOf(priced(59.9, null), { se: sp(29.9, "Sparschiene") });
  assert.ok(gone.flags.includes(FLAGS.pricedToNone));
  assert.strictEqual(gone.exact, false);
  assert.ok(flagsOf({ none: true, checkedAt: "2026-10-07" }, { le: sp(59.9) }).flags.includes(FLAGS.noneToPriced));
  const stillNone = flagsOf({ none: true, checkedAt: "2026-10-07" }, { se: sp(29.9, "Sparschiene") });
  assert.strictEqual(stillNone.exact, true, "no berth then, no berth now");
  assert.ok(flagsOf(priced(89.9, null), { le: sp(89.9, "Komfortticket inkl. Reservierung") }).flags.includes(FLAGS.notSparschiene));
  assert.ok(!flagsOf(priced(89.9, null), { le: sp(89.9, "Sparschiene Komfort inkl. Reservierung") }).flags.includes(FLAGS.notSparschiene));
  assert.ok(flagsOf(priced(76, null), { le: sp(76) }).flags.includes(FLAGS.non9));
  assert.ok(flagsOf(priced(76, null), { le: sp(76) }, { key: "EN 40457" }).flags.includes(`${FLAGS.non9}(partner)`));
  assert.ok(compareNight({ key: "NJ 466", night: NIGHT, stored: storedNight(priced(29.9, null, { seat: 34.9 })), live: null, today: TODAY })
    .flags.includes(FLAGS.storedLeSe));
  const unreadable = compareNight({ key: "NJ 466", night: NIGHT, stored: storedNight(priced(59.9, null)), live: liveNight({}, NIGHT), today: TODAY });
  assert.deepStrictEqual([unreadable.flags, unreadable.exact], [[FLAGS.error], null]);
  assert.strictEqual(compareNight({ key: "NJ 466", night: NIGHT, stored: storedNight(undefined), live: liveNight([], NIGHT), today: TODAY }).exact, null);
});

await check("repeatDifferences: nothing for the same answer, each field that moved otherwise", () => {
  const a = liveNight([journey(NIGHT, { le: sp(59.9), be: sp(99.9) })], NIGHT);
  const b = liveNight([journey(NIGHT, { le: sp(64.9), be: sp(99.9, "Komfortticket") })], NIGHT);
  assert.deepStrictEqual(repeatDifferences(a, a), []);
  assert.deepStrictEqual(repeatDifferences(a, b), ["couchette 59.9 → 64.9", "sleeper product Sparschiene → Komfortticket"]);
  assert.deepStrictEqual(repeatDifferences(a, null), ["no answer to compare"]);
});

await check("disputedVerdict: whose figure the owner's shop price agrees with, and never a guess without one", () => {
  const stored = storedNight(priced(59.9, 99.9));
  const live = liveNight([journey(NIGHT, { le: sp(69.9), be: sp(99.9) })], NIGHT);
  const couchette = disputedVerdict({ price: 69.9, compartment: "Liegewagen 6er" }, stored, live);
  assert.deepStrictEqual([couchette.cls, couchette.matchesLive, couchette.matchesStored], ["couchette", true, false]);
  assert.ok(couchette.text.includes("stale"));
  const neither = disputedVerdict({ price: 79.9, compartment: "couchette 4-berth" }, stored, live);
  assert.deepStrictEqual([neither.matchesLive, neither.matchesStored], [false, false]);
  const bed = disputedVerdict({ price: 99.9, compartment: "Schlafwagen Double" }, stored, live);
  assert.deepStrictEqual([bed.cls, bed.matchesLive, bed.matchesStored], ["sleeperBed", true, true]);
  const unasked = disputedVerdict({ price: 59.9, compartment: "Liegewagen" }, stored, null);
  assert.deepStrictEqual([unasked.matchesLive, unasked.matchesStored], [null, true], "no live answer is not a disagreement");
  assert.strictEqual(disputedVerdict(null, stored, live).text, "no shop figure noted");
});

function row(group, id, bucket, stored, live, extra = {}) {
  const night = extra.night ?? NIGHT;
  const request = { id, group, key: extra.key ?? "NJ 466", night, lead: 10, bucket, reasons: [], ...extra.request };
  return {
    request, stored, live, headers: extra.headers,
    comparison: compareNight({ key: request.key, night, stored, live, today: TODAY }),
    ...(extra.repeat ? { repeat: extra.repeat } : {}),
  };
}

await check("summarize: exact-match shares overall, per lead bucket and for the spread; median |Δ|; products; invariants", () => {
  const p = (le, be, se = 29.9, leName) => liveNight([journey(NIGHT, {
    se: sp(se, "Sparschiene"), ...(le != null ? { le: sp(le, leName) } : {}), ...(be != null ? { be: sp(be) } : {}),
  })], NIGHT);
  const rows = [
    row("C", 1, "1–3", storedNight(priced(59.9, 99.9)), p(59.9, 99.9), { headers: { "cache-control": "no-cache", age: "0" } }),
    row("C", 2, "1–3", storedNight(priced(59.9, 99.9)), p(69.9, 99.9), { headers: { "cache-control": "no-cache" } }),
    row("C", 3, "22–42", storedNight(priced(59.9, 99.9)), p(54.9, 119.9, 29.9, "Komfortticket inkl. Reservierung")),
    row("B", 4, "8–14", storedNight(priced(29.9, null)), p(29.9, null, 29.9)),
    row("B", 5, "8–14", storedNight(priced(59.9, 99.9)), null),
    row("D", 6, "1–3", storedNight(priced(59.9, 99.9)), p(59.9, 99.9), {
      request: { repeatOf: 1 }, repeat: { differences: [], gapSeconds: 300, etagSame: true },
      headers: { "cache-control": "no-cache", age: "12" },
    }),
  ];
  const s = summarize(rows);
  assert.strictEqual(s.asked, 5, "the repeat is not a second sample");
  assert.strictEqual(s.compared, 4);
  assert.strictEqual(s.exact, 2);
  assert.strictEqual(s.exactShare, "2/4 (50%)");
  assert.strictEqual(s.spreadShare, "1/3 (33%)");
  assert.deepStrictEqual(s.byBucket["1–3"], { compared: 2, exact: 1 });
  assert.deepStrictEqual(s.byBucket["22–42"], { compared: 1, exact: 0 });
  assert.deepStrictEqual(s.byBucket["4–7"], { compared: 0, exact: 0 });
  // Couchette deltas 0, 10, -5, 0; sleeper deltas 0, 0, 20.
  assert.deepStrictEqual(s.medianAbsDelta, { couchette: 2.5, sleeperBed: 0, all: 0 });
  assert.deepStrictEqual(s.nonZeroDeltas, { couchette: 2, sleeperBed: 1 });
  assert.deepStrictEqual(s.products.couchette, { Sparschiene: 3, Komfortticket: 1 });
  assert.deepStrictEqual(s.invariants.liveCouchetteAboveSeat, { checked: 4, violations: 1 });
  assert.deepStrictEqual(s.invariants.liveBedNotBelowCouchette, { checked: 3, violations: 0 });
  assert.deepStrictEqual(s.repeats, {
    asked: 1, answered: 1, same: 1, differ: 0,
    details: [{ id: 6, repeatOf: 1, key: "NJ 466", night: NIGHT, differences: [], gapSeconds: 300, etagSame: true }],
  });
  assert.deepStrictEqual(s.cache["cache-control"], { present: 3, of: 3, values: { "no-cache": 3 } });
  assert.deepStrictEqual(s.cache.age, { present: 2, of: 3, values: { 0: 1, 12: 1 } });
  assert.strictEqual(s.flagCounts[FLAGS.leAtOrBelowSe], 1);
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([]), null);
});

// ── robots.txt ──────────────────────────────────────────────────────────────

await check("robots.txt: groups, longest match, Allow on a tie, wildcards, our own group, and /api/ for *", () => {
  const text = [
    "# comment",
    "Disallow: /ignored-before-any-agent",
    "User-agent: Googlebot",
    "User-agent: bingbot",
    "Disallow: /",
    "",
    "User-agent: *",
    "Disallow: /api/",
    "Allow: /api/public/",
    "Disallow: /*.pdf$",
    "Disallow:",
    "Crawl-delay: 5",
    "",
    "User-agent: pingwi",
    "Allow: /",
  ].join("\n");
  const groups = parseRobots(text);
  assert.strictEqual(groups.length, 3);
  assert.deepStrictEqual(groups[0].agents, ["googlebot", "bingbot"]);
  assert.strictEqual(robotsVerdict(text, "/api/domain/v1/anonymousToken").allowed, false);
  assert.strictEqual(robotsVerdict(text, "/api/public/x").allowed, true, "the longer Allow wins");
  assert.strictEqual(robotsVerdict(text, "/doc.pdf").allowed, false);
  assert.strictEqual(robotsVerdict(text, "/doc.pdf?x=1").allowed, true, "$ anchors the end");
  assert.strictEqual(robotsVerdict(text, "/en/ticket").allowed, true);
  assert.strictEqual(robotsVerdict(text, "/api/x", "pingwi").allowed, true, "our own group, read on its own");
  // The conservative reading: a rule for everyone is honoured even with a group of our own.
  assert.deepStrictEqual(robotsDisallowed(text, ["/api/", "/en/ticket"]).map((d) => [d.path, d.agent, d.rule]),
    [["/api/", "*", "Disallow: /api/"]]);
  assert.deepStrictEqual(robotsDisallowed("User-agent: *\nDisallow:\n", ["/api/"]), []);
  assert.deepStrictEqual(robotsDisallowed("", ["/api/"]), [], "no robots.txt, no rules");
  assert.deepStrictEqual(robotsDisallowed("User-agent: *\nAllow: /api/\nDisallow: /api/\n", ["/api/x"]), [], "Allow wins a tie");
  assert.strictEqual(robotsDisallowed("User-agent: *\nDisallow: /\n", ["/api/x"]).length, 1);
});

// ── The shop ────────────────────────────────────────────────────────────────

await check("shop request bodies: a local date-time ten minutes early, one adult, our two station ids", () => {
  assert.strictEqual(shopDateTime("2026-10-20T21:39", 10), "2026-10-20T21:29:00.000");
  assert.strictEqual(shopDateTime("2026-10-21T00:05", 10), "2026-10-20T23:55:00.000");
  assert.strictEqual(shopDateTime("tomorrow", 10), null);
  assert.deepStrictEqual(trainCategory("NJ 466"), { name: "NJ", number: "466" });
  assert.deepStrictEqual(trainCategory("EN 40458"), { name: "EN", number: "40458" });
  assert.strictEqual(trainCategory("Nightjet"), null);
  const tt = timetableBody({ datetime: "2026-10-20T21:29:00.000", fromId: "8103000", toId: "8503000", from: "Wien Hbf", to: "Zürich HB" });
  assert.deepStrictEqual(tt.from, { number: 8103000, name: "Wien Hbf" });
  assert.strictEqual(tt.filter.direct, true);
  assert.strictEqual(tt.passengers.length, 1);
  assert.strictEqual(tt.passengers[0].type, "ADULT");
  assert.deepStrictEqual(tt.passengers[0].cards, [], "no discount card: the fare nightjet.com's search prices");
  const of = offersBody({ connectionId: "abc", datetime: "2026-10-20T21:29:00.000" });
  assert.deepStrictEqual(of.selection, { connectionId: "abc", offerSections: [] });
});

/** SYNTHETIC timetable answer (hoenic07 2019 sample shape): our NJ 466, a sibling, and a day train. */
function shopTimetable(date = NIGHT) {
  const conn = (id, name, number, dep, sections = 1) => ({
    id,
    from: { name: "Wien Hbf", esn: 8103000, departure: `${date}T${dep}:00.000` },
    to: { name: "Zürich HB", esn: 8503000, arrival: `${addDays(date, 1)}T09:30:00.000` },
    switches: sections - 1,
    sections: Array.from({ length: sections }, () => ({ type: "journey", category: { name, number, shortName: name } })),
  });
  return {
    connections: [
      conn("day", "RJX", "160", "07:40"),
      conn("other", "NJ", "40466", "21:39"),
      conn("change", "NJ", "466", "21:39", 2),
      conn("ours", "NJ", "466", "21:39"),
    ],
  };
}

await check("findShopConnection: only a direct connection of our train, ends and minute — anything less is reported", () => {
  const ends = { key: "NJ 466", fromId: "8103000", toId: "8503000" };
  const found = findShopConnection(shopTimetable(), { ...ends, dep: "2026-10-20T21:39" });
  assert.deepStrictEqual(found.connection, { id: "ours", departure: "2026-10-20T21:39:00.000" });
  assert.strictEqual(found.candidates.length, 4);
  assert.strictEqual(findShopConnection(shopTimetable(), { ...ends, dep: "2026-10-20T21:40" }).connection, null);
  assert.strictEqual(findShopConnection(shopTimetable(), { ...ends, toId: "8100002", dep: "2026-10-20T21:39" }).connection, null);
  assert.ok(findShopConnection({ error: "x" }, ends).problem.includes("no connections"));
});

/** SYNTHETIC v6 offers answer, shaped as OenFare's parser (Feb 2026) reads it. */
const SHOP_OFFERS = {
  offerSections: [
    {
      media: {
        compartments: [
          { id: 1, accommodationType: "SEAT", compartmentGroup: "DEFAULT", name: { en: "Seat", de: "Sitzplatz" } },
          { id: 2, accommodationType: "COUCHETTE", compartmentGroup: "DEFAULT", name: { en: "6-berth couchette", de: "Liegewagen 6er" } },
          { id: 3, accommodationType: "COUCHETTE", compartmentGroup: "DEFAULT", name: { en: "4-berth couchette", de: "Liegewagen 4er" } },
          { id: 4, accommodationType: "BERTH", compartmentGroup: "DEFAULT", name: { en: "Triple", de: "Schlafwagen 3er" } },
          { id: 5, accommodationType: "BERTH", compartmentGroup: "DEFAULT", name: { en: "Double", de: "Schlafwagen 2er" } },
        ],
      },
      travelClasses: [
        {
          offers: [
            {
              flexibility: "NON-FLEX",
              reservation: {
                compartments: [
                  { id: 1, price: 17.3 },
                  { id: 2, price: 59.9, variations: [{ genderDesignation: "FEMALE" }] },
                  { id: 3, price: "79,90" },
                  { id: 4, price: 99.9 },
                  { id: 5, price: 129.9 },
                  { id: 9, price: 1 },
                ],
              },
            },
            {
              flexibility: "FLEX",
              reservation: { compartments: [{ id: 2, price: 89.9 }, { id: 5, price: 159.9 }] },
            },
          ],
        },
      ],
    },
  ],
};

await check("extractShopOffers (synthetic v6 sample): seats discarded, couchette and berth minima overall, per compartment, ladies apart", () => {
  const o = extractShopOffers(SHOP_OFFERS);
  assert.strictEqual(o.ok, true);
  assert.deepStrictEqual(o.couchette, { min: 59.9, byName: { "6-berth couchette": 59.9, "4-berth couchette": 79.9 }, ladies: 59.9 });
  assert.deepStrictEqual(o.berth, { min: 99.9, byName: { Triple: 99.9, Double: 129.9 }, ladies: null });
  assert.strictEqual(o.seats, 1);
  assert.deepStrictEqual(o.tiers, ["NON-FLEX", "FLEX"]);
  assert.deepStrictEqual(o.surprises, ["compartment 9 not in media"], "an unknown id is logged, not thrown");
  assert.strictEqual(JSON.stringify(o).includes("17.3"), false, "no seat price anywhere in the reading");
  const odd = extractShopOffers({ offerSections: [{ media: { compartments: [{ id: 1, accommodationType: "BED" }] },
    travelClasses: [{ offers: [{ reservation: { compartments: [{ id: 1, price: 50 }] } }] }] }] });
  assert.strictEqual(odd.ok, false);
  assert.ok(odd.surprises[0].includes('"BED"'));
  assert.ok(extractShopOffers("<html>").surprises[0].includes("no offerSections"));
});

// ── The dated shop link ─────────────────────────────────────────────────────

await check("shopLink: operator-booking.json's ÖBB journeyUrlTemplate, filled exactly as the fare calendar fills it", () => {
  const booking = readJson("data/overrides/operator-booking.json");
  const obb = booking[Object.keys(booking).find((k) => k.normalize("NFC") === "ÖBB")];
  assert.ok(obb.journeyUrlTemplate.includes("{departure}"), "the template this check reads is the calendar's");
  const ends = { fromId: "8103000", toId: "8503000", from: "Wien Hbf", to: "Zürich HB" };
  const times = { dep: "2026-10-20T21:39", arr: "2026-10-21T09:30" };
  const link = shopLink(obb.journeyUrlTemplate, ends, times, { dateFormat: obb.dateFormat });
  const dated = buildDatedBookingLink({ agencyId: "ÖBB", journey: ends, nightTimes: () => times });
  const t = dated.timesFor("2026-10-20");
  const expected = datedBookingHref(dated.template, {
    bookingDate: dated.dateFor("2026-10-20"), bookingDeparture: t.departure, bookingArrival: t.arrival,
  });
  assert.strictEqual(link, expected);
  assert.ok(link.includes("connectionDatetimeDeparture=2026-10-20T21:39"));
  assert.ok(link.includes("stationDestName=Z%C3%BCrich%20HB"));
  assert.strictEqual(shopLink(obb.journeyUrlTemplate, ends, { dep: "2026-10-20T21:39" }), null, "no arrival, no link");
  assert.strictEqual(shopLink(obb.journeyUrlTemplate, { ...ends, toId: "85030" }, times), null);
  assert.strictEqual(shopLink(null, ends, times), null);
});

// ── Report output ───────────────────────────────────────────────────────────

await check("the table, the CSV checklist (one row per night, the owner's columns empty) and CSV quoting", () => {
  const live = liveNight([journey(NIGHT, { se: sp(29.9, "Sparschiene"), le: sp(64.9), be: sp(99.9) })], NIGHT);
  const ends = { fromId: "8103000", toId: "8503000", from: "Wien Hbf", to: "Zürich HB" };
  const first = { ...row("C", 1, "8–14", storedNight(priced(59.9, 99.9)), live), ends, url: "https://example/1" };
  const again = row("D", 2, "8–14", storedNight(priced(59.9, 99.9)), live, { request: { repeatOf: 1 } });
  again.comparison.flags.push(FLAGS.repeatDiff);
  const table = formatTable([first, again]);
  assert.ok(table[0].startsWith("#   g train"));
  assert.ok(table[2].includes("NJ 466") && table[2].includes("64.9 Spar") && table[2].includes("+5"), table[2]);
  const template = "https://shop.example/t?d={departure}&a={arrival}&o={originId}&n={originName}";
  const records = checklistRecords([first, again], { template });
  assert.strictEqual(records.length, 1, "the repeat folds into its night");
  const r = records[0];
  assert.strictEqual(r.live_couchette, 64.9);
  assert.strictEqual(r.live_couchette_product, "Sparschiene");
  assert.strictEqual(r.stored_checked_at, "2026-10-08");
  assert.strictEqual(r.shop_link, "https://shop.example/t?d=2026-10-20T21:39&a=2026-10-21T09:30&o=8103000&n=Wien%20Hbf");
  assert.ok(r.flags.includes(FLAGS.deltaCouchette) && r.flags.includes(FLAGS.repeatDiff));
  for (const c of ["shop_price", "shop_product", "shop_compartment", "checked_at"]) assert.strictEqual(r[c], "", c);
  const csv = toCsv(records);
  assert.strictEqual(csv.split("\n")[0], CSV_COLUMNS.join(","));
  assert.strictEqual(toCsv([{ a: 'say "hi", twice' }], ["a"]), 'a\n"say ""hi"", twice"\n');
});

// ── The probe, end to end, against fake hosts ───────────────────────────────

const NJ_HEADERS = { "content-type": "application/json", "cache-control": "no-cache", server: "nginx", etag: '"v1"' };
const json = (body, { status = 200, headers = NJ_HEADERS } = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const plain = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const cloudflare403 = () => new Response(
  "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>",
  { status: 403, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "8d2f-VIE" } },
);

const OFFERS_PATH = /^\/nj-booking-ocp\/destinations\/offers\/([^/]+)\/(\d{7})\/(\d{7})\/(\d+)$/;

/**
 * nightjet.com as the fixture trains would have it now: every train runs
 * every night at 21:39 with its stored prices, except NJ 466 whose couchette
 * has gone up €5 and NJ 40421, which sells seats only.
 */
function nightjetNow({ priceShift = 0 } = {}) {
  let count = 0;
  return (u) => {
    if (u.pathname === "/robots.txt") return plain("User-agent: *\nDisallow: /nj-booking-ocp/booking/\n");
    const m = u.pathname.match(OFFERS_PATH);
    if (!m) return plain("not found", 404);
    const train = decodeURIComponent(m[1]);
    const date = viennaToday(Number(m[4]));
    const night = fixtureTrains()[train]?.fareCalendar.nights[date];
    const bestOffers = { se: sp(29.9, "Sparschiene") };
    if (night?.classes?.couchette) bestOffers.le = sp(night.classes.couchette + (train === "NJ 466" ? 5 : 0) + priceShift);
    if (night?.classes?.sleeperBed) bestOffers.be = sp(night.classes.sleeperBed + priceShift);
    count++;
    return json([journey(date, bestOffers)], { headers: { ...NJ_HEADERS, age: String(count) } });
  };
}

function fakeHosts({ nightjet = nightjetNow(), shop = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, path: u.pathname, url, method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body });
    if (u.hostname === "www.nightjet.com") return nightjet(u, opts);
    if (u.hostname === "shop.oebbtickets.at" && shop) return shop(u, opts);
    throw new Error(`unexpected request to ${u.hostname}`);
  };
  return { fetchImpl, calls };
}

async function probe({ config = {}, hosts, outDir = null, stepSummary = null }) {
  const sleeps = [];
  const lines = [];
  const result = await runProbe({
    outDir,
    stepSummary,
    fetchImpl: hosts.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    log: (l) => lines.push(l),
    trainsFile: { uploadedAt: "2026-10-10T03:00:00Z", data: { trains: fixtureTrains() } },
    config: { ...BASE_CONFIG, ...config },
    booking: readJson("data/overrides/operator-booking.json"),
  });
  return { result, sleeps, lines, calls: hosts.calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nj-fare-check-"));

await check("probe, nightjet.com answering: every night asked the nightly pass's way, compared, written out", async () => {
  const outDir = path.join(tmp, "normal");
  const stepSummary = path.join(tmp, "summary.md");
  const { result, sleeps, lines, calls } = await probe({ hosts: fakeHosts(), outDir, stepSummary });
  const nj = calls.filter((c) => c.host === "www.nightjet.com");
  assert.strictEqual(nj[0].path, "/robots.txt", "robots.txt first");
  assert.strictEqual(nj.length, result.plan.requests.length + 1);
  for (const c of nj) {
    assert.deepStrictEqual(Object.keys(c.headers).sort(), ["accept", "user-agent"]);
    assert.strictEqual(c.headers["user-agent"], HONEST_USER_AGENT);
  }
  // The same GET the nightly pass makes, for each sampled night.
  const trains = fixtureTrains();
  for (const [i, q] of result.plan.requests.entries()) {
    const ends = { fromId: trains[q.key].stations[0].id, toId: trains[q.key].stations.at(-1).id };
    assert.strictEqual(nj[i + 1].url, buildOffersUrl({ trainName: q.key, ...ends, date: q.night }));
  }
  assert.strictEqual(sleeps.filter((ms) => ms === 2000).length, nj.length - 1, "two seconds between requests");
  assert.ok(sleeps.includes(300_000), "the repeats wait out the gap");
  assert.strictEqual(result.nightjet.state, "ok");
  assert.strictEqual(result.summary.answered, result.summary.asked);
  assert.strictEqual(result.summary.repeats.same, 3);

  // NJ 466 moved €5; everything else matches, NJ 40421 included (no berth then or now).
  const r466 = result.rows.filter((r) => r.request.key === "NJ 466" && r.request.group !== "D");
  assert.ok(r466.every((r) => r.comparison.deltaCouchette === 5 && r.comparison.flags.includes(FLAGS.deltaCouchette)));
  const others = result.rows.filter((r) => r.request.key !== "NJ 466" && r.request.group !== "D");
  assert.ok(others.every((r) => r.comparison.exact === true), others.filter((r) => !r.comparison.exact).map((r) => r.request.key).join());
  assert.ok(result.rows.some((r) => r.comparison.flags.includes(`${FLAGS.non9}(partner)`)), "EN 40458's €296");
  assert.strictEqual(result.summary.cache["cache-control"].values["no-cache"], result.rows.filter((r) => r.headers).length);

  for (const f of ["report.md", "nj-fare-checklist.csv", "results.json", "probe-nj-fares.log", "robots-nightjet.txt"]) {
    assert.ok(fs.existsSync(path.join(outDir, f)), f);
  }
  assert.ok(fs.readdirSync(path.join(outDir, "raw")).length >= result.plan.requests.length);
  const csv = fs.readFileSync(path.join(outDir, "nj-fare-checklist.csv"), "utf8").trim().split("\n");
  assert.strictEqual(csv.length - 1, result.plan.requests.filter((r) => r.group !== "D").length, "one row per sampled night");
  assert.ok(csv[1].includes("https://shop.oebbtickets.at/en/ticket?"), "the dated shop link, from the live clocks");
  assert.ok(fs.readFileSync(stepSummary, "utf8").startsWith("## Nightjet fare check — 2026-10-10"));
  assert.ok(lines.some((l) => l.startsWith("═══ Summary")));
  assert.ok(lines.some((l) => /^\d+\s+[A-D] (NJ|EN) /.test(l)), "the fixed-width table");
  assert.ok(lines.some((l) => l.includes("shop.oebbtickets.at: off")));
  assert.ok(!calls.some((c) => c.host === "shop.oebbtickets.at"));
});

await check("probe: an answer that moves between the first ask and the repeat is flagged on both", async () => {
  const total = planSample(fixtureTrains(), normalizeConfig(BASE_CONFIG), { today: TODAY }).requests.length;
  let asked = 0;
  const before = nightjetNow();
  const after = nightjetNow({ priceShift: 10 });
  // The last three price searches are the repeats; by then every price has gone up €10.
  const moving = (u, opts) => {
    if (OFFERS_PATH.test(u.pathname)) asked++;
    return asked > total - 3 ? after(u, opts) : before(u, opts);
  };
  const { result } = await probe({ hosts: fakeHosts({ nightjet: moving }) });
  assert.strictEqual(result.summary.repeats.differ, 3);
  for (const d of result.rows.filter((r) => r.request.group === "D")) {
    assert.ok(d.comparison.flags.includes(FLAGS.repeatDiff));
    assert.ok(result.rows.find((r) => r.request.id === d.request.repeatOf).comparison.flags.includes(FLAGS.repeatDiff));
  }
});

await check("probe, Cloudflare 403 from nightjet.com: one request, BLOCKED, the rest not asked, a report all the same", async () => {
  const { result, lines, calls } = await probe({ hosts: fakeHosts({ nightjet: () => cloudflare403() }) });
  assert.strictEqual(calls.length, 1, "stops after the first refusal: no retry, no other host");
  assert.strictEqual(result.nightjet.state, "blocked");
  const blocked = lines.find((l) => l.startsWith("BLOCKED nightjet.com 403"));
  assert.ok(blocked && blocked.includes("server=cloudflare") && blocked.includes("cf-ray=8d2f-VIE") && blocked.includes("Attention Required"), blocked);
  assert.ok(result.rows.filter((r) => r.request.group !== "D").every((r) => r.skipped === "nightjet.com blocked"));
  assert.strictEqual(result.summary.answered, 0);
  assert.ok(lines.some((l) => l.includes("nightjet.com BLOCKED after 1 request(s)")));
  assert.ok(detectBlock({ status: 403, headers: { server: "cloudflare" }, body: "" }), "the shared reading of a block");
});

await check("probe, nightjet.com refusing the price search but not robots.txt: one price request, then nothing", async () => {
  const hosts = fakeHosts({ nightjet: (u) => (u.pathname === "/robots.txt" ? plain("User-agent: *\nAllow: /\n") : cloudflare403()) });
  const { result, calls } = await probe({ hosts });
  assert.deepStrictEqual(calls.map((c) => c.path.startsWith("/nj-booking-ocp") ? "offers" : c.path), ["/robots.txt", "offers"]);
  assert.strictEqual(result.rows[0].error.startsWith("BLOCKED"), true);
  assert.ok(result.rows.slice(1).every((r) => r.skipped));
});

await check("probe, nightjet.com answering the price search with a page and no block marker: stopped all the same", async () => {
  // detectBlock wants a marker before it calls a page a block; the check
  // stops on any 2xx that is not JSON, and on a redirect that left the host.
  const page = () => new Response("<!doctype html><html><body>Wartungsarbeiten</body></html>", {
    status: 200, headers: { "content-type": "text/html; charset=utf-8", server: "nginx" },
  });
  for (const answer of [page, () => plain("Service Unavailable")]) {
    const hosts = fakeHosts({ nightjet: (u) => (u.pathname === "/robots.txt" ? plain("User-agent: *\nAllow: /\n") : answer()) });
    const { result, lines, calls } = await probe({ hosts });
    assert.strictEqual(calls.length, 2, "robots.txt and one price search");
    assert.strictEqual(result.nightjet.state, "blocked");
    const blocked = lines.find((l) => l.startsWith("BLOCKED nightjet.com 200"));
    assert.ok(blocked && /where JSON was asked for/.test(blocked), blocked);
    assert.ok(result.rows.slice(1).filter((r) => r.request.group !== "D").every((r) => r.skipped === "nightjet.com blocked"));
  }
  const redirected = () => {
    const res = json([]);
    Object.defineProperty(res, "redirected", { value: true });
    Object.defineProperty(res, "url", { value: "https://www.nightjet.com/cdn-cgi/challenge-platform/h/b" });
    return res;
  };
  const hosts = fakeHosts({ nightjet: (u) => (u.pathname === "/robots.txt" ? plain("") : redirected()) });
  const { result, lines } = await probe({ hosts });
  assert.strictEqual(result.nightjet.state, "blocked");
  assert.ok(lines.some((l) => l.startsWith("BLOCKED nightjet.com") && l.includes("redirected to https://www.nightjet.com/cdn-cgi/")));
});

await check("probe, nightjet.com unreachable (the sandbox): three failures, then a report that says so", async () => {
  const hosts = fakeHosts({
    nightjet: () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    },
  });
  const { result, lines, calls } = await probe({ hosts });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(result.nightjet.state, "unreachable");
  assert.ok(lines.some((l) => l.startsWith("UNREACHABLE nightjet.com")));
  assert.ok(lines.some((l) => l.includes("nightjet.com unreachable after 3 request(s)")));
});

const ALLOWED_SHOP_HEADERS = new Set(["accept", "content-type", "channel", "accesstoken", "user-agent"]);

function assertHonestShopCalls(calls) {
  for (const c of calls.filter((x) => x.host === "shop.oebbtickets.at")) {
    const names = Object.keys(c.headers).map((h) => h.toLowerCase());
    for (const h of names) assert.ok(ALLOWED_SHOP_HEADERS.has(h), `${c.path} sent ${h}`);
    assert.strictEqual(c.headers["user-agent"], HONEST_USER_AGENT);
    if (c.path.startsWith("/api/")) assert.strictEqual(c.headers.channel, "inet");
  }
}

await check("probe, the shop refusing its token with a 403: the shop step ends after that one API request, nightjet.com's part complete", async () => {
  const shop = (u) => (u.pathname === "/robots.txt" ? plain("User-agent: *\nDisallow: /en/checkout\n") : cloudflare403());
  const { result, lines, calls } = await probe({ hosts: fakeHosts({ shop }), config: { shop: { enabled: true, maxTrainNights: 3 } } });
  const shopCalls = calls.filter((c) => c.host === "shop.oebbtickets.at");
  assert.deepStrictEqual(shopCalls.map((c) => c.path), ["/robots.txt", "/api/domain/v1/anonymousToken"]);
  assert.strictEqual(result.shop.state, "blocked");
  assert.strictEqual(result.shop.apiRequests, 1);
  const blocked = lines.find((l) => l.startsWith("BLOCKED shop.oebbtickets.at 403"));
  assert.ok(blocked && blocked.includes("server=cloudflare") && blocked.includes("Attention Required"), blocked);
  assertHonestShopCalls(calls);
  assert.strictEqual(result.nightjet.state, "ok");
  assert.strictEqual(result.summary.answered, result.summary.asked, "the nightjet.com part is complete");
  assert.strictEqual(result.summary.repeats.answered, 3, "…repeats included, after the shop step");
});

await check("probe, the shop's robots.txt disallowing /api/: no API request at all", async () => {
  const shop = (u) => (u.pathname === "/robots.txt" ? plain("User-agent: *\nDisallow: /api/\n") : json({}));
  const { result, calls } = await probe({ hosts: fakeHosts({ shop }), config: { shop: { enabled: true } } });
  assert.deepStrictEqual(calls.filter((c) => c.host === "shop.oebbtickets.at").map((c) => c.path), ["/robots.txt"]);
  assert.strictEqual(result.shop.state, "skipped");
});

await check("probe, the shop answering (synthetic): token, session, timetable and offers for three nights, honest headers, token never logged", async () => {
  const outDir = path.join(tmp, "shop");
  const seen = [];
  const shop = (u, opts) => {
    seen.push(u.pathname);
    if (u.pathname === "/robots.txt") return new Response("<!doctype html><app-root></app-root>", { headers: { "content-type": "text/html" } });
    if (u.pathname === "/api/domain/v1/anonymousToken") return json({ access_token: "tok-SECRET-123", expires_in: 2300 });
    if (u.pathname === "/api/domain/v1/initUserData") {
      assert.strictEqual(opts.headers.accesstoken, "tok-SECRET-123");
      return new Response(null, { status: 204 });
    }
    if (u.pathname === "/api/hafas/v4/timetable") {
      const body = JSON.parse(opts.body);
      const date = body.datetimeDeparture.slice(0, 10);
      const key = Object.entries(fixtureTrains()).find(([, t]) =>
        t.stations[0].id === String(body.from.number) && t.stations.at(-1).id === String(body.to.number))[0];
      const [name, number] = key.split(" ");
      return json({
        connections: [{
          id: `conn-${number}-${date}`, switches: 0,
          from: { esn: body.from.number, departure: `${date}T21:39:00.000` },
          to: { esn: body.to.number, arrival: `${addDays(date, 1)}T09:30:00.000` },
          sections: [{ type: "journey", category: { name, number } }],
        }],
      });
    }
    if (u.pathname === "/api/offer/v6/offers") {
      assert.ok(JSON.parse(opts.body).selection.connectionId.startsWith("conn-"));
      return json(SHOP_OFFERS);
    }
    return plain("not found", 404);
  };
  const { result, lines, calls } = await probe({ hosts: fakeHosts({ shop }), outDir, config: { shop: { enabled: true, maxTrainNights: 3 } } });
  assert.strictEqual(result.shop.state, "done");
  assert.strictEqual(result.shop.results.length, 3);
  assert.ok(result.shop.results.every((r) => r.offers?.couchette.min === 59.9 && r.offers.berth.min === 99.9));
  assert.deepStrictEqual(seen.slice(0, 3), ["/robots.txt", "/api/domain/v1/anonymousToken", "/api/domain/v1/initUserData"]);
  assert.strictEqual(seen.length, 3 + 3 * 2);
  assertHonestShopCalls(calls);
  const sleeps = (await probe({ hosts: fakeHosts({ shop }), config: { shop: { enabled: true, maxTrainNights: 1 } } })).sleeps;
  assert.ok(sleeps.filter((ms) => ms === 5000).length >= 4, "five seconds between shop requests");
  assert.ok(!lines.join("\n").includes("tok-SECRET-123"), "the token is not logged");
  for (const f of fs.readdirSync(outDir, { recursive: true })) {
    const p = path.join(outDir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes("tok-SECRET-123"), `token written to ${f}`);
  }
  assert.ok(lines.some((l) => l.includes("a page, not rules")), "an HTML robots.txt is read as no rules, and said so");
});

await check("probe, the shop step throwing on a surprise: the nightjet.com report is unaffected", async () => {
  const shop = (u) => {
    if (u.pathname === "/robots.txt") return plain("");
    if (u.pathname === "/api/domain/v1/anonymousToken") return json({ access_token: "t" });
    // An answer the step's own reading trips over, outside any request's try.
    return { status: 200, headers: { get() { throw new Error("headers exploded"); } }, text: async () => "" };
  };
  const { result, lines } = await probe({ hosts: fakeHosts({ shop }), config: { shop: { enabled: true } } });
  assert.strictEqual(result.shop.state, "error");
  assert.ok(lines.some((l) => l.includes("headers exploded") && l.includes("the nightjet.com report is unaffected")));
  assert.strictEqual(result.nightjet.state, "ok");
  assert.strictEqual(result.summary.answered, result.summary.asked);
  assert.strictEqual(result.summary.repeats.answered, 3);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nverify-nj-fare-check: ${passed} checks passed`);
