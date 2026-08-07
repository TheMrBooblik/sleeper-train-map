#!/usr/bin/env node
/**
 * Unit tests for bilingual-aware matchStationNames.
 * Run: npm run verify-station-names
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { matchStationNames } = await import(
  path.join(root, "src", "components", "Map", "utils", "stationNameUtils.js")
);
const { normalizeStationNameForLookup } = await import(
  path.join(root, "src", "hooks", "requests", "useCities.js")
);

function match(a, b) {
  return matchStationNames(a, b, normalizeStationNameForLookup);
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("Bergen (NO) does not match Mons / Bergen (BE)", () => {
  assert(!match("Bergen", "Mons / Bergen"), "Bergen ↛ Mons / Bergen");
  assert(!match("Mons / Bergen", "Bergen"), "Mons / Bergen ↛ Bergen");
});

check("Mons matches Mons / Bergen via primary half", () => {
  assert(match("Mons", "Mons / Bergen"), "Mons → Mons / Bergen");
  assert(match("Mons / Bergen", "Mons"), "Mons / Bergen → Mons");
});

check("identical bilingual names match", () => {
  assert(
    match("Mons / Bergen", "Mons / Bergen"),
    "Mons / Bergen → Mons / Bergen",
  );
});

check("multi-word secondary half still matches (Brussel Zuid)", () => {
  assert(
    match("Brussel Zuid", "Bruxelles Midi / Brussel Zuid"),
    "Brussel Zuid → Bruxelles Midi / Brussel Zuid",
  );
  assert(
    match("Bruxelles Midi", "Bruxelles Midi / Brussel Zuid"),
    "Bruxelles Midi → Bruxelles Midi / Brussel Zuid",
  );
});

check("Paris still matches Paris Gare de Lyon (non-bilingual)", () => {
  assert(match("Paris", "Paris Gare de Lyon"), "Paris → Paris Gare de Lyon");
});

check("single-word distinct cities still do not match", () => {
  assert(!match("Hove", "Eindhoven"), "Hove ↛ Eindhoven");
  assert(!match("Bergen", "Mons"), "Bergen ↛ Mons");
});

console.log(`\n${passed} checks passed.`);
