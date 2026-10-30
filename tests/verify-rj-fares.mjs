// tests/verify-rj-fares.mjs
// RegioJet fare calendars from its booking API (scripts/lib/rj-fares.mjs):
// reading a search answer by night, reading a route's berth classes (berths
// only, women-only left out, the seat kept apart), the calendar pass against a
// fake API, and the labels the pages print. The fixtures are real answers
// (tests/fixtures/rj-fares, read 2026-10-30). No network.
// Run: npm run verify-rj-fares

import assert from "node:assert";
import fs from "node:fs";
import {
  berthClasses,
  departuresByNight,
  fillRjFareCalendars,
  localParts,
  RJ_BERTH_CLASSES,
  routeUrl,
  searchUrl,
} from "../scripts/lib/rj-fares.mjs";
import { credibleClasses, fareClassLabel, fareClassRows, isCouchetteClass } from "../src/lib/fareClasses.mjs";

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/rj-fares/${name}`, import.meta.url), "utf8"));
const SEARCH = fixture("search-praha-cop-2026-11-20.json");
const ROUTE = fixture("route-8730441899.json");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("localParts: the station's own date and clock, not UTC", () => {
  assert.deepStrictEqual(localParts("2026-11-21T10:38:00.000+02:00"), { date: "2026-11-21", clock: "10:38" });
  assert.strictEqual(localParts("21:45"), null);
});

check("a search answer is three nights of the train, keyed by departure date", () => {
  const { nights, last } = departuresByNight(SEARCH, { clock: "21:46" });
  assert.deepStrictEqual([...nights.keys()], ["2026-11-20", "2026-11-21", "2026-11-22"]);
  assert.strictEqual(last, "2026-11-22");
  const first = nights.get("2026-11-20");
  assert.strictEqual(first.routeId, "8730441899");
  assert.strictEqual(first.fromStationId, 372825000); // Praha hl.n.
  assert.strictEqual(first.toStationId, 7122901004); // Čop
  assert.strictEqual(first.dep, "2026-11-20T21:45");
});

check("a departure far from the train's clock, a change or a coach is not the train", () => {
  const r = SEARCH.routes[0];
  const answer = {
    routes: [
      { ...r, departureTime: "2026-11-20T08:15:00.000+01:00" },
      { ...r, id: "x", departureTime: "2026-11-21T21:40:00.000+01:00", transfersCount: 1 },
      { ...r, id: "y", departureTime: "2026-11-22T21:44:00.000+01:00", vehicleTypes: ["TRAIN", "BUS"] },
    ],
  };
  const { nights, last } = departuresByNight(answer, { clock: "21:46" });
  assert.strictEqual(nights.size, 0);
  assert.strictEqual(last, "2026-11-22");
});

check("berths only: the 4-berth couchette and the private compartment, never the seat or women-only", () => {
  const { classes, seat, unmapped, products } = berthClasses(ROUTE);
  assert.deepStrictEqual(classes, { rjCouchette4: 65.9, rjPrivate4: 176 });
  assert.strictEqual(seat, 23.9);
  assert.deepStrictEqual(unmapped, []);
  assert.strictEqual(products.rjCouchette4, "TRAIN_COUCHETTE_RELAX");
  assert.ok(!Object.values(classes).includes(23.9), "the seat price is never a class");
});

check("a sold-out or unknown berth is not priced, and an unknown one is reported", () => {
  const { classes, unmapped } = berthClasses({
    priceClasses: [
      { seatClassKey: "TRAIN_COUCHETTE_RELAX", price: 40, freeSeatsCount: 0, bookable: true },
      { seatClassKey: "TRAIN_COUCHETTE_STANDARD", price: 35, freeSeatsCount: 4, bookable: false },
      { seatClassKey: "TRAIN_COUCHETTE_DELUXE_2", price: 99, freeSeatsCount: 2, bookable: true },
    ],
  });
  assert.deepStrictEqual(classes, {});
  assert.deepStrictEqual(unmapped, ["TRAIN_COUCHETTE_DELUXE_2"]);
});

check("every priced RegioJet class has a label, and the 4-berth couchette counts as a couchette", () => {
  for (const cls of Object.values(RJ_BERTH_CLASSES).filter(Boolean)) {
    assert.notStrictEqual(fareClassLabel(cls), cls, `${cls} has no label`);
  }
  assert.ok(isCouchetteClass("rjCouchette4"));
  const rows = fareClassRows({ classes: { rjCouchette4: 51.6, rjPrivate4: 124 }, currency: "EUR" }, { from: true });
  assert.deepStrictEqual(rows.map((r) => r.label), ["Couchette, berth in 4-berth compartment", "Private compartment, up to 4"]);
});

check("a night's berths stay credible beside its seat", () => {
  const entry = { classes: { rjCouchette4: 65.9 }, seat: 23.9 };
  assert.deepStrictEqual(credibleClasses(entry), { rjCouchette4: 65.9 });
});

// ─── The pass, against a fake API ───────────────────────────────────────────

const TRAIN = {
  lineName: "1021",
  stations: [
    { name: "Praha hl.n.", departure: "21:46" },
    { name: "Chop", arrival: "10:38" },
  ],
};
const CITY_IDS = { "Praha hl.n.": "10202003", Chop: "7122881001" };

function fakeApi({ block = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (block) {
      return new Response("<html>Just a moment...</html>", {
        status: 403,
        headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "1" },
      });
    }
    if (url.includes("/routes/search/simple")) {
      const date = /departureDate=(\d{4}-\d{2}-\d{2})/.exec(url)[1];
      // The next three departures from that date on; the train does not run
      // on the 12th, so a search from the 11th answers the 11th, 13th, 14th.
      const routes = [];
      for (let i = 0; routes.length < 3; i++) {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        const iso = d.toISOString().slice(0, 10);
        if (iso === "2026-11-12") continue;
        routes.push({ ...SEARCH.routes[0], id: `r-${iso}`, departureTime: `${iso}T21:45:00.000+01:00` });
      }
      return Response.json({ routes });
    }
    return Response.json(ROUTE);
  };
  return { fetchImpl, calls };
}

const today = "2026-11-10";
{
  const api = fakeApi();
  const trains = { 1021: structuredClone(TRAIN) };
  const stats = await fillRjFareCalendars(trains, null, {
    today, cityIds: CITY_IDS, fetchImpl: api.fetchImpl, spacingMs: 0, days: 6, log: () => {},
  });
  check("the pass prices six nights with two searches and five route calls", () => {
    const searches = api.calls.filter((u) => u.includes("/search/"));
    const routes = api.calls.filter((u) => u.includes("/routes/r-"));
    assert.strictEqual(searches.length, 2);
    assert.strictEqual(routes.length, 5);
    assert.strictEqual(stats.priced, 5);
    assert.strictEqual(stats.noJourney, 1);
    const nights = trains[1021].fareCalendar.nights;
    assert.deepStrictEqual(nights["2026-11-12"], { none: true, reason: "noJourney", checkedAt: today });
    assert.deepStrictEqual(nights["2026-11-11"].classes, { rjCouchette4: 65.9, rjPrivate4: 176 });
    assert.strictEqual(nights["2026-11-11"].seat, 23.9);
    assert.strictEqual(nights["2026-11-11"].dep, "2026-11-11T21:45");
  });
  check("the headline fare is the cheapest berth night, with its class", () => {
    assert.strictEqual(trains[1021].fare.fromPrice, 65.9);
    assert.strictEqual(trains[1021].fare.seatClass, "rjCouchette4");
    assert.strictEqual(trains[1021].fare.currency, "EUR");
  });
  check("the search is between the Book button's own city ids", () => {
    assert.ok(api.calls[0].startsWith(searchUrl({ fromCity: "10202003", toCity: "7122881001", date: "2026-11-11" })));
    assert.ok(api.calls[1].startsWith(routeUrl({ routeId: "r-2026-11-11", fromStationId: 372825000, toStationId: 7122901004 })));
  });
}

{
  const api = fakeApi({ block: true });
  const trains = { 1021: structuredClone(TRAIN) };
  const previous = {
    1021: { fareCalendar: { version: 3, currency: "EUR", nights: { "2026-11-14": { classes: { rjCouchette4: 51.6 }, checkedAt: "2026-11-09" } } } },
  };
  const stats = await fillRjFareCalendars(trains, previous, {
    today, cityIds: CITY_IDS, fetchImpl: api.fetchImpl, spacingMs: 0, days: 6, log: () => {},
  });
  check("a block ends the pass on the first answer and keeps last night's prices", () => {
    assert.strictEqual(api.calls.length, 1);
    assert.match(stats.blocked, /403/);
    assert.strictEqual(trains[1021].fareCalendar.nights["2026-11-14"].classes.rjCouchette4, 51.6);
    assert.strictEqual(trains[1021].fare.fromPrice, 51.6);
  });
}

{
  const trains = { 1021: structuredClone(TRAIN) };
  const logs = [];
  const stats = await fillRjFareCalendars(trains, null, {
    today, cityIds: { "Praha hl.n.": "10202003" }, fetchImpl: async () => assert.fail("no request"), spacingMs: 0, days: 6, log: (m) => logs.push(m),
  });
  check("a terminus without a RegioJet city id is named, never searched by guess", () => {
    assert.deepStrictEqual(stats.unpriceable, ["1021 (Praha hl.n. → Chop)"]);
    assert.ok(logs.some((l) => l.includes("operator-booking.json")));
    assert.strictEqual(trains[1021].fare, undefined);
  });
}

console.log(`\n[verify-rj-fares] ${passed} checks passed`);
