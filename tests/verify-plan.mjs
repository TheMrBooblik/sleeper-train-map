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
import { buildLegs, isOvernightRide, segmentOf, toMinutes } from "../src/lib/plan/legs.mjs";
import {
  createPlanner,
  departuresFrom,
  findJourneys,
  isInterchange,
  resolvePlan,
} from "../src/lib/plan/search.mjs";
import { hydratePlanIndex, packPlanIndex } from "../src/lib/plan/index-codec.mjs";
import { formatPlanDate } from "../src/lib/plan/format.mjs";
import { slugify } from "../src/lib/seo/slugify.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";
import { buildPlanIndex, readPublished } from "../scripts/build-plan-index.mjs";
import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";
import DISABLED_ROUTES from "../data/overrides/disabled-routes.json" with { type: "json" };

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

  // Boarding mid-route: no published departure, so no invented one.
  const mid = segmentOf(leg, 1, 2);
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
