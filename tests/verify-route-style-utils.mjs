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

const { getRouteStyleFromFrequency, inferTripFrequencyRank } = mod;

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
assert(s.weight === 4.2, "daily+weekdays weight 4.2");

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
assert(s.dashArray === "8,5" && s.weight === 2.75, "once/week should rare style");

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

console.log("verify-route-style-utils.mjs OK");
