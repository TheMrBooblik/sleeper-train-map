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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module fs-reads public/data/scraped relative to process.cwd() and
// memoizes on first use, so the fixture root has to be current before it loads.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(TESTS_DIR, "fixtures", "station-times"));
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

// ── The assembled page: a stop belongs to one journey ─────────────────────
// getStationTimesForTrain hands over a feed trip's stops; src/lib/seo/data.js
// then overrides the endpoint times from the gated viewMap row. It overrode
// only half of each endpoint, so the origin kept the FEED's arrival beside the
// ROW's departure and the destination the reverse — two trips in one stop, and
// on Paris–Aurillac (where the enrichment had deliberately refused the feed's
// 2-stop portion) that printed `{"departure":"19:28","arrival":"18:27"}`.
// A journey does not arrive where it starts or depart from where it ends, so
// both fields are meaningless whatever their source. Asserted against the
// BUILT pages, because the defect lives in the assembly rather than in either
// function, and the assembly reads the committed artifact.
check("no built page gives an origin an arrival or a destination a departure", () => {
  const dir = path.join(TESTS_DIR, "..", ".next", "server", "pages", "connections");
  if (!fs.existsSync(dir)) {
    console.log("      (skipped — run `npm run build` first)");
    return;
  }
  let pages = 0;
  let offenders = [];
  let intermediatesWithTimes = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".html")) continue;
    pages += 1;
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of html.matchAll(/"stops":\[(.*?)\](?=,"serviceDays")/g)) {
      let stops;
      try {
        stops = JSON.parse(`[${m[1]}]`);
      } catch {
        continue;
      }
      if (stops.length < 2) continue;
      if (stops[0].arrival) offenders.push(`${file}: origin ${stops[0].name} arrives ${stops[0].arrival}`);
      const last = stops[stops.length - 1];
      if (last.departure) offenders.push(`${file}: destination ${last.name} departs ${last.departure}`);
      for (const s of stops.slice(1, -1)) if (s.arrival || s.departure) intermediatesWithTimes += 1;
    }
  }
  assert.ok(pages > 100, `expected the built connection pages, found ${pages}`);
  assert.deepStrictEqual(offenders.slice(0, 5), [], `${offenders.length} endpoint(s) carry a time they cannot have`);
  // The inverse: clearing the endpoints must not have cost the stops in
  // between their times, which are the whole reason to prefer a feed.
  assert.ok(
    intermediatesWithTimes > 2000,
    `intermediate stops lost their times: only ${intermediatesWithTimes} carry any`,
  );
  console.log(`      (${pages} pages, ${intermediatesWithTimes} intermediate stops still timed)`);
});

console.log(`\n[verify-station-times] ${passed} checks passed`);
