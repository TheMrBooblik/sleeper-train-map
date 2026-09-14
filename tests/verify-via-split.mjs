// tests/verify-via-split.mjs
// A via string is stations joined with " - ", and 437 of the payload's stops
// carry that separator inside their own name. Splitting on it therefore invents
// places: SNCF's "Rocamadour - Padirac" arrived as "Rocamadour" and "Padirac",
// two names no stop answers to. The cost compounds — the payload projection
// drops the real station from the shipped payload, so the browser never even
// receives it, and the connection page shows the two fabricated names.
//
// Raw node, no network. Run: npm run verify-via-split
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitViaString,
  viaNameCandidates,
  knownStationPredicate,
} from "../src/lib/viaSplit.mjs";
import { normalizeStationNameForLookup } from "../src/lib/stationKey.mjs";
import { projectStopsToRoutes } from "../src/pages/api/lib/payload-projection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── The splitter, against a fixture ──
const STATIONS = [
  "Limoges",
  "Rocamadour - Padirac",
  "Figeac",
  "Brive",
  "Paris",
  "Lyon",
];
const isKnown = (n) =>
  STATIONS.some((s) => s.toLowerCase() === String(n ?? "").trim().toLowerCase());

check("a station whose name holds the separator survives it", () => {
  const out = splitViaString("Limoges - Rocamadour - Padirac - Figeac", isKnown);
  assert.deepStrictEqual(out, ["Limoges", "Rocamadour - Padirac", "Figeac"]);
});

check("without a predicate it is exactly the old behaviour", () => {
  // A caller with no station table must not change what it does today.
  assert.deepStrictEqual(
    splitViaString("Limoges - Rocamadour - Padirac - Figeac"),
    ["Limoges", "Rocamadour", "Padirac", "Figeac"],
  );
});

check("two ordinary stations are never glued together", () => {
  // The failure mode of a greedy merge. Neither "Paris - Lyon" nor any prefix
  // of it is a station, so both must stay separate.
  assert.deepStrictEqual(splitViaString("Paris - Lyon", isKnown), ["Paris", "Lyon"]);
});

check("a merged name that IS a station still loses to two real stations", () => {
  // The second guard: if every half stands alone as a station, the separator
  // was doing its job, whatever the merged string happens to match.
  const ambiguous = (n) => ["Paris", "Lyon", "Paris - Lyon"].includes(String(n).trim());
  assert.deepStrictEqual(splitViaString("Paris - Lyon", ambiguous), ["Paris", "Lyon"]);
});

check("a three-atom name beats the two-atom prefix inside it", () => {
  const known = (n) =>
    ["A - B - C", "A - B", "Z"].includes(String(n).trim());
  assert.deepStrictEqual(splitViaString("A - B - C - Z", known), ["A - B - C", "Z"]);
});

check("degenerate input yields nothing rather than throwing", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.deepStrictEqual(splitViaString(v, isKnown), []);
    assert.deepStrictEqual(viaNameCandidates(v), []);
  }
  assert.deepStrictEqual(splitViaString("Limoges", isKnown), ["Limoges"]);
});

check("candidates cover every reading, so a keep-set cannot miss one", () => {
  const c = viaNameCandidates("Rocamadour - Padirac - Figeac");
  for (const want of [
    "Rocamadour",
    "Padirac",
    "Figeac",
    "Rocamadour - Padirac",
    "Padirac - Figeac",
    "Rocamadour - Padirac - Figeac",
  ]) {
    assert.ok(c.includes(want), `candidates missing ${want}: ${c.join(" | ")}`);
  }
});

// ── Against the real published payload ──
const artifactPath = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "published",
  "initial-data.json",
);
const { data } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const isRealStation = knownStationPredicate(data.stops, normalizeStationNameForLookup);

// The five SNCF stations the separator split tore in half.
const TORN = [
  "Rocamadour - Padirac",
  "Viviez - Decazeville",
  "Mont-Dauphin - Guillestre",
  "Les Arcs - Draguignan",
  "Luzenac - Garanou",
];

check("the torn stations are real stations, and their halves are not", () => {
  for (const name of TORN) {
    assert.ok(isRealStation(name), `${name} should be a station in the payload`);
    for (const half of name.split(" - ")) {
      assert.ok(
        !isRealStation(half),
        `"${half}" resolves to a station — this fixture no longer proves the fault`,
      );
    }
  }
});

check("the shipped payload carries them — the projection used to drop all five", () => {
  const projected = projectStopsToRoutes({ stops: data.stops, viewMap: data.viewMap });
  const shipped = new Set(projected.stops.map((s) => s.stop_id));
  for (const name of TORN) {
    assert.ok(shipped.has(name), `${name} is missing from the shipped payload`);
  }
});

check("splitting by station name strictly reduces unresolved via stations", () => {
  let bare = 0;
  let smart = 0;
  let smartTotal = 0;
  for (const row of Object.values(data.viewMap)) {
    for (const d of [0, 1]) {
      const via = row[`via_${d}`];
      if (!via) continue;
      for (const n of splitViaString(via)) if (!isRealStation(n)) bare += 1;
      for (const n of splitViaString(via, isRealStation)) {
        smartTotal += 1;
        if (!isRealStation(n)) smart += 1;
      }
    }
  }
  assert.ok(smartTotal > 3000, `sanity: expected a real payload, got ${smartTotal} tokens`);
  assert.ok(
    smart < bare,
    `expected fewer unresolved stations, got ${smart} against ${bare}`,
  );
  // Measured 59 → 31 when this landed. Assert the gap, not the numbers, so
  // nightly data drift cannot fail the suite for the wrong reason.
  assert.ok(
    bare - smart >= 20,
    `expected the separator split to cost ≥20 stations, measured ${bare - smart}`,
  );
  console.log(`      (${bare} unresolved by separator, ${smart} by station name)`);
});

check("no via string in the payload merges two stations that each stand alone", () => {
  // The guard's own risk, measured rather than assumed: if this ever fires,
  // splitViaString would be gluing two real stations into one.
  let ambiguous = 0;
  for (const row of Object.values(data.viewMap)) {
    for (const d of [0, 1]) {
      const atoms = String(row[`via_${d}`] ?? "")
        .split(" - ")
        .map((s) => s.trim())
        .filter(Boolean);
      for (let i = 0; i + 1 < atoms.length; i += 1) {
        const merged = `${atoms[i]} - ${atoms[i + 1]}`;
        if (
          isRealStation(merged) &&
          isRealStation(atoms[i]) &&
          isRealStation(atoms[i + 1])
        ) {
          ambiguous += 1;
        }
      }
    }
  }
  assert.strictEqual(ambiguous, 0, `${ambiguous} ambiguous merge(s) in the payload`);
});

// ── The call sites, asserted structurally ──
// The fault was one line copied into eleven places, so the thing worth pinning
// is that the places now share a function rather than each keeping a copy.
check("the load-bearing readers go through the shared splitter", () => {
  const mustUse = [
    "src/pages/api/lib/payload-projection.mjs",
    "src/hooks/requests/useInitialData.js",
    "src/components/Map/utils/buildAllRoutesPaths.js",
    "src/components/Map/hooks/useRoutePaths.js",
    "scripts/lib/enrich-view-map.mjs",
    "src/lib/integrations/model.mjs",
  ];
  for (const rel of mustUse) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(
      /viaSplit\.mjs/.test(src),
      `${rel} does not import the shared splitter`,
    );
    assert.ok(
      !/\.split\("\s-\s"\)/.test(src),
      `${rel} still splits a string on the separator by hand`,
    );
  }
});

check("the SEO layer splits by station name too", () => {
  // parseViaList was the twelfth hand-rolled split and the only one whose
  // output reaches a public page, which is why it is asserted by behaviour
  // rather than by grep: it hid from a search for '.split(" - ")' by using a
  // regex instead.
  const fmt = fs.readFileSync(path.join(__dirname, "..", "src/lib/seo/format.js"), "utf8");
  assert.ok(/viaSplit\.mjs/.test(fmt), "format.js does not use the shared splitter");

  const seo = fs.readFileSync(path.join(__dirname, "..", "src/lib/seo/data.js"), "utf8");
  const calls = seo.match(/parseViaList\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected parseViaList call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.ok(
      /getKnownStation\(\)/.test(call),
      `SEO call site passes no station table: ${call}`,
    );
  }
});

check("a real SNCF via list keeps its two-word stations whole", () => {
  const row = Object.values(data.viewMap).find((r) =>
    String(r.via_0 ?? "").includes("Rocamadour"),
  );
  assert.ok(row, "fixture route not found in the payload");
  const torn = splitViaString(row.via_0);
  const whole = splitViaString(row.via_0, isRealStation);
  assert.ok(torn.includes("Rocamadour"), "fixture no longer demonstrates the fault");
  assert.ok(whole.includes("Rocamadour - Padirac"), "station was not kept whole");
  assert.ok(!whole.includes("Rocamadour"), "the torn half is still present");
  assert.strictEqual(whole.length, torn.length - 2, "expected two fewer stops");
});

console.log(`\n[verify-via-split] ${passed} checks passed`);
