// tests/verify-station-times.mjs
// Unit tests for src/lib/seo/stationTimes.mjs — the build-time index that gives
// the /connections/ pages their full station lists.
//
// The index is keyed by BARE train number, because that is the shape
// Back-on-Track's trip_short_name comes in. A bare number is only unique WITHIN
// an operator (Back-on-Track carries a CFM/CFR 401 and an SJN 475 next to
// European Sleeper's ES 401/475), so the index has to hold every feed that
// claims a number and let endpoint validation pick the right one. Keeping only
// the first feed readdir returned meant the wrong one was found, rejected by
// that validation, and the timetable dropped entirely — which is how 14
// Nightjet/EuroNight timetables silently vanished from the connection pages.
//
// Raw node, no network. Run: npm run verify-station-times
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module fs-reads public/data/scraped relative to process.cwd() and
// memoizes on first use, so the fixture root has to be current before it loads.
process.chdir(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "station-times"),
);
const { getStationTimesForTrain } = await import("../src/lib/seo/stationTimes.mjs");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const names = (stations) => (stations || []).map((s) => s.name);

check("two feeds claiming one number each resolve to their own train", () => {
  // aa-sjn sorts first, so under a first-wins index the ES lookup got the
  // Norwegian train, failed validation, and returned nothing at all.
  assert.deepStrictEqual(
    names(
      getStationTimesForTrain("475", {
        origin: "Paris Gare du Nord",
        destination: "Berlin Gesundbrunnen",
      }),
    ),
    ["Paris Gare du Nord", "Bruxelles Midi", "Berlin Gesundbrunnen"],
  );
  assert.deepStrictEqual(
    names(getStationTimesForTrain("475", { origin: "Trondheim S", destination: "Bodø" })),
    ["Trondheim S", "Steinkjer", "Mo i Rana", "Bodø"],
  );
});

check("a train whose endpoints match neither feed gets nothing", () => {
  assert.strictEqual(
    getStationTimesForTrain("475", {
      origin: "Milano Centrale",
      destination: "Roma Termini",
    }),
    null,
  );
});

check("per-stop times and the arrival/departure split survive the index", () => {
  const stops = getStationTimesForTrain("475", {
    origin: "Paris Gare du Nord",
    destination: "Berlin Gesundbrunnen",
  });
  assert.strictEqual(stops[0].departure, "18:03");
  assert.strictEqual(stops[0].arrival, "");
  assert.strictEqual(stops[1].arrival, "20:16");
  assert.strictEqual(stops[1].departure, "20:32");
  assert.strictEqual(stops[2].arrival, "10:10");
});

check("endpoints validate through the alias table, not just raw spelling", () => {
  // The feed says "Prag Hbf"; the route row says "Praha hl.n.". Without the
  // alias resolution this whole 3-stop list was dropped. The stops come back
  // canonicalized too, so the page cannot name one station two ways.
  assert.deepStrictEqual(
    names(
      getStationTimesForTrain("40459", {
        origin: "Zürich HB",
        destination: "Praha hl.n.",
      }),
    ),
    ["Zürich HB", "Nürnberg Hbf", "Praha hl.n."],
  );
});

check("with no endpoints to judge by, the first claimant stands", () => {
  assert.deepStrictEqual(names(getStationTimesForTrain("475")), [
    "Trondheim S",
    "Steinkjer",
    "Mo i Rana",
    "Bodø",
  ]);
});

check("an unknown number resolves to nothing", () => {
  assert.strictEqual(getStationTimesForTrain("99999"), null);
  assert.strictEqual(getStationTimesForTrain(""), null);
  assert.strictEqual(getStationTimesForTrain(null), null);
});

check("train numbers match regardless of spacing and case", () => {
  assert.deepStrictEqual(
    names(getStationTimesForTrain(" 475 ", { origin: "Trondheim S", destination: "Bodø" })),
    ["Trondheim S", "Steinkjer", "Mo i Rana", "Bodø"],
  );
});

console.log(`\n[verify-station-times] ${passed} checks passed`);
