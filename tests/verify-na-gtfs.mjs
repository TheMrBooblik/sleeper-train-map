// tests/verify-na-gtfs.mjs
// Offline unit test for the generic GTFS sleeper builder (scripts/lib/gtfs.mjs)
// that powers the Amtrak + VIA Rail sources. Runs a committed GTFS fixture
// through loadGtfsDir() + buildSleeperTrains() and asserts allowlist filtering
// (by route name, by endpoint city-pair, and by named oriented pair),
// representative-trip selection, shape vs station-chain geometry, ordered
// stations, calendar rendering, station-name canonicalisation, the
// same-route-name collision guard, and unmatched-allowlist reporting.
// Raw node, no network.
// Run: npm run verify-na-gtfs

import path from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import { loadGtfsDir, buildSleeperTrains } from "../scripts/lib/gtfs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "na-gtfs");

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};
const approx = (a, b) => Math.abs(a - b) < 1e-4;

const gtfs = loadGtfsDir(FIXTURE);

// Allowlist mixes forms: name strings (Amtrak), an endpoint city-pair whose
// ASCII city must match the accented feed station (VIA "The Ocean" via
// Montréal↔Halifax), and a deliberately-unmatched entry. "Pacific Surfliner"
// is omitted so the day route is filtered out.
const stats = {};
const trains = buildSleeperTrains({
  gtfs,
  allowlist: [
    "CALIFORNIA ZEPHYR",
    "Crescent",
    { from: "Montreal", to: "Halifax" },
    "Nonexistent Route",
  ],
  agency: "AMTK",
  operator: "Amtrak",
  stats,
});

const keys = Object.keys(trains).sort();
check(
  keys.length === 3 &&
    keys[0] === "California Zephyr" &&
    keys[1] === "Crescent" &&
    keys[2] === "The Ocean",
  `expected [California Zephyr, Crescent, The Ocean], got [${keys.join(", ")}]`,
);
check(!("Pacific Surfliner" in trains), "Pacific Surfliner (no sleeper) must be filtered out");

const cz = trains["California Zephyr"];
if (!cz) {
  problems.push("California Zephyr missing");
} else {
  check(cz.agency_id === "AMTK", `CZ agency_id: ${cz.agency_id}`);
  check(cz.operator === "Amtrak", `CZ operator: ${cz.operator}`);
  // Representative trip = t1 (3 stops), not t2 (2 stops).
  const names = cz.stations.map((s) => s.name);
  check(
    names.length === 3 &&
      names[0] === "Chicago Union Station" &&
      names[1] === "Omaha" &&
      names[2] === "Emeryville",
    `CZ stations should be Chicago->Omaha->Emeryville, got [${names.join(" -> ")}]`,
  );
  check(
    cz.stations.every(
      (s) => Number.isFinite(s.location.latitude) && Number.isFinite(s.location.longitude),
    ),
    "CZ stations must all carry coordinates",
  );
  check(
    cz.stations.every((s) => s.code),
    "CZ stations must carry GTFS stop codes",
  );
  check(cz.stations[0].code === "CHI", `CZ first stop code: ${cz.stations[0].code}`);
  check(cz.stations[2].code === "EMY", `CZ last stop code: ${cz.stations[2].code}`);
  check(cz.stations[0].departure === "14:00", `CZ first departure: ${cz.stations[0].departure}`);
  // Geometry uses the GTFS shape (sh1: 3 points), not the 2-stop t2.
  const decoded = polyline.decode(cz.polyline);
  check(
    decoded.length === 3 &&
      approx(decoded[0][0], 41.8786) &&
      approx(decoded[1][1], -95.9378) &&
      approx(decoded[2][0], 37.8409),
    `CZ polyline should follow shape sh1 (3 pts), decoded ${decoded.length}`,
  );
  check(cz.frequency === "2026: Daily", `CZ frequency: ${cz.frequency}`);
}

const cr = trains["Crescent"];
if (!cr) {
  problems.push("Crescent missing");
} else {
  // No shape_id on the Crescent trip -> polyline falls back to the station chain.
  const decoded = polyline.decode(cr.polyline);
  check(
    decoded.length === 3 && approx(decoded[0][0], 40.7506) && approx(decoded[2][1], -90.0701),
    `Crescent polyline should fall back to its 3-station chain, decoded ${decoded.length}`,
  );
}

// VIA "The Ocean": matched purely by endpoint pair {Montreal, Halifax} even
// though its route name isn't in the allowlist and the feed station is accented.
const oc = trains["The Ocean"];
if (!oc) {
  problems.push("The Ocean must match by endpoint city-pair (accent-folded)");
} else {
  const names = oc.stations.map((s) => s.name);
  check(
    names[0] === "Montréal Gare Centrale" && names[names.length - 1] === "Halifax",
    `Ocean endpoints should be Montréal->Halifax, got [${names.join(" -> ")}]`,
  );
}

// ─── Named, oriented entries (SNCF) ────────────────────────────────────────
// The fixture's N1/N2 both call themselves "-" with short name "INCONNU", and
// N1 carries both directions, which is the shape SNCF's feed actually has.
const sncfStats = {};
const sncf = buildSleeperTrains({
  gtfs,
  allowlist: [
    { name: "IC Nuit 3731", from: "Paris Austerlitz", to: "Tarbes" },
    { name: "IC Nuit 3740", from: "Tarbes", to: "Paris Austerlitz" },
    { name: "IC Nuit 5789", from: "Paris Austerlitz", to: "Briançon" },
    { name: "IC Nuit 5772", from: "Nice-Ville", to: "Paris Austerlitz" },
    // Never ran: Briançon is the destination, not the origin.
    { name: "IC Nuit 9999", from: "Briançon", to: "Nice-Ville" },
  ],
  agency: "SNCF",
  operator: "SNCF",
  stats: sncfStats,
  canonicalizeName: (n) => (n === "Nice-Ville" ? "Nice Ville" : n),
});

const sncfKeys = Object.keys(sncf).sort();
check(
  sncfKeys.length === 4,
  `expected 4 named SNCF trains, got ${sncfKeys.length}: [${sncfKeys.join(", ")}]`,
);
// The whole point: keyed by the operator's own label, not by route_long_name,
// so the two trains filed under "-" both survive.
check(
  sncfKeys.join("|") === "IC Nuit 3731|IC Nuit 3740|IC Nuit 5772|IC Nuit 5789",
  `SNCF trains should be keyed by their labels, got [${sncfKeys.join(", ")}]`,
);
check(!("-" in sncf), 'no train may be keyed "-"');

// One route_id, two directions, two trains — each with its own stop list.
const out = sncf["IC Nuit 3731"];
const back = sncf["IC Nuit 3740"];
if (!out || !back) {
  problems.push("both directions of N1 must resolve");
} else {
  // n1d is a FULLER Paris->Tarbes trip (4 stops) but runs 08:27→15:32 the same
  // day, and a sleeper allowlist must not take it — SNCF's fullest Paris
  // Austerlitz → Toulouse trip is the daytime Intercités via Limoges, and
  // taking it would have rewritten the night train's corridor.
  check(
    out.stations.map((s) => s.name).join(" -> ") ===
      "Paris Austerlitz -> Toulouse Matabiau -> Tarbes",
    `3731 should take the overnight trip, not the fuller day one, got [${out.stations.map((s) => s.name).join(" -> ")}]`,
  );
  check(
    out.stations[0].departure === "22:11",
    `3731 must depart in the evening, got ${out.stations[0].departure}`,
  );
  // n1c (4 stops) beats n1b (2 stops) within the Tarbes->Paris orientation.
  check(
    back.stations.map((s) => s.name).join(" -> ") ===
      "Tarbes -> Lourdes -> Toulouse Matabiau -> Paris Austerlitz",
    `3740 should take the fullest reverse trip, got [${back.stations.map((s) => s.name).join(" -> ")}]`,
  );
  check(
    back.stations[0].departure === "19:00",
    `each direction keeps its own times, got ${back.stations[0].departure} back`,
  );
  check(out.agency_id === "SNCF" && out.operator === "SNCF", "SNCF stamps carry through");
}

// Orientation is not a suggestion: a pair that runs the other way is unmatched.
check(
  sncfStats.unmatched.length === 1 &&
    sncfStats.unmatched[0].startsWith("IC Nuit 9999"),
  `only the reversed entry should be unmatched, got [${(sncfStats.unmatched || []).join(", ")}]`,
);

// canonicalizeName runs on emitted stops, so a via name can still find the
// coordinate-bearing station the rest of the payload knows.
const nice = sncf["IC Nuit 5772"];
check(
  nice?.stations?.[0]?.name === "Nice Ville",
  `feed's "Nice-Ville" should be canonicalised, got ${nice?.stations?.[0]?.name}`,
);

// Two route_ids sharing route_long_name must not collapse onto one key. Taken
// through the unnamed pair form, which is where the collision used to bite:
// both N1 and N2 come out called "-", and the second write silently won.
const dashed = buildSleeperTrains({
  gtfs,
  allowlist: [
    { from: "Paris Austerlitz", to: "Tarbes" },
    { from: "Paris Austerlitz", to: "Briançon" },
  ],
  agency: "SNCF",
  operator: "SNCF",
});
const dashedKeys = Object.keys(dashed);
check(
  dashedKeys.length === 2,
  `both routes named "-" must survive, got ${dashedKeys.length}: [${dashedKeys.join(", ")}]`,
);
check(
  dashedKeys.filter((k) => k === "-").length === 1 &&
    dashedKeys.some((k) => k !== "-"),
  `the second "-" route needs a distinct key, got [${dashedKeys.join(", ")}]`,
);
check(
  new Set(dashedKeys.map((k) => dashed[k].stations.length)).size === 2,
  "the two \"-\" routes must keep their own stop lists",
);

// Freshness safety net: the unmatched entry is reported, matched ones are not.
check(
  stats.unmatched.length === 1 && stats.unmatched[0] === "Nonexistent Route",
  `stats.unmatched should be [Nonexistent Route], got [${(stats.unmatched || []).join(", ")}]`,
);
check(
  stats.matched.includes("Montreal – Halifax"),
  `stats.matched should include the endpoint pair, got [${(stats.matched || []).join(", ")}]`,
);

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-na-gtfs: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `verify-na-gtfs: OK — ${keys.length} sleeper routes built by name/endpoint pair, ` +
    `${sncfKeys.length} by named oriented pair`,
);
