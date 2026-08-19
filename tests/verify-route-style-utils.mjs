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

console.log("verify-route-style-utils.mjs OK");
