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
import {
  MAX_SHAPES_BYTES,
  headersFor,
  loadGtfsDir,
  buildSleeperTrains,
} from "../scripts/lib/gtfs.mjs";

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

// ─── Oversized shapes.txt is skipped, not fatal ────────────────────────────
// Entur ships 416 MB of shapes for Vy against 7.6 MB of stop_times, and readCsv
// reads a whole file into one string: that OOM'd the probe. Geometry is the
// optional part, so it gets dropped and the feed stays usable.
const skipped = loadGtfsDir(FIXTURE, { maxShapesBytes: 1 });
check(skipped.shapesSkipped === true, "a shapes.txt past the ceiling must report itself skipped");
check(skipped.shapePoints.size === 0, "skipped shapes must leave no points behind");
check(
  skipped.trips.length === gtfs.trips.length && skipped.stopTimesByTrip.size === gtfs.stopTimesByTrip.size,
  "skipping shapes must not cost a single trip or stop time",
);
const chained = buildSleeperTrains({
  gtfs: skipped,
  allowlist: ["CALIFORNIA ZEPHYR"],
  agency: "AMTK",
  operator: "Amtrak",
});
// The CZ has a shape (sh1, 3 points) AND a 3-station chain; with shapes gone it
// must fall back to the chain rather than emit nothing.
const czChain = polyline.decode(chained["California Zephyr"].polyline);
check(
  czChain.length === 3 && approx(czChain[0][0], 41.8786) && approx(czChain[1][1], -95.9378),
  `without shapes the CZ should fall back to its station chain, got ${czChain.length} pts`,
);
check(
  gtfs.shapesSkipped === false && gtfs.shapesBytes > 0,
  "the fixture's own shapes.txt must still be read at the default ceiling",
);
check(
  MAX_SHAPES_BYTES > 17e6 && MAX_SHAPES_BYTES < 416e6,
  `the default ceiling must clear Amtrak's 17 MB and stop Entur's 416 MB, got ${MAX_SHAPES_BYTES}`,
);

// ─── Per-host request headers ──────────────────────────────────────────────
// The safety argument for touching the shared downloader is that no working
// feed changes, so that is the assertion: a host with no entry is fetched with
// exactly the headers it was before, which is none.
for (const url of [
  "https://content.amtrak.com/content/gtfs/GTFS.zip",
  "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip",
  "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip",
]) {
  check(
    Object.keys(headersFor(url)).length === 0,
    `${new URL(url).hostname} must still be fetched with no headers`,
  );
}
const vr = headersFor("https://rata.digitraffic.fi/api/v1/trains/gtfs-passenger-stops.zip");
check(
  vr["Digitraffic-User"] && /zip/.test(vr.Accept ?? ""),
  `digitraffic should get an identifying user and an Accept, got ${JSON.stringify(vr)}`,
);
check(
  headersFor("https://rata.digitraffic.fi/x.zip", { Accept: "text/plain" }).Accept === "text/plain",
  "a caller's own header should win over the host default",
);
check(
  Object.keys(headersFor("not a url")).length === 0,
  "a malformed URL must not throw on the way to https.get",
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

// ── A date-expanded feed: one trip per operating date ──────────────────────
// SNCF's export is this shape, and reading service days off the single trip
// the entry resolves to was visibly incoherent in the first live run: IC Nuit
// 3740 came out "Mon, Tue, Wed, Thu, Fri" while IC Nuit 3731 — the other
// direction of the same service — came out "Sun". Both cannot be the train's
// timetable; each was one run's own date.
{
  const stopsById = new Map([
    ["PAR", { name: "Paris Austerlitz", lat: 48.8423, lon: 2.3649, parent: "" }],
    ["TAR", { name: "Tarbes", lat: 43.2333, lon: 0.0667, parent: "" }],
    ["LOU", { name: "Lourdes", lat: 43.0995, lon: -0.0453, parent: "" }],
  ]);
  // Four operating dates in Sep 2026: Thu 17th, Fri 18th, Sat 19th, Sun 20th.
  const dates = ["20260917", "20260918", "20260919", "20260920"];
  const trips = dates.map((d, i) => ({
    route_id: "ICN",
    service_id: `SVC_${d}`,
    trip_id: `t_${d}`,
    trip_short_name: "3740",
    direction_id: "0",
    shape_id: "",
  }));
  const stopTimesByTrip = new Map(
    trips.map((t, i) => [
      t.trip_id,
      [
        { seq: 1, stop_id: "PAR", arrival: "", departure: "19:00:00" },
        // The 19th's run calls at one extra stop, so it is the "fullest" trip
        // and supplies the stop list — while every run supplies a day.
        ...(i === 2 ? [{ seq: 2, stop_id: "LOU", arrival: "23:30:00", departure: "23:32:00" }] : []),
        { seq: 9, stop_id: "TAR", arrival: "07:03:00", departure: "" },
      ],
    ]),
  );
  const dateExpanded = {
    routesById: new Map([["ICN", { route_id: "ICN", route_long_name: "-", route_short_name: "INCONNU" }]]),
    stopsById,
    shapePoints: new Map(),
    trips,
    stopTimesByTrip,
    calendarById: new Map(),
    addedDatesByService: new Map(dates.map((d) => [`SVC_${d}`, [d]])),
    shapesSkipped: false,
    shapesBytes: 0,
  };

  const built = buildSleeperTrains({
    gtfs: dateExpanded,
    allowlist: [{ from: "Paris Austerlitz", to: "Tarbes", name: "IC Nuit 3740" }],
    agency: "SNCF",
    operator: "SNCF",
  });
  const train = built["IC Nuit 3740"];
  check(!!train, "date-expanded: the named entry resolved");
  if (train) {
    // Without the union this reads "Sat" — whichever single run won the stop
    // count — rather than the four days the train actually runs.
    check(
      train.frequency === "Thu, Fri, Sat, Sun",
      `date-expanded: service days union every matching run, got ${JSON.stringify(train.frequency)}`,
    );
    check(
      train.stations.length === 3,
      `date-expanded: the fullest run still supplies the stop list, got ${train.stations.length}`,
    );
  }

  // Seven days of runs must read "Daily", not a seven-item list.
  const week = ["20260914", "20260915", "20260916", "20260917", "20260918", "20260919", "20260920"];
  const weekTrips = week.map((d) => ({
    route_id: "ICN", service_id: `W_${d}`, trip_id: `w_${d}`,
    trip_short_name: "3740", direction_id: "0", shape_id: "",
  }));
  const daily = buildSleeperTrains({
    gtfs: {
      ...dateExpanded,
      trips: weekTrips,
      stopTimesByTrip: new Map(weekTrips.map((t) => [t.trip_id, [
        { seq: 1, stop_id: "PAR", arrival: "", departure: "19:00:00" },
        { seq: 2, stop_id: "TAR", arrival: "07:03:00", departure: "" },
      ]])),
      addedDatesByService: new Map(week.map((d) => [`W_${d}`, [d]])),
    },
    allowlist: [{ from: "Paris Austerlitz", to: "Tarbes", name: "IC Nuit 3740" }],
    agency: "SNCF",
    operator: "SNCF",
  });
  check(
    daily["IC Nuit 3740"]?.frequency === "Daily",
    `date-expanded: seven weekdays read "Daily", got ${JSON.stringify(daily["IC Nuit 3740"]?.frequency)}`,
  );
}

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-na-gtfs: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `verify-na-gtfs: OK — ${keys.length} sleeper routes built by name/endpoint pair, ` +
    `${sncfKeys.length} by named oriented pair`,
);
