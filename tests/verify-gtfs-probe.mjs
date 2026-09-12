// tests/verify-gtfs-probe.mjs
// The overnight-detection heuristic behind scripts/probe-gtfs.mjs, which is what
// turns a GTFS feed into a draft sleeper allowlist. No network.
// Run: npm run verify-gtfs-probe
//
// Worth pinning because the load-bearing part is GTFS's past-midnight notation:
// a train arriving at 03:31 the next day is written "27:31:00", so a naive
// arrival < departure check sees a negative duration and drops the very trains
// this exists to find.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENING_FROM_SECONDS,
  allowlistVerifiableSources,
  daysOf,
  isOvernightCandidate,
  reportAllowlist,
  selectRouteRuns,
  toSeconds,
} from "../scripts/probe-gtfs.mjs";
import { loadGtfsDir } from "../scripts/lib/gtfs.mjs";
import { loadRegistry } from "../scripts/lib/registry.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("toSeconds reads GTFS times, past midnight included", () => {
  assert.strictEqual(toSeconds("00:00:00"), 0);
  assert.strictEqual(toSeconds("20:52:00"), 75120);
  // The whole point: hour 27 is 03:00 the next day, not an error.
  assert.strictEqual(toSeconds("27:31:00"), 99060);
  assert.strictEqual(toSeconds("7:05:00"), 25500, "single-digit hours occur in the wild");
});

check("toSeconds rejects what it cannot read rather than guessing", () => {
  for (const bad of ["", null, undefined, "abc", "12:60", "12-30-00", 1234]) {
    assert.strictEqual(toSeconds(bad), null, `${JSON.stringify(bad)} should be null`);
  }
});

check("an arrival past midnight is a night train, however short", () => {
  // Paris 20:52 → Nice 03:31+1.
  assert.ok(isOvernightCandidate({ dep: toSeconds("20:52:00"), arr: toSeconds("27:31:00") }));
  // Even a short hop that crosses midnight counts: the feed said +1 itself.
  assert.ok(isOvernightCandidate({ dep: toSeconds("23:40:00"), arr: toSeconds("24:20:00") }));
});

check("a long evening run counts too, for feeds that reset at midnight", () => {
  // 21:00 → 06:00 written without the +1: arrival LOOKS earlier than departure.
  assert.ok(isOvernightCandidate({ dep: toSeconds("21:00:00"), arr: toSeconds("30:00:00") }));
  assert.ok(
    isOvernightCandidate({ dep: toSeconds("18:00:00"), arr: toSeconds("23:30:00") }),
    "5h30 leaving at 18:00 is the fallback case",
  );
});

check("daytime long-distance services are not night trains", () => {
  // The decoy the heuristic exists to reject: a fast morning TGV.
  assert.strictEqual(isOvernightCandidate({ dep: toSeconds("08:00:00"), arr: toSeconds("10:05:00") }), false);
  // Long, but leaves in the morning — a daytime express, not a sleeper.
  assert.strictEqual(isOvernightCandidate({ dep: toSeconds("07:00:00"), arr: toSeconds("15:00:00") }), false);
  // Leaves late but arrives soon: a last evening commuter run.
  assert.strictEqual(isOvernightCandidate({ dep: toSeconds("22:00:00"), arr: toSeconds("23:00:00") }), false);
});

check("thresholds are honoured and the default is a sane hour", () => {
  const run = { dep: toSeconds("19:00:00"), arr: toSeconds("23:00:00") }; // 4h
  assert.strictEqual(isOvernightCandidate(run), false, "4h is below the 5h default");
  assert.ok(isOvernightCandidate(run, { minHours: 4 }), "…and above an explicit 4h");
  assert.ok(
    EVENING_FROM_SECONDS >= 12 * 3600 && EVENING_FROM_SECONDS < 22 * 3600,
    `evening cutoff ${EVENING_FROM_SECONDS}s is not a plausible hour`,
  );
});

check("unreadable times are never a candidate", () => {
  assert.strictEqual(isOvernightCandidate({ dep: null, arr: 99060 }), false);
  assert.strictEqual(isOvernightCandidate({ dep: 75120, arr: null }), false);
  assert.strictEqual(isOvernightCandidate({}), false);
});

check("daysOf renders a calendar row, collapsing a full week", () => {
  const week = (...on) =>
    Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d, i) => [
        d,
        on.includes(i) ? "1" : "0",
      ]),
    );
  assert.strictEqual(daysOf(week(0, 1, 2, 3, 4, 5, 6)), "daily");
  assert.strictEqual(daysOf(week(0, 2, 4)), "MoWeFr");
  assert.strictEqual(daysOf(week()), "");
  assert.strictEqual(daysOf(null), "", "a calendar_dates-only feed has no row here");
});

// ─── The probe must choose the trip the ADAPTER will choose ────────────────
// gtfs-sleeper matches allowlists against representativeTrip(), which takes the
// trip with the MOST STATIONS. This probe first took the longest by DURATION —
// a different trip on any route grouping several services, and SNCF groups
// plenty. Since the endpoints printed here become {from,to} allowlist entries,
// disagreeing with the adapter yields a config that silently matches nothing.
{
  const st = (...times) =>
    times.map((t, i) => ({ seq: i + 1, stop_id: `S${i}`, arrival: t, departure: t }));

  // One route, two trips: a 3-stop night run and a 6-stop daytime working.
  const trips = [
    { trip_id: "night", route_id: "R1" },
    { trip_id: "day", route_id: "R1" },
  ];
  const stopTimes = new Map([
    ["night", st("20:52:00", "25:40:00", "27:31:00")],
    ["day", st("08:00:00", "09:00:00", "10:00:00", "11:00:00", "12:00:00", "13:00:00")],
  ]);

  const runs = selectRouteRuns(trips, stopTimes);
  check("picks the fullest trip, as representativeTrip() does", () => {
    assert.strictEqual(
      runs.get("R1").trip.trip_id,
      "day",
      "the 6-stop trip must win over the 3-stop one, however much longer that one runs",
    );
  });

  check("but still remembers the longest, so a day-train route can be flagged", () => {
    assert.strictEqual(runs.get("R1").longest.trip.trip_id, "night");
    // The representative is a day train while the route does run overnight —
    // exactly the case where an allowlist entry matches the wrong thing.
    assert.strictEqual(isOvernightCandidate(runs.get("R1")), false);
    assert.strictEqual(isOvernightCandidate(runs.get("R1").longest), true);
  });

  check("a tie goes to the first trip, matching the adapter's strict >", () => {
    const tied = selectRouteRuns(
      [
        { trip_id: "first", route_id: "R2" },
        { trip_id: "second", route_id: "R2" },
      ],
      new Map([
        ["first", st("20:00:00", "23:00:00")],
        ["second", st("21:00:00", "23:30:00")],
      ]),
    );
    assert.strictEqual(tied.get("R2").trip.trip_id, "first");
  });

  check("trips with unusable or missing stop times are skipped, not crashed on", () => {
    const runs2 = selectRouteRuns(
      [
        { trip_id: "no-times", route_id: "R3" },
        { trip_id: "one-stop", route_id: "R3" },
        { trip_id: "good", route_id: "R3" },
      ],
      new Map([
        ["one-stop", st("20:00:00")],
        ["good", st("20:00:00", "27:00:00")],
      ]),
    );
    assert.strictEqual(runs2.get("R3").trip.trip_id, "good");
    assert.strictEqual(selectRouteRuns(null, null).size, 0);
    assert.strictEqual(selectRouteRuns([{ trip_id: "x", route_id: "R" }], new Map()).size, 0);
  });
}

// ─── --verify-allowlists: which sources, and what it reports ────────────────

check("only gtfs-sleeper sources with a feed and a config are verifiable", () => {
  const ids = allowlistVerifiableSources(loadRegistry()).map((e) => e.id);
  // European Sleeper reads GTFS through its own date-expanded adapter, so
  // running its allowlist through buildSleeperTrains would report false drift.
  assert.ok(!ids.includes("europeansleeper"), "ES must not be verified by this builder");
  assert.ok(!ids.includes("backontrack"), "non-GTFS sources must not be included");
  for (const id of ["amtrak", "viarail", "sncf"]) {
    assert.ok(ids.includes(id), `${id} should be verifiable, got [${ids.join(", ")}]`);
  }
  assert.strictEqual(allowlistVerifiableSources(null).length, 0);
  // A disabled source is not worth a feed download.
  assert.strictEqual(
    allowlistVerifiableSources([
      { id: "off", enabled: false, adapter: "gtfs-sleeper", params: { configPath: "x", feedUrl: "u" } },
      { id: "noconf", enabled: true, adapter: "gtfs-sleeper", params: { feedUrl: "u" } },
    ]).length,
    0,
  );
});

check("reportAllowlist says which entries matched and which found nothing", () => {
  const gtfs = loadGtfsDir(path.join(ROOT, "tests", "fixtures", "na-gtfs"));
  const tmp = fs.mkdtempSync(path.join(ROOT, "tests", ".probe-allowlist-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "list.json"),
      JSON.stringify({
        routes: [
          { name: "IC Nuit 3731", from: "Paris Austerlitz", to: "Tarbes" },
          { name: "IC Nuit 5772", from: "Nice-Ville", to: "Paris Austerlitz" },
          { name: "IC Nuit 0000", from: "Nowhere", to: "Elsewhere" },
        ],
      }),
    );
    const out = reportAllowlist(
      {
        id: "fixture",
        label: "Fixture",
        params: {
          configPath: path.join(path.basename(tmp), "list.json"),
          agency: "SNCF",
          operator: "SNCF",
          canonicalizeStationNames: true,
        },
      },
      gtfs,
      40,
      path.join(ROOT, "tests"),
    );
    assert.deepStrictEqual(out.built.sort(), ["IC Nuit 3731", "IC Nuit 5772"]);
    assert.strictEqual(out.unmatched.length, 1);
    assert.ok(
      out.unmatched[0].startsWith("IC Nuit 0000"),
      `unmatched should name the entry, got ${out.unmatched[0]}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check("a missing or unreadable allowlist reports nothing rather than throwing", () => {
  const gtfs = loadGtfsDir(path.join(ROOT, "tests", "fixtures", "na-gtfs"));
  assert.strictEqual(
    reportAllowlist({ id: "x", params: { configPath: "data/sources/nope.json" } }, gtfs),
    null,
  );
  assert.strictEqual(reportAllowlist({ id: "x", params: {} }, gtfs), null);
});

// ─── The committed SNCF allowlist is well-formed ────────────────────────────
// Cheap insurance: an oriented entry is only as good as its three strings, and
// a typo here costs a train that nothing else would notice was missing.
check("every SNCF allowlist entry names one oriented train", () => {
  const list = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "sources", "sncf-sleepers.json"), "utf8"),
  ).routes;
  assert.ok(list.length >= 9, `expected the nine corridors both ways, got ${list.length}`);
  for (const e of list) {
    for (const k of ["name", "from", "to"]) {
      assert.ok(
        typeof e?.[k] === "string" && e[k].trim(),
        `entry ${JSON.stringify(e)} needs a non-empty ${k}`,
      );
    }
    assert.notStrictEqual(e.from, e.to, `${e.name} runs from and to the same place`);
  }
  const names = list.map((e) => e.name);
  assert.strictEqual(
    new Set(names).size,
    names.length,
    "two entries under one name would collapse onto one train",
  );
  // Both directions, or the enrichment only ever corrects half a route.
  const pairs = new Set(list.map((e) => [e.from, e.to].sort().join("|")));
  assert.strictEqual(
    pairs.size * 2,
    list.length,
    "every corridor should appear once in each direction",
  );
});

console.log(`\n[verify-gtfs-probe] ${passed} checks passed`);
