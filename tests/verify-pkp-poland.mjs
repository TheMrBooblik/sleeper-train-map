#!/usr/bin/env node
/**
 * End-to-end checks for PLK coverage of PKP-operated routes.
 * Run: node tests/verify-pkp-poland.mjs
 *
 * Uses the committed PLK candidate cache (no network) against the published
 * stop table, so it can run in CI without PLK_API_KEY. Asserts:
 *   1. Scope = every row PKP operates (agency_id or bot_agency_id).
 *   2. Nightjet-covered trip labels are skipped.
 *   3. Every PLK-enriched via_* name resolves to a stop with coordinates.
 *   4. No implausible hop between consecutive chained stations (the signature
 *      of a silently-dropped via name that used to shortcut the Czech leg).
 *   5. The client merge keeps a PLK-owned station list instead of overwriting it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOperatedBy,
  coveredBy,
  makeStopResolver,
  plkScheduleForRow,
} from "../scripts/lib/plk.mjs";
import { attachPkpGtfsPolylinesToViewMap } from "../src/lib/pkpGtfsMerge.js";
import { buildPathForDirection } from "../src/lib/buildPathForDirection.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const published = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "public/data/published/initial-data.json"),
    "utf8",
  ),
).data;
const plkCache = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "public/data/scraped/pkp-plk-trains.json"),
    "utf8",
  ),
).data;
const nightjetTrains = new Set(
  Object.keys(
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "public/data/scraped/nightjet-trains.json"),
        "utf8",
      ),
    ).data?.trains ?? {},
  ).map((n) => n.trim()),
);

const candidates = plkCache.candidates ?? [];
assert.ok(candidates.length > 10, "PLK candidate cache must be non-empty");

// 1) Scope: every PKP-operated row, including partner agencies and bot_agency_id.
const pkpRows = Object.entries(published.viewMap).filter(([, r]) =>
  isOperatedBy(r, "PKP"),
);
assert.ok(pkpRows.length >= 19, `expected ≥19 PKP-operated rows, got ${pkpRows.length}`);
assert.ok(
  pkpRows.some(([, r]) => (r.agency_id || "").includes("MÁV")),
  "MÁV/PKP partnership must be in scope",
);
assert.ok(
  pkpRows.some(([, r]) => (r.bot_agency_id || "").includes("PKP")),
  "Nightjet-replaced rows that keep bot_agency_id=PKP… must be in scope",
);
assert.equal(
  isOperatedBy({ agency_id: "UZ" }, "PKP"),
  false,
  "UZ-only rows stay out of scope",
);

// 2) Nightjet exception: the two EN 40406 / EN 40417 standalones are covered.
const njCovered = pkpRows.filter(([, r]) => coveredBy(r, nightjetTrains));
assert.ok(
  njCovered.length >= 2,
  `expected ≥2 Nightjet-covered PKP rows to skip, got ${njCovered.length}`,
);

// 3 + 4) Apply PLK enrichment offline and check every via name resolves with
//        no implausible hop on the chained line.
const resolveStops = makeStopResolver(published.stops);
const stopByName = new Map();
for (const s of published.stops) {
  if (!s?.stop_name || !Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon))
    continue;
  stopByName.set(s.stop_name.toLowerCase().trim(), [
    s.stop_lat,
    s.stop_lon,
  ]);
}
const findStationCoords = (name) =>
  stopByName.get((name || "").toLowerCase().trim()) ?? null;
const neverSkip = () => false;

let enriched = 0;
const missing = [];
const longHops = [];
const MAX_HOP_KM = 450; // longest real sleeper hop in Poland is ~288 km (Gdańsk–Warszawa)

for (const [key, row] of pkpRows) {
  if (coveredBy(row, nightjetTrains)) continue;
  const fields = plkScheduleForRow(row, candidates, resolveStops);
  if (!fields) continue;
  enriched += 1;
  const next = { ...row, ...fields };

  for (const d of [0, 1]) {
    const via = next[`via_${d}`];
    if (!via) continue;
    const origin = next[`origin_trip_${d}`];
    const dest = next[`destination_trip_${d}`];
    for (const name of via.split(" - ").map((s) => s.trim()).filter(Boolean)) {
      if (!findStationCoords(name)) missing.push(`${key}/${d}: ${name}`);
    }
    const path = buildPathForDirection(
      origin,
      dest,
      via,
      findStationCoords,
      neverSkip,
    );
    if (!path) continue;
    for (let i = 1; i < path.length; i += 1) {
      const [lat0, lon0] = path[i - 1];
      const [lat1, lon1] = path[i];
      const km = Math.hypot((lat1 - lat0) * 111, (lon1 - lon0) * 70);
      if (km > MAX_HOP_KM) {
        longHops.push(
          `${key}/${d}: ${Math.round(km)}km hop near index ${i}`,
        );
      }
    }
  }
}

assert.ok(
  enriched >= 5,
  `expected several PKP rows to match cached PLK candidates, got ${enriched}`,
);
assert.equal(
  missing.length,
  0,
  `every PLK via name must resolve to a stop with coordinates:\n  ${missing.slice(0, 20).join("\n  ")}`,
);
assert.equal(
  longHops.length,
  0,
  `chained line must not shortcut across dropped stations:\n  ${longHops.slice(0, 10).join("\n  ")}`,
);

// 5) Client merge keeps a PLK-owned station list (pkp_source_${d} = "pkp-plk").
const plkOwnedVia = "PLK Station A - PLK Station B";
const clientIn = {
  r1: {
    agency_id: "PKP",
    trip_short_name_0: "IC 16170",
    origin_trip_0: "Warszawa Wschodnia",
    destination_trip_0: "Szklarska Poręba Górna",
    via_0: plkOwnedVia,
    pkp_schedule_0: [{ name: "PLK Station A" }],
    pkp_source_0: "pkp-plk",
  },
};
// Minimal bundle entry that WOULD overwrite via_0 if the guard were broken.
const fakeBundle = {
  byTrainKey: {
    16170: {
      positions: [
        [52.25, 21.05],
        [50.82, 15.5],
      ],
      stops: [
        { name: "Warszawa Wschodnia" },
        { name: "Wrocław Główny" },
        { name: "Szklarska Poręba Górna" },
      ],
    },
  },
};
const clientOut = attachPkpGtfsPolylinesToViewMap(clientIn, fakeBundle);
assert.equal(
  clientOut.r1.via_0,
  plkOwnedVia,
  "client merge must not overwrite a PLK-owned via_",
);
assert.ok(
  clientOut.r1.pkp_gtfs_positions_0?.length >= 2,
  "geometry from the GTFS bundle still attaches when PLK owns the station list",
);

console.log(
  `pkp-poland OK — ${pkpRows.length} PKP-operated rows, ${njCovered.length} Nightjet-skipped, ` +
    `${enriched} PLK-enriched offline, all via names resolve, no >${MAX_HOP_KM}km hops, client keeps PLK via_`,
);
