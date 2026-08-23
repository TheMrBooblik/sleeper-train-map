// tests/verify-european-sleeper.mjs
// Unit tests for src/lib/europeanSleeper.mjs — which trip may read the European
// Sleeper feed, and which of its two timetable periods it reads.
//
// The feed is keyed by BARE train number ("400", "452", "474"), the shape
// Back-on-Track's trip_short_name comes in. A bare number is only unique WITHIN
// an operator: Back-on-Track carries a CFM/CFR 401 (Chişinău–București) and an
// SJN 475 (Trondheim–Bodø) next to European Sleeper's ES 401/475. Looking the
// feed up by number alone dressed those two trains in European Sleeper's stops,
// endpoints, duration and service days — the render-side twin of the hazard
// `synthetic.botMatchAgencies` guards on the scrape side.
//
// Raw node, no network. Run: npm run verify-european-sleeper
import assert from "node:assert";
import {
  esScheduleForTrip,
  isEuropeanSleeperRoute,
  isEuropeanSleeperTrip,
  isUpcomingTimetableRoute,
} from "../src/lib/europeanSleeper.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const sched = (id) => ({ tripId: id, stops: [{ name: `${id}-a` }, { name: `${id}-b` }] });
const maps = {
  current: new Map([
    ["401", sched("es401-current")],
    ["475", sched("es475-current")],
  ]),
  upcoming: new Map([
    ["401", sched("es401-december")],
    ["475", sched("es475-december")],
  ]),
};

check("an enriched Back-on-Track row gets the feed through its agency", () => {
  // Routes 237/238 keep Back-on-Track's numeric ids and carry ES on the trip,
  // so they never reach the synthetic path — the agency is what identifies them.
  const trip = { route_id: "238", agency_id: "ES", trip_short_name: "475" };
  assert.strictEqual(esScheduleForTrip(trip, maps, "475").tripId, "es475-current");
});

check("a synthetic es_ row gets the feed through its route id", () => {
  const trip = { route_id: "es_400", trip_short_name: "401" };
  assert.strictEqual(esScheduleForTrip(trip, maps, "401").tripId, "es401-current");
});

check("another operator's train with the same bare number gets nothing", () => {
  // The two collisions in the published payload today.
  const cfr = { route_id: "22", agency_id: "CFM/CFR", trip_short_name: "401" };
  const sjn = { route_id: "71", agency_id: "SJN", trip_short_name: "475" };
  assert.strictEqual(esScheduleForTrip(cfr, maps, "401"), null);
  assert.strictEqual(esScheduleForTrip(sjn, maps, "475"), null);
});

check("the December row reads the upcoming period, not the current one", () => {
  // es_400 and es_400_from_20261214 render the same train numbers but are
  // different journeys — September leaves Milan via Aachen, December via
  // Eindhoven — so each has to read its own period.
  const now = { route_id: "es_400", trip_short_name: "401" };
  const later = { route_id: "es_400_from_20261214", trip_short_name: "401" };
  assert.strictEqual(esScheduleForTrip(now, maps, "401").tripId, "es401-current");
  assert.strictEqual(esScheduleForTrip(later, maps, "401").tripId, "es401-december");
});

check("a European Sleeper train the feed does not carry gets nothing", () => {
  // ES 454/455 are postponed and absent from the feed; the card keeps
  // Back-on-Track's values rather than borrowing another train's.
  const trip = { route_id: "239", agency_id: "ES", trip_short_name: "454" };
  assert.strictEqual(esScheduleForTrip(trip, maps, "454"), null);
});

check("the agency check is case- and whitespace-insensitive", () => {
  assert.ok(isEuropeanSleeperTrip({ agency_id: " es " }));
  assert.ok(isEuropeanSleeperTrip({ agency_id: "ES" }));
  assert.ok(!isEuropeanSleeperTrip({ agency_id: "ESK" }));
  assert.ok(!isEuropeanSleeperTrip({ agency_id: "" }));
  assert.ok(!isEuropeanSleeperTrip({}));
  assert.ok(!isEuropeanSleeperTrip(null));
});

check("route-id predicates key off the prefixes build-initial-data writes", () => {
  assert.ok(isEuropeanSleeperRoute("es_400"));
  assert.ok(isEuropeanSleeperRoute("es_400_from_20261214"));
  assert.ok(!isEuropeanSleeperRoute("238"));
  assert.ok(!isEuropeanSleeperRoute("estonia_1"));
  assert.ok(isUpcomingTimetableRoute("es_400_from_20261214"));
  assert.ok(!isUpcomingTimetableRoute("es_400"));
  assert.ok(!isUpcomingTimetableRoute(null));
});

check("missing maps are handled, not thrown on", () => {
  const trip = { route_id: "es_400", trip_short_name: "401" };
  assert.strictEqual(esScheduleForTrip(trip, undefined, "401"), null);
  assert.strictEqual(esScheduleForTrip(trip, {}, "401"), null);
  assert.strictEqual(esScheduleForTrip(trip, maps, undefined), null);
});

console.log(`\n[verify-european-sleeper] ${passed} checks passed`);
