// tests/verify-booking.mjs
// Unit tests for the ÖBB connection deep-link builder (buildConnectionBookingUrl).
// Run: npm run verify-booking

import {
  buildConnectionBookingUrl,
  buildBookingUrl,
} from "../src/lib/operatorBooking.js";
import OPERATOR_BOOKING from "../data/overrides/operator-booking.json" with { type: "json" };

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// --- Config sanity -----------------------------------------------------------

check(
  typeof OPERATOR_BOOKING["ÖBB"]?.connectionUrlTemplate === "string",
  "ÖBB entry has a connectionUrlTemplate",
);
check(
  OPERATOR_BOOKING["ÖBB"]?.connectionUrlTemplate?.includes("/en/ticket"),
  "connectionUrlTemplate uses the /en/ path",
);
check(
  OPERATOR_BOOKING["ÖBB"]?.connectionUrlTemplate?.includes("cref=pingwi"),
  "connectionUrlTemplate preserves the cref affiliate ref",
);

// --- Fixture: Wien Hbf -> Bregenz (from the user's known-good example) --------
// Stored times are true UTC; Europe/Vienna is CEST (+2) in July, so
// 20:44Z -> 22:44 local and 06:57Z -> 08:57 local — matching the example URL.
const wienBregenz = [
  {
    id: "8103000",
    name: "Wien Hbf",
    arrival: "2026-07-15T20:44:00.000Z",
    departure: "2026-07-15T20:44:00.000Z",
  },
  {
    id: "8100122",
    name: "Dornbirn Bahnhof",
    arrival: "2026-07-16T06:50:00.000Z",
    departure: "2026-07-16T06:51:00.000Z",
  },
  {
    id: "8100090",
    name: "Bregenz Bahnhof",
    arrival: "2026-07-16T06:57:00.000Z",
    departure: "2026-07-16T06:57:00.000Z",
  },
];

const summer = buildConnectionBookingUrl({
  agencyId: "ÖBB",
  stations: wienBregenz,
  origin: "Wien Hbf",
  dest: "Bregenz Bahnhof",
});
check(!!summer, "summer: builds a connection deep link");
check(
  summer?.includes("connectionOrigEva=8103000"),
  `summer: connectionOrigEva, got ${summer}`,
);
check(
  summer?.includes("connectionDestEva=8100090"),
  `summer: connectionDestEva, got ${summer}`,
);
check(
  summer?.includes("connectionDatetimeDeparture=2026-07-15T22:44"),
  `summer: local departure 22:44 (CEST), got ${summer}`,
);
check(
  summer?.includes("connectionDatetimeArrival=2026-07-16T08:57"),
  `summer: local arrival 08:57 (CEST), got ${summer}`,
);
// station*Eva reuses the EVA codes.
check(
  summer?.includes("stationOrigEva=8103000") &&
    summer?.includes("stationDestEva=8100090"),
  `summer: station*Eva reuse EVA codes, got ${summer}`,
);

// --- DST awareness: a January connection is CET (+1), not CEST ---------------
const winter = buildConnectionBookingUrl({
  agencyId: "ÖBB",
  stations: [
    {
      id: "8103000",
      name: "Wien Hbf",
      departure: "2026-01-15T21:44:00.000Z",
      arrival: "2026-01-15T21:44:00.000Z",
    },
    {
      id: "8100090",
      name: "Bregenz Bahnhof",
      arrival: "2026-01-16T05:57:00.000Z",
      departure: "2026-01-16T05:57:00.000Z",
    },
  ],
  origin: "Wien Hbf",
  dest: "Bregenz Bahnhof",
});
check(
  winter?.includes("connectionDatetimeDeparture=2026-01-15T22:44"),
  `winter: local departure 22:44 (CET +1), got ${winter}`,
);
check(
  winter?.includes("connectionDatetimeArrival=2026-01-16T06:57"),
  `winter: local arrival 06:57 (CET +1), got ${winter}`,
);

// --- Intermediate origin: match the clicked stop, not the endpoint -----------
const fromMid = buildConnectionBookingUrl({
  agencyId: "ÖBB",
  stations: wienBregenz,
  origin: "Dornbirn Bahnhof",
  dest: "Bregenz Bahnhof",
});
check(
  fromMid?.includes("connectionOrigEva=8100122"),
  `intermediate: origin EVA is the matched mid stop, got ${fromMid}`,
);

// --- Fallbacks (return null so the caller uses the name-based link) ----------
check(
  buildConnectionBookingUrl({
    agencyId: "ÖBB",
    stations: [],
    origin: "Wien Hbf",
    dest: "Bregenz Bahnhof",
  }) === null,
  "empty stations -> null",
);
check(
  buildConnectionBookingUrl({
    agencyId: "ÖBB",
    stations: [
      { id: null, name: "Wien Hbf", departure: "2026-07-15T20:44:00.000Z" },
      { id: "8100090", name: "Bregenz Bahnhof", arrival: "2026-07-16T06:57:00.000Z" },
    ],
    origin: "Wien Hbf",
    dest: "Bregenz Bahnhof",
  }) === null,
  "endpoint without a numeric EVA -> null",
);
check(
  buildConnectionBookingUrl({
    agencyId: "VR",
    stations: wienBregenz,
    origin: "Wien Hbf",
    dest: "Bregenz Bahnhof",
  }) === null,
  "operator without a connectionUrlTemplate -> null",
);

// Sanity: the name-based fallback link is unaffected by the new field.
const nameLink = buildBookingUrl({
  agencyId: "ÖBB",
  origin: "Amsterdam Centraal",
  dest: "Basel SBB",
});
check(
  nameLink?.includes("stationOrigName=Amsterdam") &&
    nameLink?.includes("stationDestName=Basel"),
  `name-based fallback still maps station names, got ${nameLink}`,
);

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-booking: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log("verify-booking: OK — ÖBB connection deep link builds & falls back");
