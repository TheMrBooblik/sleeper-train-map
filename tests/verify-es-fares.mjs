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
  fetchDeals,
  findLandingPaths,
  findOfferLinks,
  parseEuroAmount,
  parseLastMinutePage,
  saleEndDate,
  trainForOfferPath,
  trainForOfferText,
} from "../scripts/lib/es-last-minute.mjs";
import {
  applyDeals,
  fillEsFareCalendars,
  stripDeals,
} from "../scripts/lib/es-fare-calendar.mjs";
import { FARE_CALENDAR_VERSION } from "../scripts/lib/fare-calendar.mjs";
import { fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { dealsSummary, lastMinuteProgramme, nightDeal } from "../src/lib/lastMinuteDeals.mjs";
import { fareClassLabel, fareClassRows, FARE_CLASS_LABELS, splitDealFare } from "../src/lib/fareClasses.mjs";
import { cheapestNight } from "../scripts/lib/fare-calendar.mjs";
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

// The live page's shape, as the probe runs (2026-10-01) printed it: its form
// fields verbatim (from the probe's form digest) and the visible text in
// order. A button's own text is its price alone ("€40 p.p." — the probe
// prints it), so the date is the label just before it; the wrapping markup
// is reconstructed.
const PAGE_LIVE = `
<h1>Last minute deals to Berlin and Prague</h1>
<form id="form-receipt">
<select class="input" id="departure-station" name="departure-station" required>
  <option value>Choose a station</option><option value="8400058"> Amsterdam Centraal </option>
</select>
<div class="tab">CLASSIC</div><div class="tab">CLASSIC PRIVATE</div>
<p>No hidden costs! Fares include train ticket, reservation of a bed in a 5-person Classic compartment, bed linen, and luggage. Tickets are non-refundable.</p>
<p>1. Select date</p>
<div><span>Friday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-2" type="button">info</button>
  <span>Depart Friday evening, arrive Saturday morning.</span>
  <span>Fri 02 Oct 26</span>
  <button class="bg-shock-orange button duration-150 ease-in hover:bg-darker-shock-orange rounded text-white" name="price" type="button" value="1062">
    <span>&euro;40 p.p.</span>
  </button></div>
<p>No hidden costs! Fares include train tickets, reservation of a private Classic compartment for up to five persons, bed linen, and luggage.</p>
<div><span>Monday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-3" type="button">info</button>
  <span>Leave Monday evening, arrive Tuesday morning.</span>
  <span>Mon 05 Oct 26</span>
  <button class="bg-shock-orange button duration-150 ease-in hover:bg-darker-shock-orange rounded text-white" name="price" type="button" value="1067">
    <span>&euro;160</span>
  </button></div>
<div><span>Friday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-4" type="button">info</button>
  <span>Depart Friday evening, arrive Saturday morning.</span>
  <span>Fri 02 Oct 26</span>
  <button class="bg-shock-orange button duration-150 ease-in hover:bg-darker-shock-orange rounded text-white" name="price" type="button" value="1066">
    <span>&euro;160</span>
  </button></div>
<input name="landingpage" type="hidden" value="41">
<input name="price" type="hidden" value="">
<select class="required text-xl" id="receipt-group" name="group" required><option selected value="1">1</option></select>
</form>
<footer>&copy; 2026 — European Sleeper Exploitatie B.V.</footer>`;

await check("parseLastMinutePage: the live page — one <button name=price> per deal, '02 Oct 26' dates", () => {
  const { deals, undated, ids } = parseLastMinutePage(PAGE_LIVE, { today: TODAY });
  assert.strictEqual(ids, 3, "the empty hidden price input is not a deal");
  assert.deepStrictEqual(
    deals.map((d) => [d.id, d.date, d.amount, dealKind(d)]),
    [
      ["1062", "2026-10-02", 40, "couchette"],
      ["1067", "2026-10-05", 160, "private"],
      ["1066", "2026-10-02", 160, "private"],
    ],
  );
  assert.deepStrictEqual(undated, []);
  // "26" after the month is the year, never the 26th.
  assert.deepStrictEqual(findDates("Fri 02 Oct 26", { today: TODAY }).map((d) => d.iso), ["2026-10-02"]);
  assert.deepStrictEqual(findDates("5 October 18:00", { today: TODAY }).map((d) => d.iso), ["2026-10-05"]);
});

await check("findLandingPaths: the index page's links to per-direction landing pages", () => {
  // The live index links both spellings: /last-minutes-… and /last-minute-….
  const html = `<a href="/last-minutes-berlin-prague">x</a><a href="https://www.europeansleeper.eu/last-minute-switzerland-milan/">y</a><a href="/last-minute">z</a>`;
  assert.deepStrictEqual(findLandingPaths(html), ["/last-minute-switzerland-milan", "/last-minutes-berlin-prague"]);
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

function apiFake({ runs = () => true, failTrains = new Set(), failStatus = 503, deals = null } = {}) {
  return fakeSite([
    [/\/constants$/, () => ({ body: CONSTANTS })],
    [/\/search\/trains$/, (url, init) => {
      const b = JSON.parse(init.body);
      const train = b.fromLocationId === "8800104" ? "453" : "474";
      if (failTrains.has(train)) return { status: failStatus, body: "refused" };
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

await check("endpointsFor: an end the operator does not sell becomes its same-city terminus, never a stop further in", async () => {
  const { endpointsFor } = await import("../scripts/lib/es-fare-calendar.mjs");
  // As /constants answered on 2026-10-01: Berlin Hbf and Ostbahnhof, no
  // Gesundbrunnen, and the Paris route listed Paris-Nord … Berlin Hbf.
  const stations = constantsStations(CONSTANTS).filter((st) => st.id !== "8011102");
  const routes = [["8700015", "8800104", "8020401", "8010110", "8010100"], ["8800104", "8010100", "8010110", "5457076"]];
  // Our timetable's own stop list for 475: no Berlin Hbf anywhere in it.
  const stops = ["Paris Gare du Nord", "Bruxelles Midi", "Hamburg Harburg", "Berlin Gesundbrunnen"];
  const logs = [];
  const out = endpointsFor(
    {
      "475": { stations: stops.map((name) => ({ name })) },
      "474": { stations: [...stops].reverse().map((name) => ({ name })) },
      "999": { stations: [{ name: "Nowhere" }, { name: "Elsewhere" }] },
    },
    { curated: { "Berlin Gesundbrunnen": "8011102" }, stations, routes, log: (m) => logs.push(m) },
  );
  assert.deepStrictEqual(out["475"], { fromId: "8700015", toId: "8010100", from: "Paris Gare du Nord", to: "Berlin Hbf" });
  assert.deepStrictEqual(out["474"], { fromId: "8010100", toId: "8700015", from: "Berlin Hbf", to: "Paris Gare du Nord" });
  assert.strictEqual(out["999"], undefined);
  assert.ok(logs.some((l) => /475: priced Paris Gare du Nord → Berlin Hbf/.test(l)), logs.join("\n"));
  // Two same-city termini and nothing to choose between them: not priced,
  // rather than a guess (and never Hamburg-Harburg, the next stop inward).
  const ambiguous = endpointsFor(
    { "475": { stations: stops.map((name) => ({ name })) } },
    { curated: {}, stations, routes: [["8700015", "8010100"], ["8700015", "8010110"]], log: () => {} },
  );
  assert.strictEqual(ambiguous["475"], undefined);
});

await check("fillEsFareCalendars: a train the API refuses costs its own nights, never the run", async () => {
  const trains = TRAINS();
  const stats = await fillEsFareCalendars(trains, null, {
    today: TODAY, fetchImpl: apiFake({ failTrains: new Set(["474"]), failStatus: 400 }), log: () => {}, days: 6, spacingMs: 0,
  });
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(trains["474"].fareCalendar, undefined);
  assert.strictEqual(Object.keys(trains["453"].fareCalendar.nights).length, 6);
});

await check("fillEsFareCalendars: a 504 is retried once and then costs one night, not the train's calendar", async () => {
  // The first live refresh: three lone 504s from /search/availability cut
  // ES 453 to 17 of 42 nights, because any error skipped the train's rest.
  const failures = new Map([["2026-10-03", 2], ["2026-10-04", 1]]); // 10-03 fails twice, 10-04 once
  const base = apiFake();
  const fetchImpl = async (url, init) => {
    if (/search\/availability/.test(url)) {
      const b = JSON.parse(init.body);
      const date = b.travelDate.slice(0, 10);
      const left = failures.get(date) ?? 0;
      if (b.trainNumber === "453" && left > 0) {
        failures.set(date, left - 1);
        return { ok: false, status: 504, text: async () => '{"title":"Gateway Timeout"}' };
      }
    }
    return base(url, init);
  };
  const previous = { "453": { fareCalendar: { version: FARE_CALENDAR_VERSION, currency: "EUR", nights: {
    "2026-10-03": { classes: { couchette: 70 }, checkedAt: "2026-09-30" },
  } } } };
  const trains = TRAINS();
  const logs = [];
  const stats = await fillEsFareCalendars(trains, previous, {
    today: TODAY, fetchImpl, log: (m) => logs.push(m), days: 6, spacingMs: 0, retryDelayMs: 1,
  });
  const nights = trains["453"].fareCalendar.nights;
  assert.strictEqual(Object.keys(nights).length, 6, logs.join("\n"));
  assert.strictEqual(nights["2026-10-04"].classes.couchette, 79.99, "a single 504 is retried and priced");
  assert.deepStrictEqual(nights["2026-10-03"], { classes: { couchette: 70 }, checkedAt: "2026-09-30" }, "a night that fails twice keeps last run's entry");
  assert.strictEqual(nights["2026-10-05"].classes.couchette, 79.99, "the nights after it are still searched");
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.retries, 2);
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
  assert.deepStrictEqual(nights["2026-10-02"].deal, { landing: "/last-minutes-berlin-prague", checkedAt: TODAY, programme: "lastMinute" });
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
  assert.deepStrictEqual(view.deals, { count: 2, from: "€40", fromAmount: 40, fromDate: "2026-10-02", maxSavingsPct: 50, programmes: ["lastMinute"] });
  assert.strictEqual(dealsSummary([]), null);
  assert.strictEqual(fareCalendarDays({ currency: "EUR", nights: { "2026-10-03": { classes: { couchette: 89 } } } }, { today: TODAY }).deals, null);
  assert.ok(lastMinuteProgramme("ES").lastMinute.terms.length);
  assert.ok(lastMinuteProgramme("ES").flashSale.terms.length);
  assert.ok(lastMinuteProgramme("ES/NS"));
  assert.strictEqual(lastMinuteProgramme("FS"), null);
  assert.strictEqual(fareClassLabel("lastMinuteCouchette"), "Last-minute couchette");
});

// The flash-sale index as the probe read it on 2026-10-01: a sale banner
// ("ends 6 October", "Book by 6 October"), links to its own translations, and
// six per-direction offer pages whose link text names only where they go —
// "to Brussels and Paris" — while the address names the route
// (/flash-berlin-paris). The hrefs and texts are the probe's; the markup
// around them is reconstructed.
const FLASH_INDEX = `
<div class="announcement">Good Morning Flash Sale - ends 6 October <a href="/flash-sale">Book for &euro;49</a></div>
<nav><a href="/de/flash-sale"><img alt="" src="/de.svg"></a><a href="/fr/flash-sale"></a><a href="/it/flash-sale"></a><a href="/nl/flash-sale"></a></nav>
<h1>Good Morning Flash Sale</h1>
<p>Shared Classic for &euro;49 one-way. Limited availability on selected November and December departures. Once it’s gone, it’s gone. Book by 6 October.</p>
<h2>Brussels-Milan Route</h2>
<a href="/flash-brussels-milan">to Switzerland and Milan</a>
<a href="/flash-milan-brussels">to Cologne and Brussels</a>
<h2>Berlin-Paris Route</h2>
<a href="/flash-paris-berlin">to Hamburg and Berlin</a>
<a href="/flash-berlin-paris">to Brussels and Paris</a>
<h2>Brussels-Prague Route</h2>
<a href="/flash-prague-brussels">to Amsterdam and Brussels</a>
<a href="/flash-brussels-prague">to Berlin and Prague</a>
<a href="/timetable">Timetable</a> <a href="/last-minute">Last minute deals</a>`;

// An offer page as the probe read /flash-brussels-prague: Mondays listed
// from November into December, each date a label before its button, a
// CLASSIC PRIVATE tab at €199 a compartment, and season notices below. Ids,
// dates and prices are the probe's; the markup is reconstructed.
const FLASH_PAGE = `
<h1>Good Morning Flash Sale to Berlin and Prague</h1>
<div class="tab">CLASSIC</div><div class="tab">CLASSIC PRIVATE</div>
<p>Offer ends 6 October. Book fast – gone is gone.</p>
<p>No hidden costs! Fares include train ticket, reservation of a bed in a 5-person compartment, bed linen, and luggage.</p>
<p>1. Select date</p>
<div><span>Monday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-2" type="button">info</button>
  <span>Leave Monday evening, arrive Tuesday morning.</span>
  <span>Mon 30 Nov 26</span><button class="bg-shock-orange button" name="price" type="button" value="1194"><span>&euro;49 p.p.</span></button>
  <span>Mon 07 Dec 26</span><button class="bg-shock-orange button" name="price" type="button" value="1197"><span>&euro;49 p.p.</span></button>
  <span>Mon 14 Dec 26</span><button class="bg-shock-orange button" name="price" type="button" value="1200"><span>&euro;49 p.p.</span></button>
</div>
<div><span>Friday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-4" type="button">info</button>
  <span>Fri 13 Nov 26</span><button class="bg-shock-orange button" name="price" type="button" value="1187"><span>&euro;49 p.p.</span></button>
</div>
<p>Offer ends 6 October. Book fast – gone is gone.</p>
<p>No hidden costs! Fares include train ticket, reservation of a private compartment for up to five persons, bed linen, and luggage.</p>
<div><span>Monday Evening Departures</span>
  <button class="text-xm tooltip" id="tt-5" type="button">info</button>
  <span>Mon 07 Dec 26</span><button class="bg-shock-orange button" name="price" type="button" value="1219"><span>&euro;199</span></button>
</div>
<input name="landingpage" type="hidden" value="80"><input name="price" type="hidden" value="">
<p>Sorry, this journey cannot be booked. Note that Breda/Eindhoven trains start 13 December, and Li&egrave;ge/Verviers/Aachen&ndash;Milan is only bookable until 13 December.</p>`;

const TRAIN_CITIES = {
  "400": ["Milan", "Brussels"], "401": ["Brussels", "Milan"],
  "452": ["Prague", "Brussels"], "453": ["Brussels", "Prague"],
  "474": ["Berlin", "Paris"], "475": ["Paris", "Berlin"],
};

await check("flash sale: the index's offer pages, each tied to its train by the route its address names", () => {
  const links = findOfferLinks(FLASH_INDEX, { pathPattern: /flash/i, indexPath: "/flash-sale" });
  assert.deepStrictEqual(links.map((l) => l.path), [
    "/flash-berlin-paris", "/flash-brussels-milan", "/flash-brussels-prague",
    "/flash-milan-brussels", "/flash-paris-berlin", "/flash-prague-brussels",
  ], "the index, its translations, the timetable and the last-minute link are not offers");
  const trainOf = Object.fromEntries(
    links.map((l) => [l.path, trainForOfferText(l.text, TRAIN_CITIES) ?? trainForOfferPath(l.path, TRAIN_CITIES, { text: l.text })]),
  );
  assert.deepStrictEqual(trainOf, {
    "/flash-berlin-paris": "474", "/flash-brussels-milan": "401", "/flash-brussels-prague": "453",
    "/flash-milan-brussels": "400", "/flash-paris-berlin": "475", "/flash-prague-brussels": "452",
  });
  // The text alone names no train — "to Brussels and Paris" has no origin.
  assert.strictEqual(trainForOfferText("to Brussels and Paris", TRAIN_CITIES), null);
  // The offer pages' own "more routes" links do carry the whole route.
  assert.strictEqual(trainForOfferText("Flash Sale offer from Brussels and Cologne to Switzerland and Milan", TRAIN_CITIES), "401");
  // A route no train runs, or one two trains share, names nothing.
  assert.strictEqual(trainForOfferText("offer from Vienna to Rome", TRAIN_CITIES), null);
  assert.strictEqual(trainForOfferText("offer from Brussels to Prague and Milan", TRAIN_CITIES), null);
  // An address is read as an exact endpoint pair. The last-minute pages slug
  // a stretch of the route — /last-minutes-hamburg-berlin sells Paris → Berlin
  // — and must read as no train, not a wrong one (the registry names theirs).
  for (const p of ["/last-minutes-hamburg-berlin", "/last-minutes-brussels-paris", "/last-minutes-amsterdam-brussels", "/last-minute-switzerland-milan"]) {
    assert.strictEqual(trainForOfferPath(p, TRAIN_CITIES), null, p);
  }
  // Where the link says where the offer goes, the train has to end there.
  assert.strictEqual(trainForOfferPath("/flash-berlin-paris", TRAIN_CITIES, { text: "to Hamburg and Berlin" }), null);
  assert.strictEqual(trainForOfferPath("/flash-sale-berlin-paris", TRAIN_CITIES), "474", "the longer prefix reads the same");
  // Of two anchors to one page, the one naming a route wins.
  const twice = findOfferLinks(
    `<a href="/flash-x-y">to Y</a><a href="/flash-x-y">Flash Sale offer from X to Y</a>`,
    { pathPattern: /flash/i },
  );
  assert.deepStrictEqual(twice, [{ path: "/flash-x-y", text: "Flash Sale offer from X to Y" }]);
  assert.strictEqual(saleEndDate(FLASH_INDEX, { today: TODAY }), "2026-10-06");
  assert.strictEqual(saleEndDate(FLASH_INDEX, { today: "2026-10-07" }), null, "a sale that has ended has no end date ahead");
});

await check("parseLastMinutePage: a date past the horizon drops its deal, never moves it onto an earlier date", () => {
  // The first flash-sale scrape read this page with a 60-day horizon: the two
  // December Mondays fell outside it, and the nearest date left in range was
  // Monday 30 November — so all three deals were dated the 30th.
  const wide = parseLastMinutePage(FLASH_PAGE, { today: TODAY, horizonDays: 92 });
  assert.deepStrictEqual(
    wide.deals.map((d) => [d.id, d.date, d.amount, dealKind(d)]),
    [
      ["1194", "2026-11-30", 49, "couchette"],
      ["1197", "2026-12-07", 49, "couchette"],
      ["1200", "2026-12-14", 49, "couchette"],
      ["1187", "2026-11-13", 49, "couchette"],
      ["1219", "2026-12-07", 199, "private"],
    ],
  );
  assert.deepStrictEqual([wide.undated, wide.outside], [[], []]);
  const narrow = parseLastMinutePage(FLASH_PAGE, { today: TODAY, horizonDays: 60 });
  assert.deepStrictEqual(narrow.deals.map((d) => [d.id, d.date]), [["1194", "2026-11-30"], ["1187", "2026-11-13"]]);
  assert.deepStrictEqual(narrow.outside, ["1197", "1200", "1219"]);
  assert.deepStrictEqual(narrow.undated, []);
  // A date in the deal's own text that is out of range drops it too.
  const own = parseLastMinutePage(`<h3>Fri 02 Oct 26</h3><button name="price" value="77">Sun 06 Dec 26 &euro;49 p.p.</button>`, {
    today: TODAY, horizonDays: 30,
  });
  assert.deepStrictEqual([own.deals, own.outside], [[], ["77"]]);
});

await check("fetchDeals: flash-sale deals carry their programme, train and last booking day", async () => {
  const fetchImpl = fakeSite([
    [/\/flash-sale$/, () => ({ body: FLASH_INDEX })],
    [/\/flash-brussels-prague$/, () => ({ body: FLASH_PAGE })],
    [/\/flash-/, () => ({ body: "<p>No dates left.</p>" })],
    [/\/last-minute$/, () => ({ body: "" })],
    [/receipt\/price\/1\/1200$/, () => ({ body: "" })], // sold out since the page was built
    [/receipt\/price\/1\/1219$/, () => ({ body: "&euro;199" })],
    [/receipt\/price\/1\/\d+$/, () => ({ body: "&euro;49" })],
  ]);
  const result = await fetchDeals({
    programmes: [{ id: "lastMinute", indexPath: "/last-minute", pages: [] }, { id: "flashSale", indexPath: "/flash-sale", pages: [] }],
    trains: Object.fromEntries(Object.keys(TRAIN_CITIES).map((k) => [k, {}])),
    trainCities: TRAIN_CITIES,
    today: TODAY, fetchImpl, log: () => {}, spacingMs: 0,
  });
  assert.strictEqual(result.ok, true);
  const flash = { kind: "couchette", amount: 49, landing: "/flash-brussels-prague", programme: "flashSale", until: "2026-10-06", train: "453" };
  assert.deepStrictEqual(
    result.deals.map(({ train, date, kind, amount, landing, id, programme, until }) => ({ train, date, kind, amount, landing, id, programme, until })),
    [
      { ...flash, date: "2026-11-30", id: "1194" },
      { ...flash, date: "2026-12-07", id: "1197" },
      // 1200 (14 December) sold out: its receipt answers nothing.
      { ...flash, date: "2026-11-13", id: "1187" },
      { ...flash, date: "2026-12-07", id: "1219", kind: "private", amount: 199 },
    ],
  );
  const page = result.pages.find((p) => p.path === "/flash-brussels-prague");
  assert.deepStrictEqual([page.train, page.ids, page.dated, page.outside], ["453", 5, 5, 0]);
  assert.deepStrictEqual(
    result.pages.filter((p) => p.programme === "flashSale").map((p) => p.train).sort(),
    ["400", "401", "452", "453", "474", "475"],
    "every offer page is tied to its train by its address",
  );
  assert.ok(
    !fetchImpl.calls.some((c) => /\/(?:de|fr|it|nl)\/flash-sale/.test(c.url)),
    "a translation of the index is not read as an offer page",
  );
});

await check("applyDeals / stripDeals: a flash sale lands in its own class and goes when the sale ends", () => {
  const cals = { "453": { nights: { "2026-11-13": { classes: { couchette: 89.99 }, checkedAt: TODAY } } } };
  applyDeals(cals, [
    { train: "453", date: "2026-11-13", kind: "couchette", amount: 49, landing: "/flash-sale-brussels-prague", programme: "flashSale", until: "2026-10-06" },
    { train: "453", date: "2026-11-14", kind: "couchette", amount: 49, landing: "/x", programme: "flashSale", until: "2026-09-30" }, // ended
  ], { today: TODAY, days: 92 });
  const night = cals["453"].nights["2026-11-13"];
  assert.deepStrictEqual(night.classes, { couchette: 89.99, flashSaleCouchette: 49 });
  assert.deepStrictEqual(night.deal, { landing: "/flash-sale-brussels-prague", checkedAt: TODAY, programme: "flashSale", until: "2026-10-06" });
  assert.strictEqual(cals["453"].nights["2026-11-14"], undefined, "a sale past its last day adds nothing");
  const removed = stripDeals(cals["453"], "453");
  assert.deepStrictEqual(removed.map((d) => [d.programme, d.kind, d.amount, d.until]), [["flashSale", "couchette", 49, "2026-10-06"]]);
  assert.deepStrictEqual(cals["453"].nights["2026-11-13"].classes, { couchette: 89.99 });
  const d = nightDeal({ classes: { couchette: 89.99, flashSaleCouchette: 49 }, deal: { programme: "flashSale", until: "2026-10-06", landing: "/f" } });
  assert.strictEqual(d.programme, "flashSale");
  assert.strictEqual(d.until, "2026-10-06");
  assert.strictEqual(d.savingsPct, 46);
  assert.strictEqual(fareClassLabel("flashSaleCouchette"), "Flash-sale couchette");
});

await check("the map panel: each class its own cheapest night, the deal apart from the regular fares", () => {
  // As on 2026-10-01: the €40 deal was tomorrow, when the regular couchette
  // cost €159.99 — and the panel printed "Couchette from €159.99" for a train
  // whose couchettes start at €59.99 on other nights.
  const calendar = { currency: "EUR", nights: {
    "2026-10-02": { classes: { couchette: 159.99, privateCouchette: 599.99, lastMinuteCouchette: 40, lastMinutePrivate: 160 }, checkedAt: TODAY, deal: { landing: "/last-minutes-berlin-prague", checkedAt: TODAY, programme: "lastMinute" } },
    "2026-10-08": { classes: { couchette: 59.99, privateCouchette: 249.99 }, checkedAt: TODAY },
  } };
  const fare = cheapestNight(calendar);
  assert.strictEqual(fare.fromPrice, 40);
  assert.strictEqual(fare.seatClass, "lastMinuteCouchette");
  assert.deepStrictEqual(fare.classes, { couchette: 59.99, privateCouchette: 249.99, lastMinuteCouchette: 40, lastMinutePrivate: 160 });
  assert.strictEqual(fare.classDates.couchette, "2026-10-08");
  assert.strictEqual(fare.dealLanding, "/last-minutes-berlin-prague");
  const regularRows = fareClassRows(fare, { from: true, deals: "exclude" });
  assert.deepStrictEqual(regularRows.map((r) => [r.label, r.price, r.date]), [
    ["Couchette", "from €59.99", "2026-10-08"],
    ["Private compartment", "from €249.99", "2026-10-08"],
  ]);
  const { regular, deal } = splitDealFare(fare);
  assert.deepStrictEqual(regular, { fromPrice: 59.99, seatClass: "couchette", travelDate: "2026-10-08" });
  assert.deepStrictEqual(deal, {
    fromPrice: 40, seatClass: "lastMinuteCouchette", travelDate: "2026-10-02",
    label: "Last-minute couchette", price: "€40", landing: "/last-minutes-berlin-prague", programme: "lastMinute",
  });
  // A 12306-style record (no calendar, no deals) splits into its regular part only.
  assert.deepStrictEqual(splitDealFare({ currency: "CNY", classes: { hardSleeper: 335.5 }, travelDate: "2026-10-05" }), {
    regular: { fromPrice: 335.5, seatClass: "hardSleeper", travelDate: "2026-10-05" }, deal: null,
  });
  // The panel's source: deals kept out of the chips, the Fare line on the
  // regular fare, the deal handed to the booking block.
  const panel = fs.readFileSync("src/components/TrainDetailPanel/TrainDetailPanel.js", "utf8");
  assert.match(panel, /deals: "exclude"/);
  assert.match(panel, /pricing=\{bookingPricing\}/);
  assert.match(panel, /deal=\{dealForBooking\}/);
  assert.strictEqual(fareClassLabel("privateCouchette"), "Private compartment");
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
  // The booking engine does not list Berlin Gesundbrunnen (the probe's
  // /constants), so no deep link is built to it: the card falls back to the
  // route page rather than preselecting a station that does not exist there.
  assert.strictEqual(buildDatedBookingLink({ agencyId: "ES", origin: "Berlin Gesundbrunnen", dest: "Paris Gare du Nord" }), null);
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
    assert.match(page.path, /^\/last-minutes?-[a-z-]+$/);
    assert.ok(page.trains.some((t) => list.includes(t)), `${page.path} sells a train the adapter builds`);
  }
});

console.log(`verify-es-fares: ${passed} checks passed`);
