// tests/verify-plan.mjs
// The trip planner's pure core: the URL grammar, the availability verdict, the
// leg graph and the journey search. Run: npm run verify-plan
//
// Several checks assert against the COMMITTED payload rather than a fixture,
// because the faults they pin are properties of the real data — a city slug
// that would break the URL separator, a service string nobody can parse, a
// route offered on a night it does not run. A fixture cannot notice those.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  addDays,
  buildPlanHref,
  buildPlanPath,
  clampStay,
  decodeStays,
  encodeStays,
  hopDates,
  isPlanDate,
  parsePlanPath,
  splitCorridor,
} from "../src/lib/plan/url.mjs";
import { availabilityFor, isOfferable, weekdayOf } from "../src/lib/plan/availability.mjs";
import {
  buildLegs,
  isOvernightRide,
  isShortHop,
  MIN_TRIP_MINUTES,
  segmentOf,
  toMinutes,
  tripDurationMinutes,
} from "../src/lib/plan/legs.mjs";
import {
  createPlanner,
  departuresFrom,
  findJourneys,
  isInterchange,
  resolvePlan,
  ridesBetween,
} from "../src/lib/plan/search.mjs";
import { hydratePlanIndex, packPlanIndex } from "../src/lib/plan/index-codec.mjs";
import { formatPlanDate } from "../src/lib/plan/format.mjs";
import {
  byStartCityScore,
  bySuggestionScore,
  isDeEmphasised,
  prominenceLookup,
  scoreCities,
  startCityScore,
  suggestionScore,
} from "../src/lib/plan/prominence.mjs";
import {
  CITY_COUNTRY_OVERRIDES,
  DEFAULT_REGION,
  REGIONS,
  START_CITY_LIMIT,
  regionForCity,
  regionForCountry,
  topStartCitiesByRegion,
} from "../src/lib/plan/regions.mjs";
import { rankCities } from "../src/lib/plan/citySearch.mjs";
import CITY_PROMINENCE from "../data/overrides/city-prominence.json" with { type: "json" };
import { slugify } from "../src/lib/seo/slugify.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";
import { buildPlanIndex, readPublished } from "../scripts/build-plan-index.mjs";
import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";
import DISABLED_ROUTES from "../data/overrides/disabled-routes.json" with { type: "json" };
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };
import { resolvePricing } from "../src/lib/pricingResolve.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const ROOT = path.resolve(import.meta.dirname, "..");
const payload = stripDisabledRoutes(readPublished().data, DISABLED_ROUTES);

// ── URL grammar ──────────────────────────────────────────────────────────────

check("a plan round-trips through its URL", () => {
  const known = new Set(["amsterdam", "berlin", "prague", "vienna"]);
  for (const plan of [
    { cities: ["amsterdam"], date: null },
    { cities: ["amsterdam"], date: "2026-09-18" },
    { cities: ["amsterdam", "vienna"], date: "2026-09-18" },
    { cities: ["amsterdam", "berlin", "prague", "vienna"], date: "2026-09-18" },
  ]) {
    const segments = buildPlanPath(plan).replace(/^\/plan\/?/, "").split("/").filter(Boolean);
    const back = parsePlanPath(segments, known);
    assert.deepEqual(back.cities, plan.cities, JSON.stringify(plan));
    assert.equal(back.date, plan.date, JSON.stringify(plan));
  }
  assert.equal(buildPlanPath({ cities: [] }), "/plan");
  // A date with no cities is not a plan, so it does not reach the path.
  assert.equal(buildPlanPath({ cities: [], date: "2026-09-18" }), "/plan");
});

check("NO city slug contains the corridor separator", () => {
  // buildPairSlug and the planner both join cities with "-to-". A city whose
  // own slug contained it would split into two cities that do not exist, and
  // the failure would be silent — a plan URL resolving to a different plan.
  const offenders = [];
  for (const route of Object.values(payload.viewMap)) {
    for (const dir of [0, 1]) {
      for (const key of [`origin_trip_${dir}`, `destination_trip_${dir}`]) {
        const name = route[key];
        if (!name) continue;
        const slug = slugify(cityForStation(name));
        if (slug.includes("-to-")) offenders.push(`${name} → ${slug}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `city slugs containing "-to-": ${offenders.join(", ")}`);
});

check("splitCorridor rejoins a piece that is not a known city", () => {
  // The belt to that braces: if such a city ever appears, the known-slug set
  // puts it back together instead of inventing two places.
  const known = new Set(["latour-de-carol", "paris", "val-to-vic"]);
  assert.deepEqual(splitCorridor("paris-to-latour-de-carol", known), [
    "paris",
    "latour-de-carol",
  ]);
  assert.deepEqual(splitCorridor("paris-to-val-to-vic", known), ["paris", "val-to-vic"]);
  // With no known set it degrades to the plain split, exactly as before.
  assert.deepEqual(splitCorridor("paris-to-val-to-vic"), ["paris", "val", "vic"]);
});

check("stopover nights encode only when non-default", () => {
  assert.equal(encodeStays([0, 0], 4), "");
  assert.equal(encodeStays([2, 0], 4), "2,0");
  assert.equal(encodeStays([2], 2), "", "a two-city plan has no intermediate city");
  assert.deepEqual(decodeStays("2,1"), [2, 1]);
  assert.deepEqual(decodeStays(undefined), []);
  assert.equal(clampStay(-5), 0);
  assert.equal(clampStay(999), 30);
  assert.equal(buildPlanHref({ cities: ["a", "b", "c"], date: "2026-09-18", stays: [2] }),
    "/plan/a-to-b-to-c/2026-09-18?stay=2");
});

check("dates are calendar dates, never instants", () => {
  assert.equal(addDays("2026-09-18", 1), "2026-09-19");
  // Across a DST boundary and a year end, where an instant-based +86400000 drifts.
  assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(formatPlanDate("2026-09-18"), "Fri 18 Sep");
  assert.equal(weekdayOf("2026-09-18"), "fri");
  assert.equal(isPlanDate("2026-02-30"), false, "a date that does not exist is not a date");
  assert.equal(isPlanDate("2026-9-8"), false);
});

check("hop dates advance one night per hop plus stopovers", () => {
  assert.deepEqual(hopDates("2026-09-18", 3, [0, 0]), [
    "2026-09-18", "2026-09-19", "2026-09-20",
  ]);
  assert.deepEqual(hopDates("2026-09-18", 3, [1, 2]), [
    "2026-09-18", "2026-09-20", "2026-09-23",
  ]);
});

// ── Availability: the tri-state ──────────────────────────────────────────────

check("a weekday pattern decides, both ways", () => {
  const leg = { days: ["mon", "wed", "fri"], serviceText: "2026: Mon, Wed, Fri" };
  assert.equal(availabilityFor(leg, "2026-09-18").status, "runs");
  assert.equal(availabilityFor(leg, "2026-09-19").status, "no");
  assert.equal(availabilityFor(leg, "2026-09-18").confidence, "pattern");
});

check("no operating days is UNKNOWN, never a yes", () => {
  // 104 of the payload's legs are in this state. Letting them through as
  // "runs" is the planner claiming a timetable it does not have.
  const verdict = availabilityFor({ days: [], serviceText: "" }, "2026-09-18");
  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.confidence, "none");
  assert.equal(isOfferable(verdict.status), true, "unknown is still worth offering");
});

check("a cadence is unknown, not a weekday guess", () => {
  const leg = { days: [], cadence: "Every 2nd day", serviceText: "2026: Every 2nd day" };
  const verdict = availabilityFor(leg, "2026-09-18");
  assert.equal(verdict.status, "unknown");
  assert.match(verdict.reason, /every 2nd day/i);
});

check("a suspended route is never offered", () => {
  // European Sleeper's Amsterdam–Milano carries "Postponed to 2027" and no
  // service string at all, so every rule but this one lets it through — and it
  // is the first thing an Amsterdam search finds.
  const leg = { days: ["mon"], irregularity: "Postponed to 2027", serviceText: "" };
  const verdict = availabilityFor(leg, "2026-09-21");
  assert.equal(verdict.status, "suspended");
  assert.equal(isOfferable(verdict.status), false);
  assert.equal(
    availabilityFor({ irregularity: "currently suspended due to construction works" }, "2026-09-18")
      .status,
    "suspended",
  );
  // A note that merely QUALIFIES a running service must not suppress it.
  assert.notEqual(availabilityFor({ days: ["fri"], irregularity: "Times may vary" }, "2026-09-18").status, "suspended");
});

check("a validity window is honoured on both sides", () => {
  const leg = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], validFrom: "2026-06-22", validUntil: "2026-08-30" };
  assert.equal(availabilityFor(leg, "2026-07-10").status, "runs");
  assert.equal(availabilityFor(leg, "2026-09-18").status, "no");
  assert.equal(availabilityFor(leg, "2026-01-05").status, "not-yet");
});

// ── The leg graph ────────────────────────────────────────────────────────────

const { legs, cities } = buildLegs(payload);

check("every viewMap direction with two endpoints becomes a leg", () => {
  let expected = 0;
  for (const route of Object.values(payload.viewMap)) {
    for (const dir of [0, 1]) {
      if (route[`origin_trip_${dir}`] && route[`destination_trip_${dir}`]) expected++;
    }
  }
  // A leg is dropped only when its whole chain collapses to under two cities.
  assert.ok(legs.length > expected * 0.95, `${legs.length} legs from ${expected} directions`);
  assert.ok(legs.length <= expected);
});

check("the two directions of a route are two legs", () => {
  // One row is not one leg: the directions have their own stops, times and
  // operating days, and ORing them is how the outbound gets offered on a night
  // only the return runs.
  const both = legs.filter((l) => l.routeId === legs[0].routeId);
  for (const leg of legs) assert.ok(leg.direction === 0 || leg.direction === 1);
  const byRoute = new Map();
  for (const leg of legs) byRoute.set(leg.routeId, (byRoute.get(leg.routeId) || 0) + 1);
  assert.ok([...byRoute.values()].some((n) => n === 2), "some route must have both directions");
  assert.ok(both.length >= 1);
});

check("via stations are boardable, and that is what makes the product work", () => {
  const planner = createPlanner({ legs, cities });
  const calls = planner.byCity.get("amsterdam") || [];
  const reachable = new Set();
  let endpointOnly = 0;
  for (const { leg, index } of calls) {
    for (let j = index + 1; j < leg.stops.length; j++) reachable.add(leg.stops[j].citySlug);
    if (index === 0) endpointOnly++;
  }
  assert.ok(
    reachable.size > endpointOnly * 3,
    `endpoint-only reading offers ${endpointOnly} destinations, full chain ${reachable.size}`,
  );
  assert.ok(reachable.has("berlin") && reachable.has("prague"),
    "Berlin and Prague are via stops from Amsterdam and must be reachable");
});

check("a segment reports only the times it actually has", () => {
  const leg = {
    stops: [
      { station: "A", city: "A", citySlug: "a", arrival: "", departure: "" },
      { station: "B", city: "B", citySlug: "b", arrival: "", departure: "" },
      { station: "C", city: "C", citySlug: "c", arrival: "", departure: "" },
    ],
    departure: "22:00",
    arrival: "07:00",
    durationMinutes: 540,
  };
  const whole = segmentOf(leg, 0, 2);
  assert.equal(whole.departure, "22:00");
  assert.equal(whole.arrival, "07:00");
  assert.equal(whole.isWholeRoute, true);
  assert.equal(whole.isTerminus, true);

  // Boarding mid-route: no published departure, so no invented one.
  const mid = segmentOf(leg, 1, 2);
  assert.equal(mid.isWholeRoute, false, "boarding mid-route is not the whole route");
  assert.equal(mid.isTerminus, true, "but the train still ends there");
  assert.equal(segmentOf(leg, 0, 1).isTerminus, false);
  assert.equal(mid.departure, "", "an intermediate boarding has no published time");
  assert.equal(mid.arrival, "07:00");
  assert.equal(mid.durationMinutes, null, "a duration needs two clocks");

  // A feed time on the stop wins.
  leg.stops[1].departure = "23:30";
  assert.equal(segmentOf(leg, 1, 2).departure, "23:30");
  assert.equal(segmentOf(leg, 1, 2).durationMinutes, 450);

  assert.equal(segmentOf(leg, 2, 1), null, "backwards is not a ride");
  assert.equal(segmentOf(leg, 0, 9), null);
});

check("placeholder 00:00 → 00:00 times are dropped, not shown as a day-long ride", () => {
  const built = buildLegs({
    stops: [],
    trips: {},
    viewMap: {
      9: {
        route_id: 9,
        origin_trip_0: "Amsterdam Centraal",
        destination_trip_0: "Milano Centrale",
        origin_departure_time_0: "00:00",
        destination_arrival_time_0: "00:00",
      },
    },
  });
  assert.equal(built.legs[0].departure, "");
  assert.equal(built.legs[0].durationMinutes, null);
});

check("an overnight ride is told apart from an evening hop", () => {
  assert.equal(isOvernightRide("22:34", "06:01", 447), true, "wraps midnight");
  assert.equal(isOvernightRide("18:13", "22:16", 243), false, "four-hour evening ride");
  assert.equal(isOvernightRide("", "", 600), true, "long enough with no clocks");
  assert.equal(toMinutes("T22:47"), 22 * 60 + 47);
  assert.equal(toMinutes("2026-09-13T19:22:00"), 19 * 60 + 22);
  assert.equal(toMinutes("not a time"), null);
});

// ── Search ───────────────────────────────────────────────────────────────────

const index = buildPlanIndex(payload, { generatedAt: "test" });
const planner = createPlanner(hydratePlanIndex(index));

check("the packed index round-trips", () => {
  const again = hydratePlanIndex(packPlanIndex(hydratePlanIndex(index)));
  assert.equal(again.legs.length, planner.legs.length);
  assert.deepEqual(again.legs[0].stops, planner.legs[0].stops);
  // Idempotent, like hydratePkpBundle: hydrating an expanded index is a no-op.
  assert.equal(hydratePlanIndex(again), again);
});

check("a suspended route is absent from the offered destinations", () => {
  const offered = departuresFrom(planner, { from: "amsterdam", date: "2026-09-18" });
  const all = departuresFrom(planner, {
    from: "amsterdam",
    date: "2026-09-18",
    includeUnavailable: true,
  });
  const milanOffered = offered.destinations.find((d) => d.city.slug === "milan");
  const milanAll = all.destinations.find((d) => d.city.slug === "milan");
  assert.ok(milanAll, "Milan must be in the unfiltered list");
  assert.equal(milanAll.best.availability.status, "suspended");
  assert.equal(milanOffered, undefined, "a postponed route must never be offered");
  assert.ok(all.destinations.length > offered.destinations.length);
});

check("destinations rank by what we can stand behind, then by a night's sleep", () => {
  const { destinations } = departuresFrom(planner, { from: "amsterdam", date: "2026-09-18" });
  const statuses = destinations.map((d) => d.best.availability.status);
  assert.deepEqual(
    [...statuses].sort((a, b) => (a === "runs" ? -1 : b === "runs" ? 1 : 0)),
    statuses,
    "confirmed destinations come first",
  );
  const firstEvening = destinations.findIndex(
    (d) => d.best.availability.status === "runs" && !d.best.isOvernight,
  );
  const lastOvernight = destinations.reduce(
    (last, d, i) =>
      d.best.availability.status === "runs" && d.best.isOvernight ? i : last,
    -1,
  );
  if (firstEvening !== -1 && lastOvernight !== -1) {
    assert.ok(
      lastOvernight < firstEvening,
      "every overnight destination outranks every same-evening one",
    );
  }
});

check("a destination the train terminates at outranks one it passes through", () => {
  // From Paris the list opened with Assier, Aubin, Capdenac, Cransac and
  // Gramat — five villages on the Rodez sleeper, above Rodez and Toulouse.
  const { destinations } = departuresFrom(planner, { from: "paris", date: "2026-09-18" });
  const running = destinations.filter((d) => d.best.availability.status === "runs");
  assert.ok(running.length > 10, `only ${running.length} running destinations from Paris`);
  const firstPassThrough = running.findIndex((d) => !d.best.isTerminus);
  const lastTerminus = running.reduce((last, d, i) => (d.best.isTerminus ? i : last), -1);
  assert.ok(
    lastTerminus < firstPassThrough,
    "every terminus destination must outrank every pass-through stop",
  );
  const top = running.slice(0, 9).map((d) => d.city.slug);
  for (const city of ["rodez", "toulouse", "nice"]) {
    assert.ok(top.includes(city), `${city} should be a headline Paris destination, got ${top}`);
  }

  // Amsterdam is the sharper case: ES 453 runs Brussels → Prague, so from
  // Amsterdam the ride is not the whole route but Prague is still where the
  // train ends — and it must not be filed with the villages it passes at 3am.
  const ams = departuresFrom(planner, { from: "amsterdam", date: "2026-09-18" }).destinations;
  const prague = ams.findIndex((d) => d.city.slug === "prague");
  const decin = ams.findIndex((d) => d.city.slug === "decin");
  assert.ok(prague !== -1 && decin !== -1, "both Prague and Děčín should be reachable");
  assert.ok(prague < decin, "Prague is the destination; Děčín is a stop on the way");
});

check("a journey only changes trains where trains start or end", () => {
  // Without this the search answers Amsterdam → Vienna with a change at Bad
  // Schandau and another at Děčín — two village stops on the through train it
  // should have offered directly.
  const journeys = findJourneys(planner, {
    from: "amsterdam",
    to: "vienna",
    date: "2026-09-18",
    maxLegs: 3,
    limit: 8,
  });
  assert.ok(journeys.length > 0);
  assert.equal(journeys[0].cities.length, 2, "the direct night train comes first");
  for (const journey of journeys) {
    for (const slug of journey.cities.slice(1, -1)) {
      assert.ok(isInterchange(planner, slug), `${slug} is not a place to change trains`);
    }
  }
});

check("a resolved plan dates each hop and counts sleeper nights honestly", () => {
  const plan = resolvePlan(planner, {
    cities: ["amsterdam", "berlin", "prague", "vienna"],
    date: "2026-09-18",
    stays: [1, 2],
  });
  assert.equal(plan.hops.length, 3);
  assert.deepEqual(plan.hops.map((h) => h.date), ["2026-09-18", "2026-09-20", "2026-09-23"]);
  assert.equal(plan.nights, 6, "3 hops + 3 stopover nights");
  assert.ok(plan.sleeperNights <= plan.hops.length);
  assert.equal(plan.endDate, "2026-09-24");
  for (const hop of plan.hops) {
    if (hop.best) {
      assert.equal(hop.best.from.citySlug, hop.from.slug);
      assert.equal(hop.best.to.citySlug, hop.to.slug);
      assert.equal(hop.best.date, hop.date, "each hop is judged on its own night");
    }
  }
});

check("a hop with no train is reported, not silently dropped", () => {
  const plan = resolvePlan(planner, {
    cities: ["amsterdam", "beijing"],
    date: "2026-09-18",
  });
  assert.equal(plan.hops.length, 1);
  assert.equal(plan.hops[0].best, null);
  assert.equal(plan.hops[0].served, false);
  assert.equal(plan.complete, false);
});

// ── The index the planner ships ──────────────────────────────────────────────

check("the committed plan index matches the committed payload", () => {
  const file = path.join(ROOT, "public/data/published/plan-index.json");
  assert.ok(fs.existsSync(file), "run `npm run build-plan-index`");
  const committed = hydratePlanIndex(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(
    committed.legs.length,
    planner.legs.length,
    "plan-index.json is stale — re-run `npm run build-plan-index`",
  );
  assert.equal(committed.cities.length, planner.cities.length);
});

check("the index never carries a route the admin disabled", () => {
  const disabled = new Set(
    (Array.isArray(DISABLED_ROUTES) ? DISABLED_ROUTES : DISABLED_ROUTES?.routes ?? []).map(String),
  );
  for (const leg of planner.legs) {
    assert.ok(!disabled.has(String(leg.routeId)), `route ${leg.routeId} is disabled`);
  }
});

check("the shipped index stays inside its budget", () => {
  const file = path.join(ROOT, "public/data/published/plan-index.json");
  const bytes = fs.statSync(file).size;
  assert.ok(bytes < 900 * 1024, `plan-index.json is ${(bytes / 1024).toFixed(0)} KB`);
});

check("the planner and the UI resolve a price the same way", () => {
  // getOperatorPricing() is the definition but cannot load in raw node, so the
  // plan-index build calls resolvePricing() with the table passed in. Two
  // copies of "which price wins" is exactly the drift this repo keeps paying
  // for, so the two are asserted to agree.
  const table = OPERATOR_PRICING;
  for (const agency of Object.keys(table)) {
    assert.deepEqual(resolvePricing({ agency_id: agency }, table), table[agency]);
  }
  assert.equal(resolvePricing({ agency_id: "NOT_AN_OPERATOR" }, table), null);
  // A route's own pricing beats its operator's — the route-first seam.
  const own = { type: "fixed", fromPrice: 39 };
  assert.equal(resolvePricing({ agency_id: "ÖBB", pricing: own }, table), own);

  const advised = planner.legs.filter((l) => l.pricing?.type).length;
  assert.ok(advised > 400, `only ${advised} legs carry pricing advice`);
  // Nothing may invent a figure: every from-price must come from the table.
  for (const leg of planner.legs) {
    if (leg.pricing?.fromPrice == null) continue;
    assert.ok(
      Object.values(table).some((p) => p.fromPrice === leg.pricing.fromPrice),
      `leg ${leg.id} has a from-price no operator declares`,
    );
  }
});

check("a ride carries every field the card renders", () => {
  // rideFor() copies named fields off the leg, so renaming one on the leg and
  // not here drops it silently: the pricing advice simply stopped appearing on
  // every card, with nothing failing anywhere.
  const { destinations } = departuresFrom(planner, { from: "amsterdam", date: "2026-09-18" });
  const ride = destinations[0].best;
  for (const field of [
    "key", "legId", "routeId", "train", "operatorIds", "pairSlug", "pricing",
    "date", "from", "to", "departure", "arrival", "durationMinutes",
    "isOvernight", "isTerminus", "isWholeRoute", "availability",
  ]) {
    assert.ok(field in ride, `ride is missing "${field}"`);
  }
  const priced = planner.legs.find((l) => l.pricing?.type);
  assert.ok(priced, "some leg must carry pricing");
  const ridesWithPricing = destinations.filter((d) => d.best.pricing?.type).length;
  assert.ok(ridesWithPricing > 0, "pricing must survive the leg → ride copy");
});

check("every terminus city knows its country", () => {
  // The published payload cannot supply one — normalizeStops() trims a stop to
  // id/name/lat/lon — so this reads the raw stop index and the row stamps. It
  // was silently 0 of 189, which left the picker flagless and the suggestion
  // weighting with nothing to weight by.
  const terms = planner.cities.filter((c) => c.terminusCount > 0);
  const withCountry = terms.filter((c) => c.country);
  assert.ok(
    withCountry.length > terms.length * 0.9,
    `only ${withCountry.length} of ${terms.length} terminus cities have a country`,
  );
  // Cyrillic-stored Ukrainian stations resolve only through stop_name_romanized.
  assert.equal(planner.cityBySlug.get("kyiv")?.country, "UA");
  assert.equal(planner.cityBySlug.get("lviv")?.country, "UA");
  // A synthetic operator's stations are absent from Back-on-Track's table and
  // fall back to the operator's own country.
  assert.equal(planner.cityBySlug.get("beijing")?.country, "CN");
  assert.equal(planner.cityBySlug.get("vienna")?.country, "AT");
});

check("suggestion weighting reorders and never filters", () => {
  // The line this whole feature rests on. Every de-emphasised city must still
  // be in the index, still be findable by name, and still be routable.
  const damped = planner.cities.filter((c) => c.prominence < 1);
  assert.ok(damped.length > 0, "nothing is de-emphasised — is the table wired?");
  for (const slug of ["kyiv", "lviv", "beijing", "odesa", "kharkiv"]) {
    const city = planner.cityBySlug.get(slug);
    assert.ok(city, `${slug} was dropped from the index`);
    assert.ok(city.prominence < 1, `${slug} should be de-emphasised`);
    assert.ok(city.legCount > 0, `${slug} lost its legs`);
  }
  // Typing the name still puts it first: match quality outranks weighting.
  for (const [query, expected] of [["lviv", "Lviv"], ["kyiv", "Kyiv"], ["beijing", "Beijing"]]) {
    assert.equal(rankCities(planner.cities, query)[0]?.name, expected, query);
  }
  // And it is still routable — a plan that asks for it gets the real answer.
  const { rides } = ridesBetween(planner, { from: "przemysl", to: "kyiv", date: "2026-09-18" });
  assert.ok(rides.length > 0, "Przemyśl → Kyiv must still return trains");
});

check("the suggested starting cities are European hubs", () => {
  const top = planner.cities
    .filter((c) => c.terminusCount > 0)
    .sort(bySuggestionScore)
    .slice(0, 24);
  const slugs = top.map((c) => c.slug);
  for (const city of ["vienna", "paris", "prague", "berlin", "munich", "milan", "amsterdam"]) {
    assert.ok(slugs.includes(city), `${city} should be a suggested start, got ${slugs.join(", ")}`);
  }
  // Ranked by raw connectivity this list held six Ukrainian and five Chinese
  // cities, with Paris 19th.
  for (const code of ["UA", "CN", "US", "CA"]) {
    assert.equal(
      top.filter((c) => c.country === code).length,
      0,
      `${code} should not headline the suggestions`,
    );
  }
});

check("every start city lands in exactly one region tab", () => {
  // A city we cannot place is in NO region rather than quietly in the default
  // one — a wrong tab is worse than an absent chip. So the count that matters
  // is the unplaced one, and it must be zero: every hub is reachable from some
  // tab, or it is unreachable from the landing page entirely.
  const startable = planner.cities.filter((c) => c.terminusCount > 0);
  const counts = new Map(REGIONS.map((r) => [r.id, 0]));
  let unplaced = 0;
  for (const city of startable) {
    const region = regionForCity(city);
    if (counts.has(region)) counts.set(region, counts.get(region) + 1);
    else unplaced++;
  }
  assert.equal(unplaced, 0, "every start city must belong to a tab");
  assert.equal(
    [...counts.values()].reduce((a, b) => a + b, 0),
    startable.length,
    "the tabs must partition the start cities",
  );
  for (const [id, n] of counts) assert.ok(n > 0, `${id} has no cities to offer`);
  assert.ok(counts.get("europe") > counts.get("asia"), "Europe is the bigger half");
  assert.ok(REGIONS.some((r) => r.id === DEFAULT_REGION), "the default region must exist");
  assert.equal(regionForCountry("at"), "europe", "the lookup is case-insensitive");
  assert.equal(regionForCountry("ZZ"), "", "an unknown country is in no region");
  assert.equal(regionForCountry(""), "");
});

check("the eight placeless hubs get a country rather than falling out of every tab", () => {
  // Their station name is absent from Back-on-Track's stop table under the
  // spelling their routes use, so nothing in the payload can place them —
  // and Feldkirch is one of Europe's busiest hubs by night trains.
  for (const [slug, code] of Object.entries(CITY_COUNTRY_OVERRIDES)) {
    const city = planner.cityBySlug.get(slug);
    if (!city) continue;
    assert.equal(city.country, code, `${slug} should carry ${code}`);
    assert.equal(regionForCity(city), "europe", `${slug} belongs in Europe`);
  }
  assert.equal(planner.cityBySlug.get("feldkirch")?.country, "AT");
  assert.ok(planner.cityBySlug.get("feldkirch")?.routeCount >= 10, "Feldkirch is a real hub");
});

check("the start chips are ranked by the number they print", () => {
  // The whole complaint this answers: the list WAS ranked, by a score mixing
  // weighted reach with terminus reach — so the numbers on the chips read
  // 36, 29, 24, 22, 20, 16, 10, 9, 12, 12, 5 and anyone looking at it concluded
  // it was alphabetical. Sort key and printed value must be one number.
  const compare = byStartCityScore(prominenceLookup(CITY_PROMINENCE, "always"));
  const byRegion = topStartCitiesByRegion(planner.cities, { limit: START_CITY_LIMIT, compare });
  for (const { id, label } of REGIONS) {
    const list = byRegion.get(id);
    assert.ok(list.length > 0, `${label} rendered nothing`);
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i].routeCount <= list[i - 1].routeCount,
        `${label}: ${list[i].name} (${list[i].routeCount}) above ` +
          `${list[i - 1].name} (${list[i - 1].routeCount})`,
      );
    }
    for (const city of list) {
      assert.ok(city.terminusCount > 0, `${city.name} is not a start city`);
      assert.equal(regionForCity(city), id, `${city.name} is in the wrong tab`);
    }
  }
  // The cut is not just "some number of chips": at 24 it landed one slot above
  // Amsterdam and took Brussels, London, Stockholm and Sofia with it, so a list
  // headed "the most night trains" showed Bohumín and Gdynia and not them.
  const europe = byRegion.get("europe").map((c) => c.slug);
  for (const hub of ["amsterdam", "brussels", "london", "stockholm", "sofia", "berlin", "paris"]) {
    assert.ok(europe.includes(hub), `${hub} should be offered as a starting point`);
  }
  // And the tabs must actually separate the three products: ranked together
  // Beijing (40) heads the list, above Vienna (25).
  assert.equal(byRegion.get("europe")[0].slug, "vienna");
  assert.equal(byRegion.get("asia")[0].slug, "beijing");
  assert.equal(byRegion.get("north-america")[0].slug, "chicago");
});

check("a de-emphasised city is pushed behind the tab, never out of it", () => {
  // Damping is a multiplier, and a multiplied score interleaved with undamped
  // ones puts Lviv's 43 between a 7 and a 6 — which is the broken-looking list
  // all over again. Behind them all, both blocks descend on their own count.
  const weightFor = prominenceLookup(CITY_PROMINENCE, "always");
  const compare = byStartCityScore(weightFor);
  const europe = planner.cities
    .filter((c) => c.terminusCount > 0 && regionForCity(c) === "europe")
    .sort(compare);
  const firstDamped = europe.findIndex((c) => isDeEmphasised(c, weightFor));
  assert.ok(
    firstDamped > START_CITY_LIMIT,
    `a de-emphasised city reaches the shown window at ${firstDamped}`,
  );
  for (const slug of ["lviv", "kyiv"]) {
    const at = europe.findIndex((c) => c.slug === slug);
    assert.ok(at >= firstDamped, `${slug} must sit in the de-emphasised block`);
    assert.ok(europe[at].routeCount > europe[0].routeCount, `${slug} keeps its real count`);
  }
  // Only a weight scoped "always" survives into a tab: a continent does not
  // need damping once it has a tab of its own, and damping inside one would
  // break the descending numbers all over again.
  assert.equal(weightFor("UA"), 0.15);
  assert.equal(weightFor("CN"), 1, "China is a tab, not a penalty");
  assert.equal(weightFor("US"), 1);
  assert.equal(weightFor("GE"), 1);
  assert.equal(prominenceLookup(CITY_PROMINENCE, "global")("CN"), 0.1, "still damped globally");
  assert.equal(prominenceLookup(CITY_PROMINENCE)("CN"), 0.1, '"any" takes every entry');
  // startCityScore is the printed number, weighted and nothing else.
  assert.equal(startCityScore({ routeCount: 9, country: "AT" }, weightFor), 9);
  assert.equal(startCityScore({}, weightFor), 0);
  assert.equal(startCityScore({ routeCount: 4 }), 4, "no lookup means no weighting");
});

check("routeCount counts night trains, and survives the wire format", () => {
  // legCount counts LEGS — both directions of one service — so a chip headed
  // "the most night trains" must not print it.
  for (const city of planner.cities) {
    assert.ok(city.routeCount <= city.legCount, `${city.name} has more routes than legs`);
    assert.ok(Number.isInteger(city.routeCount), `${city.name} routeCount is not an integer`);
  }
  const vienna = planner.cityBySlug.get("vienna");
  assert.ok(vienna.routeCount > 0 && vienna.routeCount < vienna.legCount);
  // Straight off the graph, independent of the build.
  const direct = new Set(
    planner.legs
      .filter((l) => l.stops.some((s) => s.citySlug === "vienna"))
      .map((l) => l.routeId),
  );
  assert.equal(vienna.routeCount, direct.size, "routeCount must be distinct routes calling");
  // The city tuple is positional and routeCount was appended, so an index built
  // before it existed still hydrates — with a zero rather than a crash.
  const legacy = packPlanIndex(hydratePlanIndex(index));
  legacy.cities = legacy.cities.map((tuple) => tuple.slice(0, 8));
  const old = hydratePlanIndex(legacy);
  assert.equal(old.cities[0].routeCount, 0);
  assert.ok(old.cities[0].slug);
});

check("a city is measured by where its trains go, not by who terminates there", () => {
  // Przemyśl has 20 terminating night trains and nineteen of them are Ukraine's.
  // It is a Polish city and must not be weighted as a Ukrainian one — but it
  // must not be suggested above Prague either.
  const przemysl = planner.cityBySlug.get("przemysl");
  assert.ok(przemysl);
  assert.equal(przemysl.prominence, 1, "Przemyśl is Polish and keeps full weight");
  assert.ok(
    przemysl.terminusReach < przemysl.terminusCount,
    "its reach must be damped by the network it serves",
  );
  const rank = (slug) =>
    planner.cities
      .filter((c) => c.terminusCount > 0)
      .sort(bySuggestionScore)
      .findIndex((c) => c.slug === slug);
  assert.ok(rank("przemysl") > rank("prague"), "Prague outranks Przemyśl");
  // A city whose trains all go to full-weight places is untouched.
  const vienna = planner.cityBySlug.get("vienna");
  assert.ok(vienna.terminusReach > vienna.terminusCount * 0.9, "Vienna is not damped");
});

check("an unknown or missing country keeps full weight", () => {
  // Eight terminus cities resolve to no country (Helsinki, Inverness, …). The
  // default must be "suggest normally", never "hide".
  const weightFor = prominenceLookup(CITY_PROMINENCE);
  assert.equal(weightFor(""), 1);
  assert.equal(weightFor("ZZ"), 1);
  assert.equal(weightFor("at"), 1);
  assert.equal(weightFor("ua"), 0.15, "lookup is case-insensitive");
  for (const city of planner.cities) {
    if (!city.country) assert.equal(city.prominence, 1, `${city.name} was damped with no country`);
  }
});

check("scoreCities is pure and total over a minimal graph", () => {
  const cities = [
    { slug: "a", name: "A", country: "AT", legCount: 1, terminusCount: 1 },
    { slug: "b", name: "B", country: "UA", legCount: 1, terminusCount: 1 },
  ];
  const legs = [{ stops: [{ citySlug: "a" }, { citySlug: "b" }] }];
  scoreCities(legs, cities, prominenceLookup(CITY_PROMINENCE));
  const [a, b] = cities;
  assert.equal(a.prominence, 1);
  assert.equal(b.prominence, 0.15);
  // A reaches a de-emphasised place, so its reach is damped even at weight 1.
  assert.equal(a.terminusReach, 0.15);
  assert.equal(b.terminusReach, 1);
  assert.ok(suggestionScore(b) < suggestionScore(a) * 2);
  // A leg with fewer than two stops is skipped rather than throwing.
  scoreCities([{ stops: [{ citySlug: "a" }] }, { stops: [] }, {}], cities, () => 1);
  assert.equal(cities[0].reach, 0);
});

check("a ride we can prove is under four hours is not offered", () => {
  // Amsterdam → Utrecht is 26 minutes and Vienna → Wiener Neustadt is 36 — real
  // calls of real night trains, and not what anyone came to a sleeper planner
  // for. 39% of the segments whose duration we know are under the line.
  for (const from of ["amsterdam", "vienna", "brussels", "munich", "zurich"]) {
    const { destinations } = departuresFrom(planner, { from, date: "2026-09-18" });
    for (const d of destinations) {
      assert.ok(
        !isShortHop(d.best.durationMinutes),
        `${from} still offers ${d.city.name} at ${d.best.durationMinutes}m`,
      );
    }
    // And the filter must actually be doing something on these origins.
    const withShort = departuresFrom(planner, {
      from,
      date: "2026-09-18",
      includeShortHops: true,
    });
    assert.ok(
      withShort.destinations.length > destinations.length,
      `${from} lost nothing to the short-hop filter`,
    );
  }
  assert.equal(isShortHop(239), true);
  assert.equal(isShortHop(MIN_TRIP_MINUTES), false);
  // An unknown duration is never hidden — 31% of segments have none.
  assert.equal(isShortHop(null), false);
  assert.equal(isShortHop(undefined), false);
});

check("an explicitly asked-for pair is never told it has no train", () => {
  // European Sleeper really does run Brussels → Amsterdam in about three
  // hours. Someone who typed that pair asked about it; answering "no night
  // train we know of" would be false. The short rides come back, flagged.
  const { rides, onlyShortHops } = ridesBetween(planner, {
    from: "brussels",
    to: "amsterdam",
    date: "2026-09-18",
  });
  assert.ok(rides.length > 0, "Brussels → Amsterdam must still return trains");
  assert.equal(onlyShortHops, true, "and must be flagged as a short-hop-only corridor");
  const plan = resolvePlan(planner, { cities: ["brussels", "amsterdam"], date: "2026-09-18" });
  assert.ok(plan.hops[0].best, "the hop keeps a train");
  assert.equal(plan.hops[0].onlyShortHops, true);
  // A corridor with a real sleeper is not flagged.
  const long = ridesBetween(planner, { from: "amsterdam", to: "prague", date: "2026-09-18" });
  assert.equal(long.onlyShortHops, false);
});

check("a journey never changes trains onto a short hop", () => {
  const journeys = findJourneys(planner, {
    from: "amsterdam",
    to: "vienna",
    date: "2026-09-18",
    maxLegs: 3,
    limit: 8,
  });
  for (const journey of journeys) {
    for (const hop of journey.hops) {
      if (!hop.best || hop.onlyShortHops) continue;
      assert.ok(
        !isShortHop(hop.best.durationMinutes),
        `${journey.cities.join(">")} hops ${hop.best.durationMinutes}m`,
      );
    }
  }
});

check("a journey time longer than a day is not read as a short one", () => {
  // Two endpoint clocks cannot express more than 24h, so durationBetween wraps
  // and the longest trains read as the shortest. UZ 099 Kyiv → București is 23
  // hours and came out as thirteen minutes; the Cardinal's 26h30 as 3h28.
  const uz = planner.legs.find((l) => l.train === "099");
  assert.ok(uz, "UZ 099 should be in the index");
  const whole = segmentOf(uz, 0, uz.stops.length - 1);
  assert.ok(whole.durationMinutes > 1200, `UZ 099 reads ${whole.durationMinutes}m`);
  assert.equal(isShortHop(whole.durationMinutes), false);

  // Where nothing in the data can supply a correct figure, it is withheld
  // rather than guessed — and the ride is still known to cross a night.
  const suspect = planner.legs.filter((l) => l.durationSuspect);
  assert.ok(suspect.length > 20, `only ${suspect.length} legs flagged`);
  for (const leg of suspect) {
    const ride = segmentOf(leg, 0, leg.stops.length - 1);
    assert.equal(ride.durationMinutes, null, `${leg.train} still prints a duration`);
    assert.equal(ride.isOvernight, true, `${leg.train} reads as a day trip`);
    assert.equal(isShortHop(ride.durationMinutes), false);
  }
  const cardinal = planner.legs.find((l) => l.train === "Cardinal");
  assert.ok(cardinal?.durationSuspect, "the Cardinal must be flagged");
});

check("trip.duration is read off the spreadsheet epoch, including past a day", () => {
  assert.equal(tripDurationMinutes({ duration: "1899-12-30T12:47:00.000Z" }), 767);
  assert.equal(tripDurationMinutes({ duration: "1899-12-31T02:26:00.000Z" }), 1586);
  assert.equal(tripDurationMinutes({ duration: "" }), null);
  assert.equal(tripDurationMinutes(null), null);
  assert.equal(tripDurationMinutes({ duration: "1899-12-30T00:00:00.000Z" }), null);
});

check("every leg's stops resolve to a real city in the index", () => {
  const known = new Set(planner.cities.map((c) => c.slug));
  for (const leg of planner.legs) {
    assert.ok(leg.stops.length >= 2, `leg ${leg.id} has ${leg.stops.length} stops`);
    for (const stop of leg.stops) {
      assert.ok(known.has(stop.citySlug), `${stop.station} → unknown city ${stop.citySlug}`);
    }
  }
});

check("adding via-only city mappings moved no live connection slug", () => {
  // The station-cities table is the source of truth for /connections/{a}-to-{b}.
  // The planner needed "Wien Meidling" to mean Vienna, but a station that is an
  // ENDPOINT anywhere owns a live indexed URL, so only via-only stations may be
  // mapped. This pins that rule for the entries that were added.
  const endpoints = new Set();
  for (const route of Object.values(payload.viewMap)) {
    for (const dir of [0, 1]) {
      for (const key of [`origin_trip_${dir}`, `destination_trip_${dir}`]) {
        if (route[key]) endpoints.add(route[key]);
      }
    }
  }
  for (const station of [
    "Wien Meidling", "München Ost", "Warszawa Centralna", "Basel SBB",
    "Praha-Libeň", "Berlin Südkreuz", "Kraków Główny", "Budapest Kelenföld",
  ]) {
    assert.ok(!endpoints.has(station), `${station} is a route endpoint — mapping it moves a URL`);
  }
  assert.equal(cityForStation("Wien Meidling"), "Vienna");
  assert.equal(cityForStation("München Ost"), "Munich");
});

console.log(`\n[verify-plan] ${passed} checks passed`);
