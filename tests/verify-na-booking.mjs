// tests/verify-na-booking.mjs
// Unit tests for North American booking URL builder (Amtrak / VIA Rail).
// Run: npm run verify-na-booking

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStationCode,
  getRoutePageUrl,
  buildNorthAmericaBookingUrl,
  isNorthAmericaAgency,
} from "../src/lib/naBooking.mjs";
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const AMTRAK_ROUTE_IDS = [
  "amtrak_Auto_Train",
  "amtrak_California_Zephyr",
  "amtrak_Capitol_Limited",
  "amtrak_Cardinal",
  "amtrak_City_of_New_Orleans",
  "amtrak_Coast_Starlight",
  "amtrak_Crescent",
  "amtrak_Empire_Builder",
  "amtrak_Floridian",
  "amtrak_Lake_Shore_Limited",
  "amtrak_Silver_Meteor",
  "amtrak_Silver_Star",
  "amtrak_Southwest_Chief",
  "amtrak_Sunset_Limited",
  "amtrak_Texas_Eagle",
];

const VIA_ROUTE_IDS = [
  "via_Vancouver_-_Toronto",
  "via_Montréal_-_Halifax",
  "via_Winnipeg_-_Churchill",
];

check(isNorthAmericaAgency("AMTK"), "AMTK is NA agency");
check(isNorthAmericaAgency("VIA"), "VIA is NA agency");
check(!isNorthAmericaAgency("ÖBB"), "ÖBB is not NA agency");

const stops = [
  { name: "Chicago Union Station", code: "CHI" },
  { name: "Emeryville", code: "EMY" },
];

check(
  resolveStationCode(stops, "Chicago Union Station") === "CHI",
  "resolveStationCode exact match",
);
check(
  resolveStationCode(stops, "Unknown") === null,
  "resolveStationCode unknown returns null",
);

const amtrakDeep = buildNorthAmericaBookingUrl({
  agencyId: "AMTK",
  routeId: "amtrak_California_Zephyr",
  origin: "Chicago Union Station",
  dest: "Emeryville",
  scheduleStops: stops,
});
check(amtrakDeep.isStationDeepLink, "Amtrak uses station deep link when codes resolve");
check(
  amtrakDeep.url?.includes("origin=CHI") && amtrakDeep.url?.includes("destination=EMY"),
  `Amtrak deep link has codes, got ${amtrakDeep.url}`,
);

const amtrakRouteFallback = buildNorthAmericaBookingUrl({
  agencyId: "AMTK",
  routeId: "amtrak_California_Zephyr",
  origin: "Chicago Union Station",
  dest: "Emeryville",
  scheduleStops: [],
});
check(
  !amtrakRouteFallback.isStationDeepLink,
  "Amtrak without codes is not a station deep link",
);
check(
  amtrakRouteFallback.url === OPERATOR_BOOKING.AMTK.routePages.amtrak_California_Zephyr,
  `Amtrak falls back to route page, got ${amtrakRouteFallback.url}`,
);

const viaOcean = buildNorthAmericaBookingUrl({
  agencyId: "VIA",
  routeId: "via_Montréal_-_Halifax",
  origin: "Montréal Gare Centrale",
  dest: "Halifax",
  scheduleStops: [
    { name: "Montréal Gare Centrale", code: "MTL" },
    { name: "Halifax", code: "HFX" },
  ],
});
check(
  viaOcean.url === OPERATOR_BOOKING.VIA.routePages["via_Montréal_-_Halifax"],
  "VIA uses route page (not reservia deep link)",
);
check(!viaOcean.isStationDeepLink, "VIA link is not a station deep link");

const unknownRoute = buildNorthAmericaBookingUrl({
  agencyId: "VIA",
  routeId: "via_unknown",
  origin: "A",
  dest: "B",
  scheduleStops: [],
});
check(
  unknownRoute.url === OPERATOR_BOOKING.VIA.bookingPageUrl,
  "unknown VIA route falls back to bookingPageUrl",
);

for (const routeId of AMTRAK_ROUTE_IDS) {
  check(
    getRoutePageUrl("AMTK", routeId),
    `missing Amtrak routePages entry for ${routeId}`,
  );
}
for (const routeId of VIA_ROUTE_IDS) {
  check(
    getRoutePageUrl("VIA", routeId),
    `missing VIA routePages entry for ${routeId}`,
  );
}

// Published viewMap should not have NA routes outside our curated set.
const initialDataPath = path.join(
  __dirname,
  "../public/data/published/initial-data.json",
);
if (fs.existsSync(initialDataPath)) {
  const published = JSON.parse(fs.readFileSync(initialDataPath, "utf8"));
  const viewMap = published?.data?.viewMap || {};
  const publishedNa = Object.keys(viewMap).filter(
    (k) => k.startsWith("amtrak_") || k.startsWith("via_"),
  );
  const configured = new Set([...AMTRAK_ROUTE_IDS, ...VIA_ROUTE_IDS]);
  for (const routeId of publishedNa) {
    check(configured.has(routeId), `published NA route ${routeId} has no routePage`);
  }
}

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-na-booking: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `verify-na-booking: OK — ${AMTRAK_ROUTE_IDS.length + VIA_ROUTE_IDS.length} route pages configured`,
);
