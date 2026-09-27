// tests/verify-icn-fares.mjs
// Trenitalia Intercity Notte fares from lefrecce.it: station-id mapping,
// response parsing (berth before seat), the adapter's search loop and the
// stamp onto the icn_ rows. No network. Run: npm run verify-icn-fares

import assert from "node:assert";
import {
  classifyService,
  describeSolutions,
  lefrecceLocationId,
  parseAmount,
  parseSolutionsFare,
  resolveLocationIdByName,
  searchTrainFare,
  romeClock,
  searchTimeBefore,
  solutionsRequestBody,
} from "../scripts/lib/lefrecce.mjs";
import { fillFareCalendars } from "../scripts/adapters/viaggiatreno.mjs";
import {
  calendarWindow,
  cheapestNight,
  FARE_CALENDAR_BUDGET,
  FARE_CALENDAR_VERSION,
  planFareSearches,
  pruneCalendar,
} from "../scripts/lib/fare-calendar.mjs";
import { carryPreviousFares } from "../scripts/lib/fares.mjs";
import { calendarMonths, fareCalendarDays, formatNight } from "../src/lib/fareCalendarView.mjs";
import { buildBookingUrl, buildDatedBookingLink } from "../src/lib/operatorBooking.js";
import { stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import {
  fareClassRows,
  directionFare,
  directionFareSummary,
  fareClassLabel,
  formatTravelDate,
  formatTravelDateShort,
  fareContext,
  pricingForDirection,
} from "../src/lib/fareClasses.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("lefrecceLocationId: 830 + the six digits of the Viaggiatreno code", () => {
  assert.strictEqual(lefrecceLocationId("S01700"), 830001700); // Milano Centrale
  assert.strictEqual(lefrecceLocationId("S08409"), 830008409); // Roma Termini
  assert.strictEqual(lefrecceLocationId("s12349"), 830012349); // Siracusa
  assert.strictEqual(lefrecceLocationId("NSR:Quay:1"), null);
  assert.strictEqual(lefrecceLocationId(null), null);
});

check("parseAmount: numbers, comma decimals, currency strings", () => {
  assert.strictEqual(parseAmount(39.9), 39.9);
  assert.strictEqual(parseAmount("39,90"), 39.9);
  assert.strictEqual(parseAmount("€ 119.00"), 119);
  assert.strictEqual(parseAmount(0), null);
  assert.strictEqual(parseAmount(null), null);
});

check("classifyService: seat / couchette / sleeper cabin, Italian and English", () => {
  assert.strictEqual(classifyService("Posto a sedere 2a classe"), "seat");
  assert.strictEqual(classifyService("Cuccetta Comfort 4 posti"), "couchette");
  assert.strictEqual(classifyService("Couchette 4 berths"), "couchette");
  assert.strictEqual(classifyService("Vagone Letto Singolo"), "sleeperCabin");
  assert.strictEqual(classifyService("Sleeper Excelsior"), "sleeperCabin");
  assert.strictEqual(classifyService("Bici"), null);
});

const RESPONSE = {
  solutions: [
    {
      // An earlier departure on the same pair: must not be priced as ours.
      solution: { trains: [{ name: "1955", acronym: "ICN" }], price: { amount: 19.9 } },
      grids: [{ services: [{ name: "Posto a sedere", offers: [{ price: { amount: 19.9 } }] }] }],
    },
    {
      solution: { trains: [{ name: "1963", acronym: "ICN" }], price: { currency: "€", amount: 29.9 } },
      grids: [
        {
          services: [
            { name: "Posto a sedere 2a classe", offers: [{ name: "Base", price: { amount: 49.9 } }, { name: "Economy", price: { amount: 29.9 } }] },
            { name: "Cuccetta Comfort 4 posti", offers: [{ name: "Base", price: { amount: 79.9 } }, { name: "Super Economy", price: { amount: 59.9 }, status: "SALEABLE" }] },
            // Sold out is not a fare anyone can buy.
            { name: "Vagone Letto Singolo", offers: [{ price: { amount: 49 }, status: "NOT_AVAILABLE" }, { price: { amount: 169 } }] },
          ],
        },
      ],
    },
  ],
};

check("parseSolutionsFare: our train only; from-price is the cheapest BERTH, not the seat", () => {
  const fare = parseSolutionsFare(RESPONSE, "1963");
  assert.deepStrictEqual(fare, {
    fromPrice: 59.9,
    currency: "EUR",
    seatClass: "couchette",
    classes: { couchette: 59.9, sleeperCabin: 169 },
    matchedBy: "number",
  });
});

check("parseSolutionsFare: seats never count — seats-only train or no grid → no fare", () => {
  assert.strictEqual(parseSolutionsFare(RESPONSE, "1955"), null, "a seats-only train gets no fare");
  const bare = { solutions: [{ solution: { trains: [{ name: "770" }], price: { amount: 44 } } }] };
  assert.strictEqual(parseSolutionsFare(bare, "770"), null, "the headline price is a seat, not a berth");
  assert.strictEqual(parseSolutionsFare(RESPONSE, "999"), null);
  assert.strictEqual(parseSolutionsFare({}, "1963"), null);
});

// The Palermo–Messina portions: sold under the main train's number, so ours
// (1954) is nowhere on the ticket — but the minute it leaves is.
const PORTION = {
  solutions: [
    { solution: { departureTime: "2026-10-18T14:05:00.000+02:00", trains: [{ acronym: "R", name: "5321" }], price: { amount: 12 } } },
    {
      solution: { departureTime: "2026-10-18T15:25:00.000+02:00", trains: [{ acronym: "ICN", name: "1956" }] },
      grids: [{ services: [{ name: "Cuccetta 4 posti", offers: [{ price: { amount: 39.9 } }] }] }],
    },
    // A regional leaving the same minute must not be taken for the sleeper.
    { solution: { departureTime: "2026-10-18T15:25:00.000+02:00", trains: [{ acronym: "R", name: "5323" }], price: { amount: 9 } } },
  ],
};

check("parseSolutionsFare: a portion sold under another number matches by departure minute + night category", () => {
  const fare = parseSolutionsFare(PORTION, "1954", { departureClock: "15:25" });
  assert.strictEqual(fare.fromPrice, 39.9);
  assert.strictEqual(fare.matchedBy, "departure");
  assert.strictEqual(parseSolutionsFare(PORTION, "1954", { departureClock: "16:00" }), null, "wrong minute → no match");
  assert.strictEqual(parseSolutionsFare(PORTION, "1954"), null, "no clock → number only");
  const twoNight = { solutions: [...PORTION.solutions, { solution: { departureTime: "2026-10-18T15:26:00", trains: [{ acronym: "ICN", name: "1958" }], price: { amount: 50 } } }] };
  assert.strictEqual(parseSolutionsFare(twoNight, "1954", { departureClock: "15:25" }), null, "two night trains in the window → price neither");
});

check("describeSolutions: what the search returned, for the log", () => {
  assert.deepStrictEqual(describeSolutions(PORTION), ["R 5321 14:05", "ICN 1956 15:25", "R 5323 15:25"]);
  assert.deepStrictEqual(describeSolutions({}), []);
});

check("romeClock / searchTimeBefore: Italian wall clock, a few minutes early", () => {
  assert.strictEqual(romeClock("2026-09-27T16:10:00.000Z"), "18:10"); // CEST
  assert.strictEqual(romeClock("2026-12-01T17:10:00.000Z"), "18:10"); // CET
  assert.strictEqual(searchTimeBefore("18:10"), "18:05");
  assert.strictEqual(searchTimeBefore("00:02"), "00:00");
});

check("solutionsRequestBody: direct trains only, from the given local time", () => {
  const b = solutionsRequestBody({ fromId: 830001700, toId: 830012349, date: "2026-10-18", time: "18:05" });
  assert.strictEqual(b.departureTime, "2026-10-18T18:05:00.000");
  assert.strictEqual(b.criteria.noChanges, true);
  assert.strictEqual(b.departureLocationId, 830001700);
});

const TRAIN = {
  lineName: "ICN 1963",
  stations: [
    { name: "Milano Centrale", code: "S01700", departure: "2026-09-27T16:10:00.000Z" },
    { name: "Siracusa", code: "S12349", arrival: "2026-09-28T10:00:00.000Z" },
  ],
};
const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

check("fare calendar: window, pruning, and the cheapest night as the headline", () => {
  const window = calendarWindow("2026-09-27", 42);
  assert.strictEqual(window.length, 42);
  assert.strictEqual(window[0], "2026-09-28", "tomorrow first");
  assert.strictEqual(window[41], "2026-11-08");
  const pruned = pruneCalendar(
    {
      version: FARE_CALENDAR_VERSION,
      currency: "EUR",
      nights: {
        "2026-09-27": { classes: { couchette: 10 }, checkedAt: "2026-09-26" }, // tonight: gone
        "2026-10-01": { classes: { couchette: 60 }, checkedAt: "2026-09-01" }, // stale check
        "2026-10-02": { none: true, checkedAt: "2026-09-26" },
        "2026-10-03": { classes: { couchette: 54.9, sleeperCabin: 117.9 }, checkedAt: "2026-09-25" },
        "2027-01-01": { classes: { couchette: 5 }, checkedAt: "2026-09-26" }, // beyond the window
      },
    },
    { today: "2026-09-27", days: 42 },
  );
  assert.deepStrictEqual(Object.keys(pruned.nights), ["2026-10-02", "2026-10-03"]);
  pruned.nights["2026-10-04"] = { classes: { couchette: 54.9 }, checkedAt: "2026-09-27" };
  assert.deepStrictEqual(cheapestNight(pruned), {
    fromPrice: 54.9,
    currency: "EUR",
    seatClass: "couchette",
    classes: { couchette: 54.9, sleeperCabin: 117.9 },
    sampledAt: "2026-09-25",
    travelDate: "2026-10-03",
  }, "a tie keeps the nearer night");
  assert.strictEqual(cheapestNight({ currency: "EUR", nights: { "2026-10-02": { none: true, checkedAt: "x" } } }), null);
});

check("planFareSearches: never-checked nights first, nearest first, trains interleaved; budget holds", () => {
  const today = "2026-09-27";
  const plan = planFareSearches(
    {
      "ICN 797": { nights: { "2026-09-28": { none: true, checkedAt: "2026-09-20" } } },
      "ICN 796": { nights: { "2026-09-28": { classes: { couchette: 70 }, checkedAt: today } } },
    },
    { today, days: 3, budget: 5 },
  );
  assert.deepStrictEqual(plan, [
    { key: "ICN 796", date: "2026-09-29" },
    { key: "ICN 797", date: "2026-09-29" },
    { key: "ICN 796", date: "2026-09-30" },
    { key: "ICN 797", date: "2026-09-30" },
    // then the stalest check; ICN 796's night checked today is never redone today
    { key: "ICN 797", date: "2026-09-28" },
  ]);
  assert.strictEqual(planFareSearches({ a: {} }, { today, days: 42, budget: 0 }).length, 0);
  // The default budget over the default window: ~1 050 nights for 25 trains
  // cannot all be searched in one night, and the plan says so.
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`ICN ${i}`, {}]));
  assert.strictEqual(planFareSearches(many, { today }).length, FARE_CALENDAR_BUDGET);
});

{
  // One run over two trains: 1963 runs every night but the first; 1955's
  // station is refused and no name resolves it, so it is skipped for the
  // night after one failure rather than burning the budget.
  const TRAIN_B = {
    lineName: "ICN 1955",
    stations: [
      { name: "Nowhere", code: "S99999", departure: "2026-09-27T16:10:00.000Z" },
      { name: "Siracusa", code: "S12349", arrival: "2026-09-28T10:00:00.000Z" },
    ],
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("/locations/search")) return jsonResponse([]);
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.departureLocationId === 830099999) return jsonResponse({ error: "bad location" }, 400);
    return jsonResponse(body.departureTime.startsWith("2026-09-28") ? { solutions: [] } : RESPONSE);
  };
  const trains = { "ICN 1963": structuredClone(TRAIN), "ICN 1955": structuredClone(TRAIN_B) };
  const previous = {
    "ICN 1963": {
      fareCalendar: {
        version: FARE_CALENDAR_VERSION,
        currency: "EUR",
        nights: { "2026-10-05": { classes: { couchette: 44.9 }, checkedAt: "2026-09-26" } },
      },
    },
  };
  const stats = await fillFareCalendars(trains, previous, {
    today: "2026-09-27",
    fetchImpl,
    log: () => {},
    days: 3,
    budget: 10,
    spacingMs: 0,
  });
  // A 400 is lefrecce's "no direct train on this pair tonight", so it is a
  // night without a train, not a failure — but a train never once answered
  // for is given up after three in a row (a refused station reads the same).
  assert.strictEqual(stats.errors, 0);
  assert.strictEqual(stats.noTrain, 3);
  assert.strictEqual(calls.filter((b) => b.departureLocationId === 830099999).length, 3);
  const cal = trains["ICN 1963"].fareCalendar;
  assert.deepStrictEqual(Object.keys(cal.nights), ["2026-09-28", "2026-09-29", "2026-09-30"],
    "last run's 5 Oct is outside a 3-night window and pruned");
  assert.deepStrictEqual(cal.nights["2026-09-28"], { none: true, checkedAt: "2026-09-27" });
  assert.deepStrictEqual(cal.nights["2026-09-29"], { classes: { couchette: 59.9, sleeperCabin: 169 }, checkedAt: "2026-09-27" });
  assert.strictEqual(trains["ICN 1963"].fare.fromPrice, 59.9);
  assert.strictEqual(trains["ICN 1963"].fare.travelDate, "2026-09-29", "the cheapest night, the nearer on a tie");
  assert.strictEqual(trains["ICN 1955"].fare, undefined);
  assert.deepStrictEqual(Object.values(trains["ICN 1955"].fareCalendar.nights).map((e) => e.none), [true, true, true]);

  // The operator turning us away (a block page on every call) stops the pass.
  let n = 0;
  const blocked = await fillFareCalendars(
    Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`ICN ${i}`, { ...structuredClone(TRAIN), lineName: `ICN ${1900 + i}` }])),
    null,
    { today: "2026-09-27", fetchImpl: async () => (n++, jsonResponse("<html>Access denied</html>", 403)), log: () => {}, days: 3, spacingMs: 0 },
  );
  assert.strictEqual(blocked.stopped, true);
  assert.strictEqual(n, 5, "five failures in a row and no more requests");
  passed++;
  console.log("  ✓ fillFareCalendars: builds on last run, skips a failing train, stops when blocked, never throws");
}

check("carryPreviousFares: a dynamic fare for a night already past is not carried", () => {
  const prev = { A: { fare: { fromPrice: 50, currency: "EUR", sampledAt: "2026-09-20", travelDate: "2026-09-25" } } };
  const dynamic = { A: {} };
  assert.strictEqual(carryPreviousFares(dynamic, prev, { today: "2026-09-27", dated: true }), 0);
  // 12306's search date says nothing about a fixed tariff: still carried.
  const fixed = { A: {} };
  assert.strictEqual(carryPreviousFares(fixed, prev, { today: "2026-09-27" }), 1);
});

{
  // A station id lefrecce refuses (Siracusa): 400, then a lookup by name, then a retry.
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("/locations/search")) {
      const name = decodeURIComponent(url.match(/name=([^&]+)/)[1]);
      const table = {
        Siracusa: [{ id: 830099999, name: "Siracusa", multistation: false }, { id: 1, name: "Siracusa (Tutte Le Stazioni)", multistation: true }],
        "Milano Centrale": [{ id: 830001700, name: "Milano Centrale" }],
      };
      return jsonResponse(table[name] ?? []);
    }
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.arrivalLocationId === 830012349) return jsonResponse({ error: "bad location" }, 400);
    return jsonResponse(RESPONSE);
  };
  const ids = new Map();
  const first = await searchTrainFare(
    { fromCode: "S01700", toCode: "S12349", fromName: "Milano Centrale", toName: "Siracusa", date: "2026-10-18", time: "18:05", trainNumber: "1963" },
    { fetchImpl, ids },
  );
  assert.strictEqual(first.fare.fromPrice, 59.9);
  assert.deepStrictEqual(bodies.map((b) => b.arrivalLocationId), [830012349, 830099999]);
  assert.strictEqual(ids.get("S12349"), 830099999, "resolved id is cached for the night");
  bodies.length = 0;
  await searchTrainFare(
    { fromCode: "S01700", toCode: "S12349", fromName: "Milano Centrale", toName: "Siracusa", date: "2026-10-19", time: "18:05", trainNumber: "1963" },
    { fetchImpl, ids },
  );
  assert.deepStrictEqual(bodies.map((b) => b.arrivalLocationId), [830099999], "no second 400 once cached");
  assert.strictEqual(await resolveLocationIdByName("Nowhere", { fetchImpl }), null);
  passed++;
  console.log("  ✓ searchTrainFare: a refused station id is resolved by name, retried, and cached");
}

check("stampOfficialFares: an official (not trusted) source prices its own rows", () => {
  const registry = [{ id: "italian", enabled: true, official: true, trusted: false }];
  const viewMap = {
    icn_ICN_1962: { route_id: "icn_ICN_1962", agency_id: "FS", timetable_source: "italian", trip_short_name_0: "ICN 1962", trip_short_name_1: "ICN 1963" },
  };
  const operatorTrains = {
    italian: {
      "ICN 1962": {
        fare: { fromPrice: 64.9, currency: "EUR", seatClass: "couchette", classes: { couchette: 64.9 }, sampledAt: "2026-09-27" },
        fareCalendar: { currency: "EUR", nights: { "2026-10-18": { classes: { couchette: 64.9 }, checkedAt: "2026-09-27" } } },
      },
      // An older file may still carry a seat: it must not be listed.
      "ICN 1963": { fare: { fromPrice: 59.9, currency: "EUR", seatClass: "couchette", classes: { seat: 29.9, couchette: 59.9, sleeperCabin: 169 }, sampledAt: "2026-09-27", travelDate: "2026-10-18" } },
    },
  };
  assert.strictEqual(stampOfficialFares(viewMap, {}, operatorTrains, registry), 1);
  const row = viewMap.icn_ICN_1962;
  assert.strictEqual(row.pricing.fromPrice, 59.9);
  assert.strictEqual(row.pricing.currency, "EUR");
  assert.deepStrictEqual(
    fareClassRows(directionFare(row, 1), { from: true }).map((r) => `${r.label} ${r.price}`),
    ["Couchette from €59.9", "Sleeper cabin from €169"],
  );
  // The connection page decides "from" off the row's own fare model.
  assert.deepStrictEqual(
    directionFareSummary(row, 1).classes.map((r) => r.price),
    ["from €59.9", "from €169"],
  );
  assert.strictEqual(fareClassLabel(row.pricing.seatClass), "Couchette");
  assert.strictEqual(row.pricing.type, "dynamic", "FS has a fare model, so the Price badge renders");
  // A dynamic fare is one night's price, and every surface can say which night.
  assert.strictEqual(row.fare_1.travelDate, "2026-10-18");
  assert.strictEqual(row.pricing.travelDate, "2026-10-18", "the row's figure is 1963's, so is its date");
  assert.strictEqual(pricingForDirection(row, 1).travelDate, "2026-10-18");
  assert.strictEqual(directionFareSummary(row, 1).travelLabel, "for travel on 18 Oct 2026");
  // The same date on a fixed tariff is not shown: its price does not depend on it.
  assert.strictEqual(directionFareSummary(row, 1, { dynamic: false }).travelLabel, "");
  // The route-wide figure names the berth and train it is, so a tile quoting
  // the cheaper direction does not read as a seat price or a contradiction.
  assert.strictEqual(row.pricing.trainName, "ICN 1963");
  assert.strictEqual(fareContext(row.pricing), "Couchette · ICN 1963, for travel on 18 Oct 2026");
  assert.strictEqual(fareContext({ seatClass: "couchette" }), "Couchette");
  assert.strictEqual(fareContext(null), "");
  // Each direction's calendar rides along for the connection pages — only the
  // direction whose train keeps one.
  assert.deepStrictEqual(Object.keys(row.fare_calendar_0.nights), ["2026-10-18"]);
  assert.strictEqual(row.fare_calendar_1, undefined);
  // A fare quoted with no date states none rather than a guess.
  assert.strictEqual(row.fare_0.travelDate, undefined);
  assert.strictEqual(pricingForDirection(row, 0).travelDate, null);
  assert.strictEqual(directionFareSummary(row, 0).travelLabel, "");
});

check("formatTravelDate: a fixed table, never Intl, and nothing for a bad date", () => {
  assert.strictEqual(formatTravelDate("2026-01-05"), "for travel on 5 Jan 2026");
  assert.strictEqual(formatTravelDateShort("2026-12-31"), "31 Dec");
  for (const bad of [null, undefined, "", "2026-13-01", "18 Oct", "2026-10-18T00:00"]) {
    assert.strictEqual(formatTravelDate(bad), "", String(bad));
  }
});

check("fareCalendarDays: every night from tomorrow to the last priced, banded by this train's own range", () => {
  const calendar = {
    currency: "EUR",
    nights: {
      "2026-09-27": { classes: { couchette: 1 }, checkedAt: "2026-09-26" }, // today: left out
      "2026-09-28": { classes: { couchette: 90, sleeperCabin: 200 }, checkedAt: "2026-09-27" },
      "2026-09-29": { none: true, checkedAt: "2026-09-27" },
      // 30 Sep never checked
      "2026-10-01": { classes: { couchette: 53.6, seat: 20 }, checkedAt: "2026-09-26" },
      "2026-10-02": { classes: { couchette: 53.6 }, checkedAt: "2026-09-27" },
      "2026-10-03": { classes: { couchette: 70 }, checkedAt: "2026-09-27" },
    },
  };
  const view = fareCalendarDays(calendar, { today: "2026-09-27", bookingDate: (iso) => `x${iso}` });
  assert.deepStrictEqual(view.days.map((d) => `${d.date.slice(8)}:${d.state}:${d.tier ?? "-"}`), [
    "28:priced:high", "29:none:-", "30:unknown:-", "01:priced:low", "02:priced:low", "03:priced:mid",
  ]);
  assert.strictEqual(view.cheapestDate, "2026-10-01", "the earlier of two equally cheap nights");
  const oct1 = view.days[3];
  assert.deepStrictEqual(oct1.classes, [{ key: "couchette", label: "Couchette", price: "from €53.6" }], "never a seat");
  assert.strictEqual(oct1.price, "€53.6");
  assert.strictEqual(oct1.bookingDate, "x2026-10-01");
  assert.strictEqual(fareCalendarDays({ currency: "EUR", nights: { "2026-10-01": { none: true } } }, { today: "2026-09-27" }), null,
    "a calendar with no priced night renders nothing");
  assert.strictEqual(fareCalendarDays(null, { today: "2026-09-27" }), null);
});

check("calendarMonths: Monday-first grids split at the month, fixed names", () => {
  const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-05"].map((date) => ({ date }));
  const months = calendarMonths(days);
  assert.deepStrictEqual(months.map((m) => m.title), ["September 2026", "October 2026"]);
  assert.deepStrictEqual(months[0].weeks[0].map((d) => d?.date.slice(8) ?? null), ["28", "29", "30", null, null, null, null]);
  assert.deepStrictEqual(months[1].weeks.map((w) => w.map((d) => d?.date.slice(8) ?? null)), [
    [null, null, null, "01", null, null, null],
    ["05", null, null, null, null, null, null],
  ]);
  assert.strictEqual(formatNight("2026-10-04"), "Sun 4 Oct");
  assert.strictEqual(formatNight("nope"), "");
});

check("buildDatedBookingLink: Trenitalia opens on the chosen night; the plain CTA stays undated", () => {
  const link = buildDatedBookingLink({ agencyId: "FS", origin: "Torino Porta Nuova", dest: "Salerno" });
  assert.ok(link.template.includes("minisitiCallBackId=60958"), "same partner link as the CTA");
  assert.ok(link.template.endsWith("&departureDate={date}"));
  assert.strictEqual(link.dateFor("2026-10-04"), "04-10-2026");
  const plain = buildBookingUrl({ agencyId: "FS", origin: "Torino Porta Nuova", dest: "Salerno" });
  assert.ok(!plain.includes("departureDate"), "no night chosen, no date in the link");
  assert.ok(buildBookingUrl({ agencyId: "FS", origin: "A", dest: "B", isoDate: "2026-10-04" }).endsWith("&departureDate=04-10-2026"));
  // An operator whose link takes no date offers none.
  assert.strictEqual(buildDatedBookingLink({ agencyId: "PKP", origin: "A", dest: "B" }), null);
});

check("parseSolutionsFare: a departure match never takes another train we track (771 is not 770)", () => {
  const twin = {
    solutions: [
      {
        solution: { departureTime: "2026-10-02T18:47:00.000+02:00", trains: [{ acronym: "NI", denomination: "Intercity Notte", name: "770" }] },
        grids: [{ services: [{ name: "Cuccetta 4 posti", offers: [{ price: { amount: 55.9 } }] }] }],
      },
    ],
  };
  // The fault: 771 does not run that night, 770 leaves the same minute.
  assert.strictEqual(parseSolutionsFare(twin, "771", { departureClock: "18:47" }).fromPrice, 55.9);
  assert.strictEqual(parseSolutionsFare(twin, "771", { departureClock: "18:47", otherTrains: ["770"] }), null);
  // A portion sold under a number we do not track still matches.
  assert.strictEqual(parseSolutionsFare(twin, "1954", { departureClock: "18:47", otherTrains: ["771"] }).matchedBy, "departure");
});

{
  // A proven train's 400 is a night without it; a calendar from an older
  // reading rule is dropped rather than trusted.
  const trains = { "ICN 1963": structuredClone(TRAIN) };
  const previous = {
    "ICN 1963": {
      fareCalendar: {
        version: 1,
        currency: "EUR",
        nights: { "2026-09-28": { classes: { couchette: 1 }, checkedAt: "2026-09-26" } },
      },
    },
  };
  const fetchImpl = async (url, init) => {
    // The first 400 makes searchTrainFare look both stations up by name once;
    // the ids come back unchanged, so the answer stands.
    if (url.includes("/locations/search")) {
      const name = decodeURIComponent(url.match(/name=([^&]+)/)[1]);
      return jsonResponse([{ id: name === "Siracusa" ? 830012349 : 830001700, name }]);
    }
    const body = JSON.parse(init.body);
    return body.departureTime.startsWith("2026-09-29") ? jsonResponse({ error: "no solutions" }, 400) : jsonResponse(RESPONSE);
  };
  const stats = await fillFareCalendars(trains, previous, { today: "2026-09-27", fetchImpl, log: () => {}, days: 3, spacingMs: 0 });
  const nights = trains["ICN 1963"].fareCalendar.nights;
  assert.strictEqual(trains["ICN 1963"].fareCalendar.version, 2);
  assert.strictEqual(nights["2026-09-28"].classes.couchette, 59.9, "the v1 entry (€1) was dropped and searched again");
  assert.deepStrictEqual(nights["2026-09-29"], { none: true, checkedAt: "2026-09-27" });
  assert.strictEqual(nights["2026-09-30"].classes.couchette, 59.9, "a 400 does not skip the train's later nights");
  assert.strictEqual(stats.errors, 0);
  passed++;
  console.log("  ✓ fillFareCalendars: a 400 is a night without the train; old-rule calendars are dropped");
}

console.log(`\n[verify-icn-fares] ${passed} checks passed`);
