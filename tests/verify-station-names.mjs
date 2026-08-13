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

const { applyStationNameReplacements, applyReplacementsToTrips } = await import(
  path.join(root, "src", "data", "stationNameReplacements.js")
);

check("Leo Express Frankfurt Flughafen is rewritten to Süd", () => {
  const row = applyStationNameReplacements({
    agency_id: "LE",
    route_id: 270,
    origin_trip_0: "Przemyśl Gł.",
    destination_trip_0: "Frankfurt (Main) Flughafen Fernbahnhof",
    origin_trip_1: "Frankfurt (Main) Flughafen Fernbahnhof",
    destination_trip_1: "Przemyśl Gł.",
    via_1: "Frankfurt (Main) Süd - Praha hl.n. - Kraków Główny",
  });
  assert(
    row.destination_trip_0 === "Frankfurt (Main) Süd",
    `dir0 dest should be Süd, got ${row.destination_trip_0}`,
  );
  assert(
    row.origin_trip_1 === "Frankfurt (Main) Süd",
    `dir1 origin should be Süd, got ${row.origin_trip_1}`,
  );
  assert(
    !row.via_1.startsWith("Frankfurt (Main) Süd"),
    `via should drop the new terminus, got ${row.via_1}`,
  );
});

check("Nightjet Frankfurt Flughafen is not rewritten (different spelling, not LE)", () => {
  const row = applyStationNameReplacements({
    agency_id: "ÖBB",
    route_id: "nj_standalone_NJ_402",
    via_0: "Mannheim Hbf - Frankfurt(M) Flughafen Fernbf - Mainz Hbf",
  });
  assert(
    row.via_0.includes("Frankfurt(M) Flughafen Fernbf"),
    `NJ via should keep Flughafen Fernbf, got ${row.via_0}`,
  );
});

check("Baqël replacement still scoped to its routeIds", () => {
  const hit = applyStationNameReplacements({
    agency_id: "BG",
    route_id: 142,
    origin_trip_0: "Baqël",
  });
  assert(hit.origin_trip_0 === "Oborishte", `route 142 should rename, got ${hit.origin_trip_0}`);
  const miss = applyStationNameReplacements({
    agency_id: "BG",
    route_id: 1,
    origin_trip_0: "Baqël",
  });
  assert(miss.origin_trip_0 === "Baqël", `other routes should keep Baqël, got ${miss.origin_trip_0}`);
});

check("Leo Express trips get the same Frankfurt rewrite for booking", () => {
  const trips = applyReplacementsToTrips(
    {
      a: {
        route_id: 270,
        agency_id: "LE",
        trip_origin: "Frankfurt (Main) Flughafen Fernbahnhof",
        trip_headsign: "Przemyśl Gł.",
      },
    },
    {},
  );
  assert(
    trips.a.trip_origin === "Frankfurt (Main) Süd",
    `trip origin should be Süd, got ${trips.a.trip_origin}`,
  );
});

console.log(`\n${passed} checks passed.`);
