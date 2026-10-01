// tests/verify-es-fares.mjs
// European Sleeper fares: the booking API reader (scripts/lib/es-fares.mjs),
// the last-minute deal parser (scripts/lib/es-last-minute.mjs), the nightly
// calendar pass that joins them (scripts/lib/es-fare-calendar.mjs), and what
// the connection page makes of a deal (src/lib/lastMinuteDeals.mjs).
//
// No network. The API answers below follow the operator's published OpenAPI
// description; the landing-page markup is SYNTHETIC — the dev sandbox cannot
// reach www.europeansleeper.eu — and covers the shapes a deal form could take.
// Replace with real markup once `npm run probe-es-fares` has fetched some.
// Run: npm run verify-es-fares

import assert from "node:assert";
import {
  cheapestFare,
  classesFromAvailability,
  classifyPlaceType,
  constantsStations,
  foldName,
  nightsFromTrainSearch,
  resolveStationId,
  trainSearchBody,
  availabilityBody,
} from "../scripts/lib/es-fares.mjs";
import {
  dealKind,
  fetchLastMinuteDeals,
  findDates,
  findDealIds,
  findLandingPaths,
  parseEuroAmount,
  parseLastMinutePage,
} from "../scripts/lib/es-last-minute.mjs";
import {
  applyDeals,
  fillEsFareCalendars,
  stripDeals,
} from "../scripts/lib/es-fare-calendar.mjs";
import { FARE_CALENDAR_VERSION } from "../scripts/lib/fare-calendar.mjs";
import { fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { dealsSummary, lastMinuteProgramme, nightDeal } from "../src/lib/lastMinuteDeals.mjs";
import { fareClassLabel, FARE_CLASS_LABELS } from "../src/lib/fareClasses.mjs";
import { buildDatedBookingLink, buildDealsLandingUrl } from "../src/lib/operatorBooking.js";
import { stampOfficialFares } from "../src/pages/api/lib/build-initial-data.mjs";
import fs from "node:fs";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const TODAY = "2026-10-01";

// ─── API answers (shape from the operator's OpenAPI description) ─────────

const CONSTANTS = {
  settings: { maxReservationDate: "2027-03-18" },
  stations: [
    { country: "88", countryName: "BELGIE", stations: [
      { id: "8800104", name: "Brussel-Zuid / Bruxelles-Midi" },
      { id: "8800210", name: "Antwerpen-Centraal" },
    ] },
    { country: "80", countryName: "DEUTSCHLAND", stations: [
      { id: "8010100", name: "Berlin Hbf" },
      { id: "8011102", name: "Berlin Gesundbrunnen" },
      { id: "8010110", name: "Berlin Ostbahnhof" },
    ] },
    { country: "54", countryName: "CESKO", stations: [{ id: "5457076", name: "Praha hl.n." }] },
    { country: "87", countryName: "FRANCE", stations: [{ id: "8700015", name: "Paris Nord" }] },
  ],
  routes: [],
};

function priceClass(key, levels, extra = {}) {
  return {
    placeTypeKey: key,
    placeTypeIcon: 0,
    freeSeatsCount: 10,
    bookable: true,
    prices: { eur: Math.min(...levels.map((l) => l.eur)) },
    fareTypes: levels.map((l) => ({
      id: l.id,
      bookable: l.bookable ?? true,
      availableSeats: l.seats ?? 5,
      prices: { eur: l.eur },
    })),
    ...extra,
  };
}

const AVAILABILITY = {
  availabilityResult: {
    availability: {
      priceClasses: [
        priceClass("seat-second-class", [{ id: "easy-night", eur: 29.99 }]),
        priceClass("couchette-6", [
          { id: "easy-night", eur: 59.99, seats: 0 }, // sold out: must not price
          { id: "good-night", eur: 79.99 },
          { id: "flex-night", eur: 99.99 },
        ]),
        priceClass("couchette-5", [{ id: "good-night", eur: 89.99 }]),
        priceClass("couchette-5-women-only", [{ id: "easy-night", eur: 49.99 }]),
        priceClass("couchette-5-private", [{ id: "easy-night", eur: 219.99 }]),
        priceClass("berth-triple", [{ id: "easy-night", eur: 139.99 }]),
        priceClass("comfort-single", [{ id: "good-night", eur: 349.99 }], { bookable: false }),
        priceClass("berth-double", [{ id: "flex-night", eur: 189.99 }], { freeSeatsCount: 0 }),
      ],
    },
  },
};

// ─── unit: the API reader ────────────────────────────────────────────────

await check("classifyPlaceType: berths only, women-only and seats left out", () => {
  assert.strictEqual(classifyPlaceType("seat-second-class"), null);
  assert.strictEqual(classifyPlaceType("couchette-4"), "couchette");
  assert.strictEqual(classifyPlaceType("couchette-6"), "couchette");
  assert.strictEqual(classifyPlaceType("couchette-5-women-only"), null);
  assert.strictEqual(classifyPlaceType("couchette-6-private"), "privateCouchette");
  assert.strictEqual(classifyPlaceType("berth-triple"), "sleeperTriple");
  assert.strictEqual(classifyPlaceType("berth-triple-women-only"), null);
  assert.strictEqual(classifyPlaceType("comfort-double"), "comfortDouble");
  assert.strictEqual(classifyPlaceType("something-new"), null);
  // Every class the reader can emit has a traveller-facing label.
  for (const k of ["couchette", "privateCouchette", "sleeperSingle", "sleeperDouble", "sleeperTriple",
    "comfortSingle", "comfortDouble", "comfortTriple", "lastMinuteCouchette", "lastMinutePrivate"]) {
    assert.ok(FARE_CLASS_LABELS[k], `label for ${k}`);
  }
});

await check("cheapestFare: a sold-out or unbookable level never prices the class", () => {
  const pc = AVAILABILITY.availabilityResult.availability.priceClasses[1];
  assert.deepStrictEqual(cheapestFare(pc), { amount: 79.99, fareType: "good-night" });
  assert.strictEqual(cheapestFare({ bookable: false, prices: { eur: 10 } }), null);
  assert.strictEqual(cheapestFare({ freeSeatsCount: 0, prices: { eur: 10 } }), null);
  assert.deepStrictEqual(cheapestFare({ prices: { eur: 42 } }), { amount: 42, fareType: null });
});

await check("classesFromAvailability: cheapest bookable fare per class, berths only", () => {
  const { classes, fareTypes } = classesFromAvailability(AVAILABILITY);
  assert.deepStrictEqual(classes, { couchette: 79.99, privateCouchette: 219.99, sleeperTriple: 139.99 });
  assert.deepStrictEqual(fareTypes, { couchette: "good-night", privateCouchette: "easy-night", sleeperTriple: "easy-night" });
});

await check("nightsFromTrainSearch: three nights per answer, ours or nothing", () => {
  const body = {
    routeSearchResults: [{
      searchResultOutward: [
        { routeId: "r-453", departureDateTime: "2026-10-02T19:22:00", trip: { trainNumber: "453", travelDate: "2026-10-02", bookable: true } },
        { routeId: null, departureDateTime: "2026-10-03T00:00:00", trip: null },
        { routeId: "r-other", departureDateTime: "2026-10-04T19:22:00", trip: { trainNumber: "401", travelDate: "2026-10-04" } },
      ],
    }],
  };
  const nights = nightsFromTrainSearch(body, "453");
  assert.strictEqual(nights["2026-10-02"].routeId, "r-453");
  assert.strictEqual(nights["2026-10-03"], null);
  assert.strictEqual(nights["2026-10-04"], null);
  assert.deepStrictEqual(Object.keys(nightsFromTrainSearch({}, "453")), []);
});

await check("request bodies: adult only, train number bare, date as the API wants it", () => {
  assert.deepStrictEqual(trainSearchBody({ fromId: 8800104, toId: "5457076", date: "2026-10-02" }).passengerTypes, [72]);
  const b = availabilityBody({ routeId: "r", fromId: "1", toId: "2", trainNumber: "ES 453", date: "2026-10-02" });
  assert.strictEqual(b.trainNumber, "453");
  assert.strictEqual(b.travelDate, "2026-10-02T00:00:00");
});

await check("resolveStationId: curated map first, then the operator's own names, never a guess", () => {
  const stations = constantsStations(CONSTANTS);
  const curated = JSON.parse(fs.readFileSync("data/overrides/operator-booking.json", "utf8")).ES.stationNames;
  assert.strictEqual(resolveStationId("Bruxelles Midi", { curated, stations }), "8800104");
  assert.strictEqual(resolveStationId("Berlin Gesundbrunnen", { curated: {}, stations }), "8011102");
  assert.strictEqual(resolveStationId("Paris Gare du Nord", { curated: {}, stations }), "8700015");
  assert.strictEqual(resolveStationId("Bruxelles-Midi", { curated: {}, stations }), "8800104");
  // A curated id the operator's list does not know is not trusted.
  assert.strictEqual(resolveStationId("Praha hl.n.", { curated: { "Praha hl.n.": "999" }, stations }), "5457076");
  // "Berlin" alone would match three stations: ambiguous means null.
  assert.strictEqual(resolveStationId("Berlin", { curated: {}, stations }), null);
  assert.strictEqual(resolveStationId("Wien Hbf", { curated: {}, stations }), null);
  assert.strictEqual(foldName("Děčín hl.n."), "decin hl n");
});

// ─── unit: the last-minute pages ─────────────────────────────────────────

await check("findDates: the site's four languages, day-first, year inferred forward", () => {
  const iso = (t) => findDates(t, { today: TODAY }).map((d) => d.iso);
  assert.deepStrictEqual(iso("Friday 10 October 2026"), ["2026-10-10"]);
  assert.deepStrictEqual(iso("vrijdag 10 oktober"), ["2026-10-10"]);
  assert.deepStrictEqual(iso("Fr., 10. Oktober"), ["2026-10-10"]);
  assert.deepStrictEqual(iso("mar. 14 oct."), ["2026-10-14"]); // "mar." is Tuesday, not March
  assert.deepStrictEqual(iso("1er novembre"), ["2026-11-01"]);
  assert.deepStrictEqual(iso("October 12th, 2026"), ["2026-10-12"]);
  assert.deepStrictEqual(iso("12-10-2026 and 2026-10-13 and 14/10/26"), ["2026-10-12", "2026-10-13", "2026-10-14"]);
  assert.deepStrictEqual(findDates("3 Jan", { today: "2026-12-20" }).map((d) => d.iso), ["2027-01-03"]);
  assert.deepStrictEqual(iso("31-02-2026"), []);
});

await check("parseEuroAmount: the receipt endpoint's '&euro;40' and page labels", () => {
  assert.strictEqual(parseEuroAmount("&euro;40"), 40);
  assert.strictEqual(parseEuroAmount("€ 60,00"), 60);
  assert.strictEqual(parseEuroAmount("160 EUR"), 160);
  assert.strictEqual(parseEuroAmount(""), null);
  assert.strictEqual(dealKind({ amount: 160 }), "private");
  assert.strictEqual(dealKind({ amount: 40 }), "couchette");
  assert.strictEqual(dealKind({ amount: 40, kind: "private" }), "private");
});

// Three shapes a deal form could take. Synthetic — see the header.
const PAGE_SELECT = `
<html><body><h1>Last minutes Berlin – Prague</h1>
<form action="/receipt/run" method="post">
  <input type="hidden" name="landingpage" value="102">
  <select name="departure-station"><option value="8800104">Brussels</option></select>
  <select name="price" id="price">
    <option value="">Choose your date</option>
    <option value="981">Fri 10 October – €40 per person</option>
    <option value="982">Sat 11 October – €60 per person</option>
    <option value="990">Sat 11 October – private compartment €160</option>
  </select>
</form>
<footer>© 2026 European Sleeper · updated 01-01-2026</footer>
</body></html>`;

const PAGE_RADIOS = `
<div class="deals">
  <h3>Wednesday 15 October</h3>
  <label><input type="radio" name="price" value="905"> Shared couchette <strong>&euro;40</strong></label>
  <label><input type="radio" name="price" value="906"> Private compartment <strong>&euro;160</strong></label>
  <h3>Thursday 16 October</h3>
  <label><input type="radio" name="price" value="907"> Shared couchette <strong>&euro;60</strong></label>
</div>
<input type="radio" name="price" value="999"> Sold out`;

const PAGE_DATA = `
<ul>
  <li data-price-id="931" data-date="2026-10-20"><span>ES 475</span> €40</li>
  <li><a href="/receipt/price/1/932">check</a></li>
</ul>
<script>window.deals = [{"priceId": 933, "date": "2026-10-22"}]</script>`;

await check("parseLastMinutePage: a <select name=price> with dated options", () => {
  const { deals, undated } = parseLastMinutePage(PAGE_SELECT, { today: TODAY });
  assert.deepStrictEqual(deals.map((d) => [d.id, d.date, d.amount, d.kind]), [
    ["981", "2026-10-10", 40, "couchette"],
    ["982", "2026-10-11", 60, "couchette"],
    ["990", "2026-10-11", 160, "private"],
  ]);
  assert.deepStrictEqual(undated, []);
});

await check("parseLastMinutePage: radio buttons under date headings take the heading's date", () => {
  const { deals, undated } = parseLastMinutePage(PAGE_RADIOS, { today: TODAY });
  assert.deepStrictEqual(deals.map((d) => [d.id, d.date, d.amount, d.kind]), [
    ["905", "2026-10-15", 40, "couchette"],
    ["906", "2026-10-15", 160, "private"],
    ["907", "2026-10-16", 60, "couchette"],
    ["999", "2026-10-16", null, null],
  ]);
  assert.deepStrictEqual(undated, []);
});

await check("parseLastMinutePage: data attributes, receipt links and script JSON; no date, no deal", () => {
  const { deals, undated } = parseLastMinutePage(PAGE_DATA, { today: TODAY, trainNumbers: ["475"] });
  const byId = Object.fromEntries(deals.map((d) => [d.id, d]));
  assert.strictEqual(byId["931"].date, "2026-10-20");
  assert.strictEqual(byId["931"].trainNumber, "475");
  assert.strictEqual(byId["931"].amount, 40);
  assert.strictEqual(byId["933"].date, "2026-10-22");
  // The receipt link names no date anywhere near it: reported, never guessed.
  assert.ok(undated.includes("932"), `undated ${undated}`);
  // A page with no deal markup at all yields nothing.
  assert.deepStrictEqual(parseLastMinutePage("<p>No deals right now. 12 October 2026</p>", { today: TODAY }).deals, []);
  assert.strictEqual(findDealIds("<select name='departure-station'><option value='8800104'>B</option></select>").length, 0);
});

await check("findLandingPaths: the index page's links to per-direction landing pages", () => {
  const html = `<a href="/last-minutes-berlin-prague">x</a><a href="https://www.europeansleeper.eu/last-minutes-milan-brussels/">y</a><a href="/last-minute">z</a>`;
  assert.deepStrictEqual(findLandingPaths(html), ["/last-minutes-berlin-prague", "/last-minutes-milan-brussels"]);
});

function fakeSite(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        const r = await handler(url, init);
        if (r instanceof Error) throw r;
        const { status = 200, body = "" } = r;
        return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };
  impl.calls = calls;
  return impl;
}

await check("fetchLastMinuteDeals: receipt price wins, an empty receipt is an expired deal", async () => {
  const fetchImpl = fakeSite([
    [/\/last-minute$/, () => ({ body: `<a href="/last-minutes-berlin-prague">a</a><a href="/last-minutes-new-route">b</a>` })],
    [/last-minutes-berlin-prague$/, () => ({ body: PAGE_SELECT })],
    [/last-minutes-new-route$/, () => ({ body: PAGE_RADIOS })],
    [/receipt\/price\/1\/981$/, () => ({ body: "&euro;45" })],
    [/receipt\/price\/1\/982$/, () => ({ body: "" })],
    [/receipt\/price\/1\/990$/, () => new Error("socket hang up")],
  ]);
  const result = await fetchLastMinuteDeals({
    pages: [{ path: "/last-minutes-berlin-prague", trains: ["453"] }],
    trainKeys: ["452", "453", "474", "475"],
    today: TODAY,
    fetchImpl,
    log: () => {},
    spacingMs: 0,
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.deals.map((d) => [d.train, d.date, d.kind, d.amount, d.landing]), [
    ["453", "2026-10-10", "couchette", 45, "/last-minutes-berlin-prague"], // receipt's figure
    ["453", "2026-10-11", "private", 160, "/last-minutes-berlin-prague"], // receipt failed: page's figure
  ]);
  // The unknown page names no train we carry, so none of its deals are used.
  assert.strictEqual(result.pages.find((p) => p.path === "/last-minutes-new-route").used, 0);
  const down = await fetchLastMinuteDeals({ pages: [{ path: "/x", trains: ["453"] }], trainKeys: ["453"], today: TODAY,
    fetchImpl: async () => { throw new Error("offline"); }, log: () => {}, spacingMs: 0 });
  assert.strictEqual(down.ok, false);
});

// ─── the nightly pass ────────────────────────────────────────────────────

const TRAINS = () => ({
  "453": { lineName: "ES 453", stations: [{ name: "Bruxelles Midi" }, { name: "Berlin Hbf" }, { name: "Praha hl.n." }] },
  "474": { lineName: "ES 474", stations: [{ name: "Berlin Gesundbrunnen" }, { name: "Paris Gare du Nord" }] },
  "999": { lineName: "ES 999", stations: [{ name: "Nowhere" }, { name: "Praha hl.n." }] },
});

function apiFake({ runs = () => true, failTrains = new Set(), deals = null } = {}) {
  return fakeSite([
    [/\/constants$/, () => ({ body: CONSTANTS })],
    [/\/search\/trains$/, (url, init) => {
      const b = JSON.parse(init.body);
      const train = b.fromLocationId === "8800104" ? "453" : "474";
      if (failTrains.has(train)) return { status: 503, body: "down" };
      const out = [];
      for (let i = 0; i < 3; i++) {
        const date = new Date(Date.parse(`${b.departureDate}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
        out.push(runs(train, date)
          ? { routeId: `r-${train}`, departureDateTime: `${date}T19:22:00`, trip: { trainNumber: train, travelDate: date, bookable: true } }
          : { routeId: null, departureDateTime: `${date}T00:00:00`, trip: null });
      }
      return { body: { routeSearchResults: [{ searchResultOutward: out }] } };
    }],
    [/\/search\/availability/, (url, init) => {
      const b = JSON.parse(init.body);
      assert.strictEqual(b.trainRouteId, `r-${b.trainNumber}`);
      return { body: AVAILABILITY };
    }],
    [/\/last-minute$/, () => (deals ? { body: "" } : new Error("offline"))],
    [/last-minutes-berlin-prague$/, () => (deals ? { body: deals } : new Error("offline"))],
    [/receipt\/price/, () => ({ body: "" === null ? "" : "&euro;40" })],
  ]);
}

await check("fillEsFareCalendars: every night in one run, three nights per train search", async () => {
  const trains = TRAINS();
  const days = 9;
  // 453 runs every night but Mondays; 474 every night.
  const runs = (train, date) => train !== "453" || new Date(`${date}T00:00:00Z`).getUTCDay() !== 1;
  const fetchImpl = apiFake({ runs });
  const logs = [];
  const stats = await fillEsFareCalendars(trains, null, {
    today: TODAY, fetchImpl, log: (m) => logs.push(m), days, spacingMs: 0,
    curated: { "Bruxelles Midi": "8800104", "Praha hl.n.": "5457076" },
  });
  assert.deepStrictEqual(stats.unpriced, ["999"], logs.join("\n"));
  assert.strictEqual(stats.searched, 2 * days);
  const searches = fetchImpl.calls.filter((c) => /search\/trains/.test(c.url)).length;
  assert.strictEqual(searches, 2 * Math.ceil(days / 3), "one train search covers three nights");
  const cal = trains["453"].fareCalendar;
  assert.strictEqual(cal.version, FARE_CALENDAR_VERSION);
  assert.strictEqual(cal.currency, "EUR");
  assert.strictEqual(Object.keys(cal.nights).length, days);
  assert.deepStrictEqual(cal.nights["2026-10-05"], { none: true, checkedAt: TODAY }); // a Monday
  assert.deepStrictEqual(cal.nights["2026-10-02"].classes, { couchette: 79.99, privateCouchette: 219.99, sleeperTriple: 139.99 });
  assert.strictEqual(trains["453"].fare.fromPrice, 79.99);
  assert.strictEqual(trains["453"].fare.seatClass, "couchette");
  assert.strictEqual(trains["453"].fare.travelDate, "2026-10-02");
  assert.strictEqual(trains["999"].fare, undefined);
});

await check("fillEsFareCalendars: a failing train costs its own nights, never the run", async () => {
  const trains = TRAINS();
  const stats = await fillEsFareCalendars(trains, null, {
    today: TODAY, fetchImpl: apiFake({ failTrains: new Set(["474"]) }), log: () => {}, days: 6, spacingMs: 0,
  });
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(trains["474"].fareCalendar, undefined);
  assert.strictEqual(Object.keys(trains["453"].fareCalendar.nights).length, 6);
});

await check("fillEsFareCalendars: a deal becomes the night's cheapest fare and the headline", async () => {
  const trains = TRAINS();
  const page = `<select name="price"><option value="981">Sun 5 October – €40</option><option value="982">Thu 2 October – €40</option></select>`;
  const runs = (train, date) => train !== "453" || date !== "2026-10-05";
  await fillEsFareCalendars(trains, null, {
    today: TODAY, fetchImpl: apiFake({ runs, deals: page }), log: () => {}, days: 6, spacingMs: 0,
    loadDeals: () => fetchLastMinuteDeals({
      pages: [{ path: "/last-minutes-berlin-prague", trains: ["453"] }], trainKeys: ["453", "474"],
      today: TODAY, fetchImpl: apiFake({ deals: page }), log: () => {}, spacingMs: 0,
    }),
  });
  const nights = trains["453"].fareCalendar.nights;
  assert.strictEqual(nights["2026-10-02"].classes.lastMinuteCouchette, 40);
  assert.strictEqual(nights["2026-10-02"].classes.couchette, 79.99);
  assert.deepStrictEqual(nights["2026-10-02"].deal, { landing: "/last-minutes-berlin-prague", checkedAt: TODAY });
  // Regular search said nothing on sale; the promo quota is separate and still counts.
  assert.strictEqual(nights["2026-10-05"].none, undefined);
  assert.strictEqual(nights["2026-10-05"].classes.lastMinuteCouchette, 40);
  assert.strictEqual(trains["453"].fare.fromPrice, 40);
  assert.strictEqual(trains["453"].fare.seatClass, "lastMinuteCouchette");
  assert.strictEqual(trains["453"].fare.travelDate, "2026-10-02");
  assert.strictEqual(trains["474"].fare.fromPrice, 79.99);
});

await check("deals are read fresh every night: yesterday's go unless tonight's pages are unreachable", async () => {
  const previous = {
    "453": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: {
      "2026-10-03": { classes: { couchette: 79.99, lastMinuteCouchette: 40 }, checkedAt: "2026-09-30", deal: { landing: "/last-minutes-berlin-prague", checkedAt: "2026-09-30" } },
      "2026-10-04": { classes: { lastMinuteCouchette: 60 }, checkedAt: "2026-09-30", dealOnly: true, deal: { landing: "/x", checkedAt: "2026-09-30" } },
      "2026-10-06": { classes: { lastMinuteCouchette: 40 }, checkedAt: "2026-09-30", deal: { landing: "/x", checkedAt: "2026-09-30" } },
    } } },
  };
  // stripDeals: regular fares stay, a deal-only night goes, a deal over `none` reverts to `none`.
  const cal = structuredClone(previous["453"].fareCalendar);
  const removed = stripDeals(cal, "453");
  assert.strictEqual(removed.length, 3);
  assert.deepStrictEqual(cal.nights["2026-10-03"], { classes: { couchette: 79.99 }, checkedAt: "2026-09-30" });
  assert.strictEqual(cal.nights["2026-10-04"], undefined);
  assert.deepStrictEqual(cal.nights["2026-10-06"], { none: true, checkedAt: "2026-09-30" });

  // Tonight's pages readable and listing nothing: every old deal is gone.
  let trains = TRAINS();
  await fillEsFareCalendars(trains, structuredClone(previous), {
    today: TODAY, fetchImpl: apiFake({ deals: "<p>nothing</p>" }), log: () => {}, days: 6, spacingMs: 0,
    loadDeals: async () => ({ ok: true, deals: [] }),
  });
  assert.ok(Object.values(trains["453"].fareCalendar.nights).every((e) => !e.deal));

  // Pages unreachable tonight: yesterday's deals stay, one day at most.
  trains = TRAINS();
  await fillEsFareCalendars(trains, structuredClone(previous), {
    today: TODAY, fetchImpl: apiFake(), log: () => {}, days: 6, spacingMs: 0,
    loadDeals: async () => ({ ok: false, deals: [] }),
  });
  assert.strictEqual(trains["453"].fareCalendar.nights["2026-10-03"].classes.lastMinuteCouchette, 40);
  assert.strictEqual(trains["453"].fareCalendar.nights["2026-10-03"].deal.checkedAt, "2026-09-30");
  trains = TRAINS();
  await fillEsFareCalendars(trains, structuredClone(previous), {
    today: "2026-10-02", fetchImpl: apiFake(), log: () => {}, days: 6, spacingMs: 0,
    loadDeals: async () => ({ ok: false, deals: [] }),
  });
  assert.ok(Object.values(trains["453"].fareCalendar.nights).every((e) => !e.deal), "two-day-old deals are not shown");
});

await check("applyDeals: the cheaper of two deals, nothing past the window or for unknown trains", () => {
  const cals = { "453": { nights: {} } };
  const n = applyDeals(cals, [
    { train: "453", date: "2026-10-03", kind: "couchette", amount: 60, landing: "/a" },
    { train: "453", date: "2026-10-03", kind: "couchette", amount: 40, landing: "/a" },
    { train: "453", date: "2026-10-01", kind: "couchette", amount: 40 }, // tonight: not in the calendar
    { train: "453", date: "2026-12-30", kind: "couchette", amount: 40 },
    { train: "000", date: "2026-10-03", kind: "couchette", amount: 40 },
  ], { today: TODAY });
  assert.strictEqual(n, 2);
  assert.strictEqual(cals["453"].nights["2026-10-03"].classes.lastMinuteCouchette, 40);
});

// ─── what the page makes of it ───────────────────────────────────────────

await check("nightDeal: savings against the same kind of place, and whether it is the cheapest", () => {
  const d = nightDeal({ classes: { couchette: 79.99, sleeperTriple: 139.99, lastMinuteCouchette: 40 }, deal: { landing: "/x", checkedAt: TODAY } });
  assert.strictEqual(d.price, "€40");
  assert.strictEqual(d.regularPrice, "€79.99");
  assert.strictEqual(d.savings, "€39.99");
  assert.strictEqual(d.savingsPct, 50);
  assert.strictEqual(d.best, true);
  const p = nightDeal({ classes: { couchette: 79.99, privateCouchette: 219.99, lastMinutePrivate: 160 } });
  assert.strictEqual(p.kind, "private");
  assert.strictEqual(p.perPerson, "€32");
  assert.strictEqual(p.best, false, "a €160 compartment is not cheaper than a €79.99 bed");
  assert.strictEqual(nightDeal({ classes: { couchette: 79.99 } }), null);
  const soldOut = nightDeal({ classes: { lastMinuteCouchette: 40 } });
  assert.strictEqual(soldOut.savings, null);
  assert.strictEqual(soldOut.best, true);
});

await check("fareCalendarDays: deal nights carry the deal, the summary names the cheapest", () => {
  const calendar = { currency: "EUR", nights: {
    "2026-10-02": { classes: { couchette: 79.99, lastMinuteCouchette: 40 }, checkedAt: TODAY, deal: { landing: "/x", checkedAt: TODAY } },
    "2026-10-03": { classes: { couchette: 89.99 }, checkedAt: TODAY },
    "2026-10-04": { classes: { couchette: 99.99, lastMinuteCouchette: 60 }, checkedAt: TODAY, deal: { landing: "/x", checkedAt: TODAY } },
  } };
  const view = fareCalendarDays(calendar, { today: TODAY });
  assert.strictEqual(view.cheapestDate, "2026-10-02");
  const [a, b] = view.days;
  assert.strictEqual(a.amount, 40);
  assert.strictEqual(a.deal.savingsPct, 50);
  assert.strictEqual(b.deal, null);
  // A deal's chip prints the promo price bare; the regular one keeps "from".
  assert.deepStrictEqual(a.classes.map((c) => [c.key, c.price, Boolean(c.deal)]), [
    ["lastMinuteCouchette", "€40", true],
    ["couchette", "from €79.99", false],
  ]);
  assert.deepStrictEqual(view.deals, { count: 2, from: "€40", fromAmount: 40, fromDate: "2026-10-02", maxSavingsPct: 50 });
  assert.strictEqual(dealsSummary([]), null);
  assert.strictEqual(fareCalendarDays({ currency: "EUR", nights: { "2026-10-03": { classes: { couchette: 89 } } } }, { today: TODAY }).deals, null);
  assert.ok(lastMinuteProgramme("ES").terms.length);
  assert.ok(lastMinuteProgramme("ES/NS"));
  assert.strictEqual(lastMinuteProgramme("FS"), null);
  assert.strictEqual(fareClassLabel("lastMinuteCouchette"), "Last-minute couchette");
});

await check("booking links: a deal opens its landing page, a night opens the dated search", () => {
  assert.strictEqual(
    buildDealsLandingUrl("ES", "/last-minutes-berlin-prague"),
    "https://deals.europeansleeper.eu/c?c=37347&m=12&a=505962&r=deals&u=%2Flast-minutes-berlin-prague",
  );
  assert.strictEqual(buildDealsLandingUrl("ES", "https://evil.example/"), null);
  assert.strictEqual(buildDealsLandingUrl("FS", "/x"), null);
  const link = buildDatedBookingLink({ agencyId: "ES", origin: "Bruxelles Midi", dest: "Praha hl.n." });
  assert.ok(link, "ES has a dated booking link");
  assert.strictEqual(link.dateFor("2026-10-12"), "2026-10-12");
  assert.ok(link.template.endsWith("%26departureDate%3D{date}"), link.template);
  assert.ok(link.template.includes("departureStation%3D8800104"), link.template);
  // 474 starts in Berlin Gesundbrunnen: mapped, so its nights get dated links too.
  assert.ok(buildDatedBookingLink({ agencyId: "ES", origin: "Berlin Gesundbrunnen", dest: "Paris Gare du Nord" }));
});

await check("stampOfficialFares: an ES row takes its trains' fares and calendars", () => {
  const cal = { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: { "2026-10-02": { classes: { couchette: 79.99, lastMinuteCouchette: 40 }, checkedAt: TODAY } } };
  const viewMap = { 237: { route_id: 237, agency_id: "ES", timetable_source: "europeansleeper", trip_short_name_0: "452", trip_short_name_1: "453" } };
  const trains = { "453": { fare: { fromPrice: 40, currency: "EUR", seatClass: "lastMinuteCouchette", classes: cal.nights["2026-10-02"].classes, sampledAt: TODAY, travelDate: "2026-10-02" }, fareCalendar: cal } };
  const registry = [{ id: "europeansleeper", enabled: true, official: true }];
  assert.strictEqual(stampOfficialFares(viewMap, {}, { europeansleeper: trains }, registry), 1);
  const row = viewMap[237];
  assert.strictEqual(row.pricing.fromPrice, 40);
  assert.strictEqual(row.pricing.type, "dynamic");
  assert.strictEqual(row.pricing.trainName, "453");
  assert.strictEqual(row.fare_1.seatClass, "lastMinuteCouchette");
  assert.strictEqual(row.fare_calendar_1, cal);
  assert.strictEqual(row.fare_0, undefined);
});

await check("registry: the fare pass and every landing page name trains the adapter builds", () => {
  const registry = JSON.parse(fs.readFileSync("data/sources/registry.json", "utf8"));
  const es = registry.find((e) => e.id === "europeansleeper");
  const fares = es.params.fares;
  assert.ok(fares?.enabled, "fares enabled");
  const allow = JSON.parse(fs.readFileSync(es.params.configPath, "utf8"));
  const list = (Array.isArray(allow) ? allow : allow.routes).map((r) => String(r.route_short_name ?? r).replace(/\D/g, ""));
  for (const page of fares.lastMinute.pages) {
    assert.match(page.path, /^\/last-minutes-[a-z-]+$/);
    assert.ok(page.trains.some((t) => list.includes(t)), `${page.path} sells a train the adapter builds`);
  }
});

console.log(`verify-es-fares: ${passed} checks passed`);
