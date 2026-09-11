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
import {
  EVENING_FROM_SECONDS,
  daysOf,
  isOvernightCandidate,
  toSeconds,
} from "../scripts/probe-gtfs.mjs";

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

console.log(`\n[verify-gtfs-probe] ${passed} checks passed`);
