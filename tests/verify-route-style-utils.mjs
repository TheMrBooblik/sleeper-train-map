#!/usr/bin/env node
/**
 * Validates getRouteStyleFromFrequency / inferTripFrequencyRank (no server).
 * Run: node tests/verify-route-style-utils.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const mod = await import(
  path.join(root, "src", "components", "Map", "utils", "routeStyleUtils.js")
);

const {
  getRouteStyleFromFrequency,
  inferTripFrequencyRank,
  hasUnknownStart,
  countListedWeekdays,
  routeHasNotStartedYet,
  routeSeasonHasClosed,
  parseBoTServiceIdDateRange,
  isRouteOutsideServiceIdSeason,
  upcomingPreviewRouteIds,
} = mod;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// All trips daily → solid
const allDaily = {
  t1: {
    route_id: 10,
    service_id: "2026: Daily",
    irregularities: "",
    trip_origin: "A",
    trip_headsign: "B",
  },
  t2: {
    route_id: 10,
    service_id: "2026: Daily",
    irregularities: "",
    trip_origin: "B",
    trip_headsign: "A",
  },
};
let s = getRouteStyleFromFrequency(10, allDaily);
assert(s.dashArray == null && s.weight === 4.5, "all-daily should be solid 4.5");

// One daily + one weekdays → worst wins → dashed
const mixed = {
  t1: {
    route_id: 11,
    service_id: "2026: Daily",
    irregularities: "",
    trip_origin: "A",
    trip_headsign: "B",
  },
  t2: {
    route_id: 11,
    service_id: "2026: Weekdays",
    irregularities: "",
    trip_origin: "A",
    trip_headsign: "B",
  },
};
s = getRouteStyleFromFrequency(11, mixed);
assert(s.dashArray === "10,5", "daily+weekdays should medium-dash");
// Cadence never changes weight — only the dash. See MAP_LEGEND_LINE_BASE_STYLES.
assert(s.weight === 4.5, "daily+weekdays keeps full weight");

// Explicit once per week → rare tier
const onceWeek = {
  t1: {
    route_id: 12,
    service_id: "Once per week",
    irregularities: "",
    trip_origin: "A",
    trip_headsign: "B",
  },
};
s = getRouteStyleFromFrequency(12, onceWeek);
assert(s.dashArray === "8,5" && s.weight === 4.5, "once/week: rare dash, full weight");

// inferTripFrequencyRank export sanity
assert(inferTripFrequencyRank({ service_id: "Daily", irregularities: "" }) === 0, "infer daily");
assert(
  inferTripFrequencyRank({ service_id: "Weekdays", irregularities: "" }) === 1,
  "infer subdaily",
);
assert(
  inferTripFrequencyRank({ service_id: "", irregularities: "Runs twice per week" }) === 2,
  "infer rare from irr",
);

// ─── Weekday lists rank by COUNT, not by which days are named ───────────────
// "Mon, Wed, Fri" and "Tue, Thu, Sun" are the same cadence and must draw the
// same dash; the old keyword heuristics ranked them differently because one
// mentions a weekend day.
assert(countListedWeekdays("2026: Mon, Wed, Fri") === 3, "count 3 listed days");
assert(countListedWeekdays("2026: Tue, Thu, Sun") === 3, "count 3 listed days (weekend)");
assert(countListedWeekdays("2026: Daily") === 0, "Daily is not a weekday list");
assert(countListedWeekdays("2026: Daily, except Sat") === 0, "an exclusion is not a list");
const mwf = { t1: { route_id: 20, service_id: "2026: Mon, Wed, Fri", trip_origin: "A", trip_headsign: "B" } };
const tts = { t1: { route_id: 21, service_id: "2026: Tue, Thu, Sun", trip_origin: "A", trip_headsign: "B" } };
assert(
  getRouteStyleFromFrequency(20, mwf).dashArray ===
    getRouteStyleFromFrequency(21, tts).dashArray,
  "same cadence, same dash regardless of which days",
);

// ─── Synthetic routes have no trips: rank from the row's own service strings ──
const noTrips = getRouteStyleFromFrequency("es_400", {}, {
  service_id_0: "2026/09/09-12/11: Wed, Fri, Sun",
  service_id_1: "2026/09/10-12/10: Mon, Thu, Sat",
});
assert(noTrips.dashArray === "10,5", "no-trips row ranks from service_id_*");
assert(noTrips.weight === 4.5, "no-trips row keeps full weight");
const dailyRow = getRouteStyleFromFrequency("x_1", {}, { service_id_0: "2026: Daily" });
assert(dailyRow.dashArray == null && dailyRow.weight === 4.5, "daily row stays solid");
const bare = getRouteStyleFromFrequency("x_2", {}, {});
assert(bare.dashArray == null && bare.weight === 4.5, "no signal at all → daily default");

// ─── Weight means "is this real yet", nothing else ──────────────────────────
const postponed = {
  t1: { route_id: 239, service_id: "", irregularities: "Postponed to 2027", trip_origin: "A", trip_headsign: "B" },
  t2: { route_id: 239, service_id: "", irregularities: "Postponed to 2027", trip_origin: "B", trip_headsign: "A" },
};
assert(hasUnknownStart(239, postponed), "postponed with no date = unknown start");
assert(getRouteStyleFromFrequency(239, postponed).weight === 2.75, "unknown start draws thin");

// A suspended route ran before and is expected back — not the same thing.
const suspended = {
  t1: { route_id: 11, service_id: "2026: Daily", irregularities: "currently suspended due to construction works", trip_origin: "A", trip_headsign: "B" },
};
assert(!hasUnknownStart(11, suspended), "suspended is not an unknown start");
assert(getRouteStyleFromFrequency(11, suspended).weight === 4.5, "suspended keeps full weight");

// A known opening date is known, however far off.
const announced = {
  t1: { route_id: 240, service_id: "2026: Mon, Thu, Sat", irregularities: "From 2026-09-09", trip_origin: "A", trip_headsign: "B" },
};
assert(!hasUnknownStart(240, announced), "a concrete date is not an unknown start");
assert(getRouteStyleFromFrequency(240, announced).weight === 4.5, "announced route keeps full weight");

// ─── A preview of a period that has not begun contributes no station dots ───
// appendSyntheticRoutes emits the next timetable period as its own row, drawn
// as a preview line on purpose. Its via stations were rendering as ordinary
// green dots, so the same train appeared on two contradictory routings at once.
// shouldHideRouteDueToFutureDate cannot see it: that reads trips, and a
// synthetic row has none — the dates live on the row itself.
const NOW = new Date(2026, 8, 4); // 2026-09-04

const december = {
  route_id: "es_400_from_20261214",
  draw_as_active: true,
  service_id_0: "2026-12-14 – 2027-03-17: Mon, Wed, Fri",
  service_id_1: "2026-12-13 – 2027-03-18: Tue, Thu, Sun",
};
assert(routeHasNotStartedYet(december, NOW), "a December window has not started in September");

// The row this one previews: same train, already selling, slash-formatted.
const running = {
  route_id: "es_400",
  service_id_0: "2026/09/09-12/11: Wed, Fri, Sun",
  service_id_1: "2026/09/10-12/10: Mon, Thu, Sat",
};
assert(routeHasNotStartedYet(running, NOW), "es_400's own window opens five days out");

// ...and that is exactly why the date alone must not decide. Five Amtrak routes
// run today off GTFS feeds that publish only their 2027 season; hiding their
// stations on a future start date would be a regression.
const amtrak = { route_id: "amtrak_Empire_Builder", service_id_0: "2027/04/07-08/30: Daily" };
assert(routeHasNotStartedYet(amtrak, NOW), "the Amtrak window is future by date");
assert(
  upcomingPreviewRouteIds({ a: amtrak, b: running }, NOW).size === 0,
  "a future start date alone never hides a route's stations",
);

// One direction already open is enough: the route is running.
assert(
  !routeHasNotStartedYet(
    { service_id_0: "2026-09-01 – 2026-12-11: Daily", service_id_1: "2026-12-14 – 2027-03-17: Daily" },
    NOW,
  ),
  "a route with one open direction is running",
);

// Anything unreadable must not be called future — most rows look like this.
assert(!routeHasNotStartedYet({ service_id_0: "2026: Daily" }, NOW), "a year-only window is not future");
assert(!routeHasNotStartedYet({ service_id_0: "Daily" }, NOW), "a bare day list is not future");
assert(!routeHasNotStartedYet({}, NOW), "a row with no window is not future");
assert(!routeHasNotStartedYet(null, NOW), "no row is not future");

// A window that has already closed is a past season, not a future one.
assert(
  !routeHasNotStartedYet({ service_id_0: "2026-01-05 – 2026-03-17: Daily" }, NOW),
  "a finished season is not 'not started yet'",
);

// Both conditions together, and only the preview matches.
const ids = upcomingPreviewRouteIds(
  { a: december, b: running, c: amtrak, d: { route_id: "n", service_id_0: "2026: Daily" } },
  NOW,
);
assert(ids.size === 1 && ids.has("es_400_from_20261214"), `only the preview row is pending, got ${[...ids].join(",")}`);

// On sale early but already running: flagged, yet not a pending preview.
assert(
  upcomingPreviewRouteIds({ a: { route_id: "live", draw_as_active: true, service_id_0: "2026-08-01 – 2026-12-11: Daily" } }, NOW).size === 0,
  "draw_as_active on a running route is not a pending preview",
);

// ─── A season that has CLOSED, read off the row ──────────────────────────────
// The trips table is the upstream export and nothing writes to it, so a route
// whose operator feed knows the season ended keeps "2026: Daily" there forever.
// Romania's Constanta-Oradea went on being drawn as a daily service nine days
// after its last run for exactly that reason.

assert(
  routeSeasonHasClosed(
    { service_id_0: "2026/06/13-2026/08/30: Daily", service_id_1: "2026/06/12-2026/08/29: Daily" },
    NOW,
  ),
  "both directions finished means the season has closed",
);
assert(
  !routeSeasonHasClosed(
    { service_id_0: "2026/06/13-2026/08/30: Daily", service_id_1: "2026: Daily" },
    NOW,
  ),
  "a route with one year-round direction is still a route",
);
assert(!routeSeasonHasClosed({ service_id_0: "2026: Daily" }, NOW), "no window means running");
assert(!routeSeasonHasClosed({ service_id_0: "who knows" }, NOW), "an unparseable window means running");
assert(!routeSeasonHasClosed(null, NOW), "no row means running");
assert(
  !routeSeasonHasClosed({ service_id_0: "2026/06/13-2026/12/06: Daily" }, NOW),
  "a window still open is not closed",
);
// The row is consulted before the trips, because only the row is ever corrected.
assert(
  isRouteOutsideServiceIdSeason(
    "r",
    { t: { route_id: "r", service_id: "2026: Daily" } },
    { service_id_0: "2026/06/13-2026/08/30: Daily" },
  ),
  "a corrected row outvotes an export nobody updates",
);

// ─── The short season spelling stays unparseable ON PURPOSE ─────────────────
// 88 service strings in the payload are written "2026/06/22-08/30", and making
// this parser read them hides 17 more routes — among them Amtrak's City of New
// Orleans, a year-round daily train whose row says "2026/09/13-09/16" because
// gtfs-sleeper renders one representative trip's calendar row. Until a route's
// season comes from all of its services, reading that string would be acting on
// data that does not mean what it says.
assert(
  parseBoTServiceIdDateRange("2026/06/22-08/30: Daily") === null,
  "the short spelling must stay unparsed until route-level seasons exist",
);
assert(
  parseBoTServiceIdDateRange("2026/06/26-2026/08/30: Daily") !== null,
  "the spelling with both years is the one that is acted on",
);
assert(
  !routeSeasonHasClosed({ service_id_0: "2026/06/22-08/30: Daily" }, NOW),
  "a short-form window that has passed is still not acted on (Amtrak's four-day rows)",
);

console.log("verify-route-style-utils.mjs OK");
