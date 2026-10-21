// tests/verify-fare-calendar-view.mjs
// What the pages show of a train's fare: a direction never quotes the other
// train's figure (pricingForDirection), a calendar cell is the night's
// couchette and says so when it is not (fareCalendarDays), a night without a
// fare says why, the selected night names the operator's product, a seat
// price is never printed, and the connection page's Book caption quotes the
// train its button opens. No network.
// Run: npm run verify-fare-calendar-view
//
// Synthetic calendars pin each rule; the committed payload
// (public/data/published/initial-data.json) is read for invariants and counts
// only, since it is rewritten nightly and a figure pinned from it would fail
// on a data refresh rather than on a code change.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COUCHETTE_CLASS_KEYS,
  directionFare,
  FARE_CLASS_LABELS,
  fareClassRows,
  formatMoney,
  hasDirectionFares,
  isCouchetteClass,
  pricingForDirection,
  pricingWithoutFigure,
} from "../src/lib/fareClasses.mjs";
import { fareCalendarAnchor, fareCalendarDays } from "../src/lib/fareCalendarView.mjs";
import { resolvePricing } from "../src/lib/pricingResolve.mjs";
import { resolveRouteBooking } from "../src/lib/routeBooking.mjs";
import { eurHintFor } from "../src/lib/fx.mjs";
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PUBLISHED = JSON.parse(read("public/data/published/initial-data.json"));
const VIEW_MAP = PUBLISHED.data?.viewMap ?? PUBLISHED.viewMap;
const AGENCIES = JSON.parse(read("public/data/scraped/backontrack-agencies.json")).data;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const TODAY = "2026-10-10";

/** The figure fields a direction must never borrow from the other train. */
const FIGURE = ["fromPrice", "currency", "travelDate", "seatClass", "trainName", "checkedAt", "basis"];

// A Nightjet row as stampOfficialFares leaves it when only one train found a
// fare: NJ 420 priced, NJ 429 with every night "none" (no fare_0 at all), and
// the row's `pricing` — the cheaper direction's — is therefore NJ 420's.
const PER_TRAIN = {
  agency_id: "ÖBB",
  timetable_source: "nightjet",
  trip_short_name_0: "NJ 429",
  trip_short_name_1: "NJ 420",
  fare_1: {
    fromPrice: 54.9,
    currency: "EUR",
    seatClass: "couchette",
    classes: { couchette: 54.9, sleeperBed: 99.9 },
    source: "nightjet",
    checkedAt: "2026-10-08",
    travelDate: "2026-10-19",
  },
  pricing: {
    type: "dynamic",
    currency: "EUR",
    fromPrice: 54.9,
    source: "nightjet",
    checkedAt: "2026-10-08",
    travelDate: "2026-10-19",
    trainName: "NJ 420",
    seatClass: "couchette",
  },
};

// ─── 1. A direction never quotes the other train's figure ──────────────────

check("pricingForDirection: a train with no fare keeps the model, never the other train's figure", () => {
  const p = pricingForDirection(PER_TRAIN, 0);
  assert.deepStrictEqual(p, { type: "dynamic", source: "nightjet" });
  for (const field of FIGURE) assert.ok(!(field in p), `no ${field} of NJ 420's on NJ 429's card`);
  // The other direction quotes its own train, named as its own.
  const own = pricingForDirection(PER_TRAIN, 1);
  assert.strictEqual(own.fromPrice, 54.9);
  assert.strictEqual(own.trainName, "NJ 420");
  assert.strictEqual(own.type, "dynamic", "the model is the row's");
  assert.strictEqual(own.travelDate, "2026-10-19");
});

check("pricingForDirection: a direction's record names its own train, not the row's cheaper one", () => {
  const both = {
    ...PER_TRAIN,
    fare_0: { fromPrice: 79.9, currency: "EUR", seatClass: "sleeperBed", source: "nightjet", checkedAt: "2026-10-09", travelDate: "2026-10-21" },
  };
  const p0 = pricingForDirection(both, 0);
  assert.strictEqual(p0.fromPrice, 79.9);
  assert.strictEqual(p0.trainName, "NJ 429", "not NJ 420, the train the row's figure came from");
  assert.strictEqual(p0.seatClass, "sleeperBed");
  assert.strictEqual(p0.travelDate, "2026-10-21");
  // A published tariff's basis is the direction's own, or absent.
  const tariff = { ...both, pricing: { ...both.pricing, basis: "tariff" } };
  assert.ok(!("basis" in pricingForDirection(tariff, 0)), "the other train's basis does not ride along");
});

check("pricingForDirection: an unknown direction on a per-train row shows no figure", () => {
  assert.deepStrictEqual(pricingForDirection(PER_TRAIN, null), { type: "dynamic", source: "nightjet" });
  assert.deepStrictEqual(pricingForDirection(PER_TRAIN, undefined), { type: "dynamic", source: "nightjet" });
});

check("pricingForDirection: a row priced per route (prices.json, operator default) keeps its figure", () => {
  const curated = { agency_id: "PKP", pricing: { type: "fixed", fromPrice: 39, currency: "EUR", checkedAt: "2026-09-01" } };
  assert.strictEqual(hasDirectionFares(curated), false);
  assert.strictEqual(pricingForDirection(curated, 0), curated.pricing, "the same record, untouched");
  assert.strictEqual(pricingForDirection(curated, 1), curated.pricing);
  assert.strictEqual(pricingForDirection(curated, null), curated.pricing);
  // The plan index and the panel pass the operator default as `base`.
  const operatorOnly = { agency_id: "ÖBB" };
  const base = resolvePricing(operatorOnly, OPERATOR_PRICING);
  assert.strictEqual(pricingForDirection(operatorOnly, 0, base), base);
  assert.strictEqual(pricingForDirection({}, 0, null), null);
  assert.strictEqual(pricingForDirection(null, 0, null), null);
});

check("pricingWithoutFigure: what is left is the model; nothing left is null", () => {
  assert.strictEqual(pricingWithoutFigure(null), null);
  assert.strictEqual(pricingWithoutFigure({ fromPrice: 39, currency: "EUR" }), null);
  assert.deepStrictEqual(pricingWithoutFigure({ type: "fixed", fromPrice: 39, note: "x" }), { type: "fixed", note: "x" });
  const record = { type: "dynamic", fromPrice: 1 };
  pricingWithoutFigure(record);
  assert.strictEqual(record.fromPrice, 1, "the caller's record is not mutated");
});

check("no figure renders as no figure: eurHintFor and every caller's formatter", () => {
  const none = pricingForDirection(PER_TRAIN, 0);
  assert.strictEqual(eurHintFor(none), "");
  // formatFromPrice (operatorPricing.js, which raw node cannot load) returns
  // null for a record without fromPrice, and every surface that prints a
  // direction's figure goes through it — so a missing figure is no line at
  // all, never "from €null" or "from €0".
  const pricingSrc = read("src/lib/operatorPricing.js");
  assert.ok(/if \(!pricing \|\| pricing\.fromPrice == null\) return null;/.test(pricingSrc), "formatFromPrice refuses a missing figure");
  assert.ok(/formatFromPrice\(pricing\)/.test(read("src/components/TrainDetailPanel/BookingActions.js")), "the panel's Fare line");
  assert.ok(/formatFromPrice\(ride\.pricing\)/.test(read("src/components/plan/RideCard.js")), "the planner's ride card");
  // The panel narrows every card through pricingForDirection, the unknown
  // direction included — it used to keep the row's figure there.
  const panel = read("src/components/TrainDetailPanel/TrainDetailPanel.js");
  assert.ok(/const pricing = pricingForDirection\(\s*tripRoute,\s*fareDir,\s*basePricing,?\s*\)/.test(panel), "panel: pricingForDirection for every card");
  assert.ok(!/fareDir == null\s*\?\s*basePricing/.test(panel), "panel: no fall-back to the row's figure");
  // The plan index prices each leg through the same function.
  assert.ok(/pricingForDirection\(route, direction, resolvePricing\(route, OPERATOR_PRICING\)\)/.test(read("scripts/build-plan-index.mjs")));
});

check("the committed payload: no direction quotes another train's figure", () => {
  let directions = 0;
  let own = 0;
  let silenced = 0;
  for (const row of Object.values(VIEW_MAP)) {
    if (!hasDirectionFares(row)) continue;
    for (const dir of [0, 1]) {
      if (!String(row[`trip_short_name_${dir}`] ?? "").trim()) continue;
      directions++;
      const p = pricingForDirection(row, dir, resolvePricing(row, OPERATOR_PRICING));
      const fare = directionFare(row, dir);
      if (fare) {
        own++;
        assert.strictEqual(p.fromPrice, fare.fromPrice, `${row.route_id} dir ${dir}`);
        assert.strictEqual(p.trainName, row[`trip_short_name_${dir}`].trim());
      } else {
        silenced++;
        for (const field of FIGURE) assert.ok(!(field in (p ?? {})), `${row.route_id} dir ${dir} carries no ${field}`);
      }
    }
  }
  assert.ok(directions > 100, `${directions} priced-per-train directions`);
  console.log(`      (${own} direction(s) quote their own train; ${silenced} have no fare and now show none, where they showed the other train's)`);
});

// ─── 2. A cell is the night's couchette, and says so when it is not ────────

check("isCouchetteClass: per-person couchette places, deal couchettes included, never the private compartment", () => {
  for (const key of ["couchette", "couchetteSecond", "couchetteFirst", "lastMinuteCouchette", "flashSaleCouchette"]) {
    assert.ok(isCouchetteClass(key), key);
    assert.ok(FARE_CLASS_LABELS[key], `${key} has a label, so it can be printed`);
  }
  for (const key of ["privateCouchette", "lastMinutePrivate", "flashSalePrivate", "sleeperBed", "sleeperCabin", "sleeperTriple", "seat"]) {
    assert.ok(!isCouchetteClass(key), key);
  }
  assert.strictEqual(COUCHETTE_CLASS_KEYS.size, 5);
});

// A Nightjet calendar with the three shapes the payload holds: a couchette
// dearer than nothing else, a sleeper cheaper than the couchette (NJ 471,
// 27 Oct), and a sleeper-only night (NJ 40233's 27 and 28 Oct).
const NJ_CALENDAR = {
  currency: "EUR",
  nights: {
    "2026-10-11": { classes: { couchette: 99.9, sleeperBed: 179.9 }, checkedAt: "2026-10-09", offers: { couchette: "Sparschiene", sleeperBed: "Komfortticket" }, seat: 23.47 },
    "2026-10-12": { classes: { couchette: 64.9, sleeperBed: 59.9 }, checkedAt: "2026-10-09", seat: 34.58 },
    "2026-10-13": { classes: { sleeperBed: 214.9 }, checkedAt: "2026-10-09", offers: { sleeperBed: "Standard-Ticket" }, seat: 45.69 },
    "2026-10-14": { none: true, checkedAt: "2026-10-09", reason: "noJourney" },
    "2026-10-15": { none: true, checkedAt: "2026-10-09", reason: "noBerth", seat: 12.31 },
    "2026-10-16": { none: true, checkedAt: "2026-10-09" },
    // 17 Oct never checked
    "2026-10-18": { classes: { couchette: 114.9, sleeperBed: 189.9 }, checkedAt: "2026-10-09" },
  },
};

check("fareCalendarDays: the cell is the cheapest couchette, a sleeper only where no couchette is sold", () => {
  const view = fareCalendarDays(NJ_CALENDAR, { today: TODAY });
  const cells = view.days.map((d) => `${d.date.slice(8)}:${d.state}:${d.cellPrice || "-"}:${d.cellClass ?? "-"}:${d.otherBerth ? "marked" : "-"}`);
  assert.deepStrictEqual(cells, [
    "11:priced:100:couchette:-",
    // The sleeper is €5 cheaper, and the cell is still the couchette.
    "12:priced:65:couchette:-",
    // No couchette sold: the sleeper, marked as such.
    "13:priced:215:sleeperBed:marked",
    "14:none:-:-:-",
    "15:none:-:-:-",
    "16:none:-:-:-",
    "17:unknown:-:-:-",
    "18:priced:115:couchette:-",
  ]);
  const [oct11, oct12, oct13] = view.days;
  assert.strictEqual(oct12.amount, 64.9, "`amount` is the cell's figure");
  assert.strictEqual(oct12.price, "€64.9");
  // The marked cell names its class, and its label is the chip's.
  const labelOf = (d) => d.classes.find((c) => c.key === d.cellClass)?.label;
  assert.strictEqual(labelOf(oct13), "Sleeper, one bed");
  assert.strictEqual(labelOf(oct11), "Couchette");
  // Optional keys are absent, not null: every night is page data.
  assert.ok(!("otherBerth" in oct11) && !("reason" in oct11));
  assert.ok(!("cellClass" in view.days[6]), "a night not checked prints no class");
  // The chips still list every class on sale, cheapest first.
  assert.deepStrictEqual(oct12.classes.map((c) => c.key), ["sleeperBed", "couchette"]);
  assert.strictEqual(view.cellBasis, "couchette");
  assert.strictEqual(view.otherBerthNights, 1);
});

check("fareCalendarDays: banding and the opening night read the figures the grid prints", () => {
  const view = fareCalendarDays(NJ_CALENDAR, { today: TODAY });
  const priced = view.days.filter((d) => d.state === "priced");
  const amounts = priced.map((d) => d.amount);
  assert.deepStrictEqual(amounts, [99.9, 64.9, 214.9, 114.9]);
  // Recomputed from the printed figures alone: the sleeper at €59.9 on the
  // 12th, cheaper than anything printed, plays no part.
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const band = (max - min) / 3;
  for (const d of priced) {
    const expected = d.amount <= min + band ? "low" : d.amount >= max - band ? "high" : "mid";
    assert.strictEqual(d.tier, expected, d.date);
  }
  assert.deepStrictEqual(priced.map((d) => d.tier), ["low", "low", "high", "low"]);
  assert.strictEqual(view.cheapestDate, "2026-10-12", "the cheapest printed figure, a couchette");
  for (const d of priced) assert.strictEqual(d.cellPrice, String(Math.round(d.amount)));
});

check("fareCalendarDays: a sleeper-only calendar says its cells are berths, and marks none of them", () => {
  const view = fareCalendarDays(
    { currency: "EUR", nights: { "2026-10-11": { classes: { sleeperBed: 296 } }, "2026-10-12": { classes: { sleeperBed: 316 } } } },
    { today: TODAY },
  );
  assert.strictEqual(view.cellBasis, "berth");
  // The heading already says "Cheapest berth per night"; a bed on every cell
  // and a legend reading "no couchette that night" would say it 42 times more.
  assert.strictEqual(view.otherBerthNights, 0);
  assert.ok(view.days.every((d) => !("otherBerth" in d) && d.cellClass === "sleeperBed"));
});

// European Sleeper: deals, the private compartment, eight cabin classes.
const ES_CALENDAR = {
  currency: "EUR",
  nights: {
    // A last-minute couchette is a couchette: the deal is the cell.
    "2026-10-11": {
      classes: { couchette: 79.99, sleeperTriple: 69.99, privateCouchette: 219.99, lastMinuteCouchette: 40 },
      checkedAt: TODAY,
      deal: { landing: "/last-minutes-brussels-prague", checkedAt: TODAY },
    },
    // A compartment is never "a couchette" — even if it were the cheapest.
    "2026-10-12": { classes: { couchette: 59.99, privateCouchette: 30 }, checkedAt: TODAY },
    // No couchette place: the cheapest cabin bed, not the whole compartment.
    "2026-10-13": { classes: { sleeperDouble: 129.99, privateCouchette: 219.99, comfortSingle: 299.99 }, checkedAt: TODAY },
    // A flash-sale couchette beats the regular one.
    "2026-10-14": {
      classes: { couchette: 99.99, flashSaleCouchette: 49, flashSalePrivate: 160 },
      checkedAt: TODAY,
      deal: { landing: "/flash-berlin-paris", programme: "flashSale", until: "2026-10-12" },
    },
    // Only a compartment deal: the regular couchette is the cell, the night still amber.
    "2026-10-15": {
      classes: { couchette: 89.99, lastMinutePrivate: 160 },
      checkedAt: TODAY,
      deal: { landing: "/last-minutes-brussels-prague" },
    },
  },
};

check("fareCalendarDays: European Sleeper deal couchettes are cells, the private compartment never is", () => {
  const view = fareCalendarDays(ES_CALENDAR, { today: TODAY, compartmentSize: 5 });
  const cells = view.days.map((d) => `${d.date.slice(8)}:${d.cellPrice}:${d.cellClass}:${d.otherBerth ? "marked" : "-"}:${d.deal ? d.deal.key : "-"}`);
  assert.deepStrictEqual(cells, [
    "11:40:lastMinuteCouchette:-:lastMinuteCouchette",
    "12:60:couchette:-:-",
    "13:130:sleeperDouble:marked:-",
    "14:49:flashSaleCouchette:-:flashSaleCouchette",
    "15:90:couchette:-:lastMinutePrivate",
  ]);
  assert.strictEqual(view.cheapestDate, "2026-10-11");
  assert.strictEqual(view.deals.count, 3, "every deal night is still a deal night");
  assert.strictEqual(view.otherBerthNights, 1);
  // The chip for a deal still prints its promo price bare.
  assert.deepStrictEqual(
    view.days[0].classes.filter((c) => c.deal).map((c) => [c.key, c.price]),
    [["lastMinuteCouchette", "€40"]],
  );
});

check("fareCalendarDays: Trenitalia's couchette leads its sleeper cabin; a cabin-only night is marked", () => {
  const view = fareCalendarDays(
    { currency: "EUR", nights: { "2026-10-11": { classes: { couchette: 53.6, sleeperCabin: 169 } }, "2026-10-12": { classes: { sleeperCabin: 149 } } } },
    { today: TODAY },
  );
  assert.deepStrictEqual(view.days.map((d) => [d.cellClass, Boolean(d.otherBerth)]), [["couchette", false], ["sleeperCabin", true]]);
});

// ─── 3. Why a night has no fare ────────────────────────────────────────────

check("fareCalendarDays: a night without a fare says why, where the source recorded it", () => {
  const view = fareCalendarDays(NJ_CALENDAR, { today: TODAY });
  const reasons = Object.fromEntries(view.days.map((d) => [d.date.slice(8), d.reason]));
  assert.strictEqual(reasons["14"], "noJourney");
  assert.strictEqual(reasons["15"], "noBerth");
  assert.strictEqual(reasons["16"], undefined, "written before the field existed: read as it always was");
  assert.strictEqual(reasons["17"], undefined, "not checked yet");
  assert.strictEqual(reasons["11"], undefined, "a priced night has no reason");
  assert.strictEqual(view.noTrainNights, 1);
  // Anything else is not a reason this page knows how to word.
  const odd = fareCalendarDays(
    { currency: "EUR", nights: { "2026-10-11": { classes: { couchette: 50 } }, "2026-10-12": { none: true, reason: "soldOut" } } },
    { today: TODAY },
  );
  assert.ok(!("reason" in odd.days[1]));
  assert.strictEqual(odd.noTrainNights, 0);
});

// ─── 4. The selected night names the product; a seat is never printed ──────

check("fareCalendarDays: each class carries the operator's product for that night, where it gave one", () => {
  const view = fareCalendarDays(NJ_CALENDAR, { today: TODAY });
  const byDate = Object.fromEntries(view.days.map((d) => [d.date.slice(8), d]));
  assert.deepStrictEqual(byDate["11"].classes, [
    { key: "couchette", label: "Couchette", price: "from €99.9", offer: "Sparschiene" },
    { key: "sleeperBed", label: "Sleeper, one bed", price: "from €179.9", offer: "Komfortticket" },
  ]);
  assert.deepStrictEqual(byDate["13"].classes, [
    { key: "sleeperBed", label: "Sleeper, one bed", price: "from €214.9", offer: "Standard-Ticket" },
  ]);
  // No offers recorded: the chips are exactly what they were.
  assert.deepStrictEqual(byDate["18"].classes, [
    { key: "couchette", label: "Couchette", price: "from €114.9" },
    { key: "sleeperBed", label: "Sleeper, one bed", price: "from €189.9" },
  ]);
  // Only a short plain string is display text.
  const odd = fareCalendarDays(
    {
      currency: "EUR",
      nights: { "2026-10-11": { classes: { couchette: 50, sleeperBed: 90 }, offers: { couchette: { name: "x" }, sleeperBed: "  ".concat("y".repeat(80)) } } },
    },
    { today: TODAY },
  );
  assert.ok(odd.days[0].classes.every((c) => !("offer" in c)));
});

check("a night's seat price is never a class, a cell, or anything else the page prints", () => {
  const view = fareCalendarDays(NJ_CALENDAR, { today: TODAY });
  const printed = JSON.stringify(view);
  for (const seat of ["23.47", "34.58", "45.69", "12.31"]) {
    assert.ok(!printed.includes(seat), `seat price ${seat} reached the view`);
  }
  assert.ok(!/"seat"/.test(printed));
  // An older file with a seat inside `classes` is left out the same way.
  const legacy = fareCalendarDays({ currency: "EUR", nights: { "2026-10-11": { classes: { seat: 20, couchette: 53.6 } } } }, { today: TODAY });
  assert.deepStrictEqual(legacy.days[0].classes.map((c) => c.key), ["couchette"]);
  assert.strictEqual(legacy.days[0].cellPrice, "54");
  // And the component never reads a night's seat.
  assert.ok(!/\.seat\b/.test(read("src/components/seo/FareCalendar.js")));
});

check("FareCalendar renders the marks, the reasons, the products and the heading from the view", () => {
  const src = read("src/components/seo/FareCalendar.js");
  assert.ok(/cellBasis === "couchette"\s*\?\s*"Cheapest couchette per night"\s*:\s*"Cheapest berth per night"/.test(src), "the heading says what a cell is");
  assert.ok(/const otherBerth = day\.state === "priced" && Boolean\(day\.otherBerth\)/.test(src), "a non-couchette cell is marked");
  assert.ok(/\{otherBerth && \(\s*<FaBed/.test(src), "…with a bed in the cell");
  assert.ok(/\(no couchette on sale\)/.test(src), "…and in its label");
  assert.ok(/otherBerthNights > 0 &&/.test(src), "…and the legend explains it when it appears");
  assert.ok(/day\.reason === "noJourney"/.test(src) && /no train that night/.test(src), "no train is told apart from no berth");
  assert.ok(/noTrainNights > 0 &&/.test(src));
  assert.ok(/\{c\.offer && <span/.test(src), "the chips name the product");
  assert.ok(/c\.key === night\.cellClass/.test(src), "the action bar quotes the class the cell prints");
});

check("the committed payload: every cell is the night's cheapest couchette, else marked", () => {
  const counts = {};
  for (const row of Object.values(VIEW_MAP)) {
    for (const dir of [0, 1]) {
      const calendar = row[`fare_calendar_${dir}`];
      if (!calendar) continue;
      const first = Object.keys(calendar.nights).sort()[0];
      // Every night the calendar holds, whatever the date the suite runs on.
      const view = fareCalendarDays(calendar, { today: new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) });
      if (!view) continue;
      const c = (counts[row.timetable_source] ??= { calendars: 0, couchette: 0, other: 0 });
      c.calendars++;
      for (const day of view.days) {
        if (day.state !== "priced") continue;
        const rows = fareClassRows({ classes: calendar.nights[day.date].classes, currency: calendar.currency });
        const couchettes = rows.filter((r) => isCouchetteClass(r.key));
        if (couchettes.length) {
          assert.strictEqual(day.amount, couchettes[0].amount, `${row.route_id} ${day.date}`);
          assert.ok(!day.otherBerth && day.cellClass === couchettes[0].key);
          c.couchette++;
        } else {
          assert.strictEqual(day.amount, rows[0].amount, `${row.route_id} ${day.date}`);
          // Marked where the calendar sells a couchette on some other night;
          // a calendar selling none is all berths, by its heading.
          assert.strictEqual(Boolean(day.otherBerth), view.cellBasis === "couchette", `${row.route_id} ${day.date} is marked`);
          assert.strictEqual(day.cellClass, rows[0].key, `${row.route_id} ${day.date} is named`);
          c.other++;
        }
        assert.ok(!JSON.stringify(day).includes('"seat"'));
      }
      const amounts = view.days.filter((d) => d.state === "priced").map((d) => d.amount);
      assert.strictEqual(view.days.find((d) => d.date === view.cheapestDate).amount, Math.min(...amounts));
    }
  }
  assert.ok(Object.keys(counts).length >= 2, "more than one source keeps a calendar");
  const line = Object.entries(counts)
    .map(([s, c]) => `${s}: ${c.calendars} calendar(s), ${c.couchette} couchette cell(s), ${c.other} marked`)
    .join("; ");
  console.log(`      (${line})`);
});

// ─── 5. The Book caption quotes the train its button opens ─────────────────

/**
 * What src/lib/seo/data.js getRouteDetail puts in the CTA caption, with the
 * formatter's numeric path inlined: operatorPricing.js (formatFromPrice)
 * cannot load in raw node. The wiring itself is asserted against the source.
 */
function ctaBooking(row, dir) {
  return resolveRouteBooking({
    agencyId: row.agency_id || "",
    agencies: AGENCIES,
    agencyUrl: AGENCIES[row.agency_id]?.agency_url ?? null,
    origin: row[`origin_trip_${dir}`],
    dest: row[`destination_trip_${dir}`],
    routeId: String(row.route_id),
    scheduleStops: [],
  });
}

function ctaCaption(row, { booking } = {}) {
  const primaryDir = [0, 1].find((d) => (row[`trip_short_name_${d}`] || "").trim()) ?? 0;
  const routePricing = resolvePricing(row, OPERATOR_PRICING);
  const trainPricing = pricingForDirection(row, primaryDir, routePricing);
  const preselects = Boolean((booking === undefined ? ctaBooking(row, primaryDir) : booking)?.preselects);
  const pricing = preselects ? trainPricing : routePricing;
  const fromPrice = pricing?.fromPrice == null ? null : `from ${formatMoney(pricing.fromPrice, pricing.currency)}`;
  return { primaryDir, preselects, fromPrice, fromPriceEur: eurHintFor(pricing) || "", trainPricing };
}

check("the CTA caption: Wien–Roma (NJ 40233/40294) quotes direction 0's train, whichever direction is cheaper", () => {
  // Which of the pair is direction 0 (and so the row's id) follows the order
  // nightjet.com listed them in that night, so the row is found by its trains.
  const row = Object.values(VIEW_MAP).find((r) =>
    [r.trip_short_name_0, r.trip_short_name_1].includes("NJ 40233"),
  );
  assert.ok(row, "the Wien–Roma Nightjet is in the payload");
  assert.deepStrictEqual(
    [row.trip_short_name_0, row.trip_short_name_1].sort(),
    ["NJ 40233", "NJ 40294"],
  );
  const returnTrain = row.trip_short_name_1;
  // The button preselects direction 0's ends…
  const booking = resolveRouteBooking({
    agencyId: row.agency_id,
    agencies: AGENCIES,
    agencyUrl: AGENCIES[row.agency_id]?.agency_url ?? null,
    origin: row.origin_trip_0,
    dest: row.destination_trip_0,
    routeId: String(row.route_id),
    scheduleStops: [],
  });
  assert.ok(booking?.preselects, "the shop link names direction 0's two ends");
  assert.strictEqual(new URL(booking.href).searchParams.get("stationOrigName"), row.origin_trip_0);
  // …so the caption is direction 0's fare, or nothing.
  const caption = ctaCaption(row);
  assert.ok(caption.preselects);
  assert.strictEqual(caption.primaryDir, 0);
  const own = directionFare(row, 0);
  assert.strictEqual(caption.fromPrice, own ? `from ${formatMoney(own.fromPrice, own.currency)}` : null);
  assert.strictEqual(caption.fromPriceEur, "", "a euro fare carries no ≈€ hint");

  // The same row on a night the return train is cheaper: the caption must not
  // follow the row's figure across to the return train.
  const returnCheaper = structuredClone(row);
  returnCheaper.fare_0 = { ...returnCheaper.fare_0, fromPrice: 114.9, currency: "EUR" };
  returnCheaper.fare_1 = { ...returnCheaper.fare_1, fromPrice: 79.9, currency: "EUR" };
  returnCheaper.pricing = { ...returnCheaper.pricing, fromPrice: 79.9, trainName: returnTrain };
  assert.strictEqual(ctaCaption(returnCheaper).fromPrice, "from €114.9");
  // And on a night direction 0's train has no fare at all, no figure.
  const outboundUnpriced = structuredClone(returnCheaper);
  delete outboundUnpriced.fare_0;
  assert.strictEqual(ctaCaption(outboundUnpriced).fromPrice, null);
  assert.strictEqual(ctaCaption(outboundUnpriced).fromPriceEur, "");
});

check("the CTA caption: a row priced per route quotes the route, a yuan fare keeps its ≈€", () => {
  const curated = { agency_id: "PKP", trip_short_name_0: "EN 1", pricing: { type: "fixed", fromPrice: 39, currency: "EUR" } };
  assert.strictEqual(ctaCaption(curated).fromPrice, "from €39");
  // A row whose only train is direction 1 books direction 1.
  const oneWay = { ...PER_TRAIN, trip_short_name_0: "" };
  assert.strictEqual(ctaCaption(oneWay, { booking: { preselects: true } }).primaryDir, 1);
  assert.strictEqual(ctaCaption(oneWay, { booking: { preselects: true } }).fromPrice, "from €54.9");
  const china = Object.values(VIEW_MAP).find((r) => r.timetable_source === "chinese" && directionFare(r, 0));
  if (china) {
    const caption = ctaCaption(china);
    assert.ok(caption.fromPrice.startsWith("from ¥"), caption.fromPrice);
    assert.ok(/^≈ €\d/.test(caption.fromPriceEur), `the euro hint is the same pricing's: ${caption.fromPriceEur}`);
  }
});

check("the CTA caption: a button that opens no train in particular quotes the route, as the facts tile does", () => {
  // Per-train fares, but a link that preselects nothing: the caption names no
  // train, so neither direction's figure is the one "you'd pay" — the route's is.
  const row = { ...PER_TRAIN, pricing: { type: "dynamic", fromPrice: 54.9, currency: "EUR", trainName: "NJ 2" } };
  assert.strictEqual(ctaCaption(row, { booking: { preselects: false } }).fromPrice, "from €54.9");
  assert.strictEqual(ctaCaption(row, { booking: null }).fromPrice, "from €54.9");
  // European Sleeper's Brussels–Prague: the Book button is the operator's corridor page.
  const es = VIEW_MAP["237"];
  if (es?.pricing?.fromPrice != null) {
    const booking = ctaBooking(es, 0);
    assert.strictEqual(booking?.preselects, false, "a corridor page selects no train");
    assert.strictEqual(ctaCaption(es).fromPrice, `from ${formatMoney(es.pricing.fromPrice, es.pricing.currency)}`);
  }
});

check("the CTA caption is wired from the CTA's own direction in getRouteDetail", () => {
  const src = read("src/lib/seo/data.js");
  assert.ok(/const primaryDir = \[0, 1\]\.find\(\(d\) => \(route\[`trip_short_name_\$\{d\}`\] \|\| ""\)\.trim\(\)\) \?\? 0;/.test(src), "the first direction with a train, as the loop picks `primary`");
  assert.ok(/const trainPricing = pricingForDirection\(route, primaryDir, summary\.pricing\);/.test(src));
  assert.ok(/const ctaPricing = resolvedBooking\?\.preselects \? trainPricing : summary\.pricing;/.test(src), "a direction's figure only beside a button that opens that train");
  // The TrainTrip node names direction 0's train, so it quotes that train's fare.
  assert.ok(/^\s+trainPricing,$/m.test(src), "the detail carries the named train's pricing");
  const page = read("src/pages/connections/[pair].js");
  assert.ok(/detail\.trainPricing !== undefined\s*\?\s*detail\.trainPricing/.test(page), "TrainTrip offers read it");
  assert.ok(!/^\s+trainPricing:/m.test(page), "…and it stays out of the page props");
  assert.ok(/fromPrice: formatFromPrice\(ctaPricing\) \|\| null/.test(src));
  assert.ok(/fromPriceEur: eurHintFor\(ctaPricing\) \|\| ""/.test(src));
  assert.ok(!/fromPrice: summary\.fromPrice \|\| null, fromPriceEur/.test(src), "no longer the row's cheaper-direction figure");
  // `primary` is directions[0], which the loop fills from the first direction
  // with a train number — the same one primaryDir names.
  assert.ok(/if \(!trainNumber\) continue;/.test(src) && /const primary = directions\[0\] \|\| \{\};/.test(src));
});

check("the committed payload: a CTA caption is its train's fare where the button opens that train, else the route's", () => {
  let rows = 0;
  let changed = 0;
  let silenced = 0;
  let routeLevel = 0;
  let offersMoved = 0;
  let offersDropped = 0;
  for (const row of Object.values(VIEW_MAP)) {
    if (!hasDirectionFares(row)) continue;
    rows++;
    const caption = ctaCaption(row);
    const own = directionFare(row, caption.primaryDir);
    const route = resolvePricing(row, OPERATOR_PRICING);
    if (caption.preselects) {
      assert.strictEqual(caption.fromPrice, own ? `from ${formatMoney(own.fromPrice, own.currency)}` : null, row.route_id);
      if (!own) silenced++;
      else if (own.fromPrice !== row.pricing?.fromPrice) changed++;
    } else {
      assert.strictEqual(caption.fromPrice, route?.fromPrice == null ? null : `from ${formatMoney(route.fromPrice, route.currency)}`, row.route_id);
      routeLevel++;
    }
    // The TrainTrip node names the primary train: its fare, never the return's.
    assert.strictEqual(caption.trainPricing?.fromPrice ?? null, own?.fromPrice ?? null, `${row.route_id} TrainTrip`);
    if (!own && route?.fromPrice != null) offersDropped++;
    else if (own && own.fromPrice !== route?.fromPrice) offersMoved++;
  }
  assert.ok(rows > 50, `${rows} rows priced per train`);
  console.log(
    `      (${rows} rows priced per train: ${changed} caption(s) quote the outbound where the row's figure was the return's, ` +
      `${silenced} quote nothing where the outbound has no fare, ${routeLevel} open no particular train and quote the route; ` +
      `TrainTrip offers: ${offersMoved} now the named train's figure, ${offersDropped} dropped where it has none)`,
  );
});

check("the panel's fare-date link and the page's calendar agree on the anchor", () => {
  // The panel reads a feed trip's label, the page the row's; both must land
  // on the same id or the link opens the page at the top.
  assert.strictEqual(fareCalendarAnchor("ES 453"), "fares-453");
  assert.strictEqual(fareCalendarAnchor("453"), "fares-453");
  assert.strictEqual(fareCalendarAnchor("099"), "fares-99");
  assert.strictEqual(fareCalendarAnchor("IRN 1954/R 8824"), "fares-1954");
  assert.strictEqual(fareCalendarAnchor(""), "");
  assert.strictEqual(fareCalendarAnchor(null), "");
  // Two calendars on one page with the same id would send the link to the
  // first: no published pair carries two directions sharing a number.
  for (const row of Object.values(VIEW_MAP)) {
    const ids = [row.trip_short_name_0, row.trip_short_name_1]
      .filter((n, i) => row[`fare_calendar_${i}`])
      .map(fareCalendarAnchor)
      .filter(Boolean);
    assert.strictEqual(new Set(ids).size, ids.length, `${row.route_id}: ${ids}`);
  }
});

console.log(`\nverify-fare-calendar-view: ${passed} checks passed`);
