// scripts/canonicalize.mjs
// Build-time merge: reads the scraped source files in public/data/scraped/ and
// writes the pre-merged { stops, viewMap, trips } payload to
// public/data/published/initial-data.json. /api/initial-data serves this file
// directly when fresh, so the per-request merge only runs as a fallback.
//
// Uses the same buildInitialData() as the live route, so output is identical.
// Which operator sources feed the merge comes from data/sources/registry.json.
// Run with: node scripts/canonicalize.mjs  (or: npm run canonicalize)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
import { loadRegistry, validateRegistry } from "./lib/registry.mjs";
import { inAgencyScope } from "../src/pages/api/lib/primitives.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRAPED_DIR = path.join(ROOT, "public", "data", "scraped");
const PUBLISHED_DIR = path.join(ROOT, "public", "data", "published");
const SEEN_PATH = path.join(ROOT, "data", "canonical", "state", "seen.json");

function readEnvelope(name) {
  try {
    const raw = fs.readFileSync(path.join(SCRAPED_DIR, name), "utf8");
    const envelope = JSON.parse(raw);
    if (!envelope?.uploadedAt) return null;
    return { data: envelope.data, uploadedAt: envelope.uploadedAt };
  } catch {
    return null;
  }
}

function trainsOf(envelope) {
  return envelope?.data?.trains ?? {};
}

/**
 * Rows the source's enrichment landed on, for the health check below.
 *
 * "Trains present but no <prefix> routes built" reads as a broken source, and
 * for NightJet or Amtrak it is one. For a source that only enriches, zero is
 * the healthy answer and the best one available: SNCF and the three Entur
 * feeds exist to put an official stop list on a Back-on-Track row, and they
 * declare `synthetic` purely as the fallback for a train Back-on-Track does
 * not carry. All eight Entur trains matched a row on the first live run, so
 * the old assertion failed the whole publish on a completely successful
 * scrape.
 *
 * What the check should ask is whether the source's trains reached the payload
 * at all, so count the rows its enrichment can see: in agency scope, with a
 * trip_short_name the trains file has a key for. That still fails loudly on
 * the real fault — train keys drifting out of step with Back-on-Track's
 * labels, which is exactly how these sources go quiet — while a source that
 * corroborated every row it was built for passes.
 */
function enrichedRowCount(entry, viewMap, trains) {
  const keys = new Set(Object.keys(trains ?? {}));
  if (!keys.size || entry.enrich?.strategy !== "trainsByNumber") return 0;
  const scope = entry.enrich.agencyIds ?? entry.synthetic?.botMatchAgencies ?? null;
  let matched = 0;
  for (const route of Object.values(viewMap ?? {})) {
    if (!inAgencyScope(route, scope)) continue;
    const named = [route.trip_short_name_0, route.trip_short_name_1]
      .filter(Boolean)
      .map((n) => n.toString().trim());
    if (named.some((n) => keys.has(n))) matched += 1;
  }
  return matched;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[canonicalize] ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function countByPrefix(viewMap, prefix) {
  return Object.keys(viewMap).filter((k) => k.startsWith(prefix)).length;
}

// ── Route history ────────────────────────────────────────────────────────────
// A compact projection of the approval index for the integration dashboard:
// when each published route was first seen and when its content last actually
// changed. Lives under public/ so the (loopback-only) admin API can read it off
// disk — API routes must not fs-read data/, and bundling the 240 KB seen.json
// into the lambda to answer three dates per route would be silly.
//
// lastChanged is maintained by scripts/lib/classify.mjs; a route missing from
// seen.json (classify has not run since it appeared) simply has no dates.
function writeRouteHistory(viewMap, generatedAt) {
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"));
  } catch {
    console.warn("[canonicalize] seen.json unreadable — route-history.json will be empty");
  }

  const routes = {};
  for (const key of Object.keys(viewMap)) {
    const entry = seen?.routes?.[key];
    if (!entry) continue;
    routes[key] = {
      firstSeen: entry.firstSeen ?? null,
      lastSeen: entry.lastSeen ?? null,
      lastChanged: entry.lastChanged ?? entry.firstSeen ?? null,
    };
  }

  fs.writeFileSync(
    path.join(PUBLISHED_DIR, "route-history.json"),
    JSON.stringify({ v: 1, generatedAt, seenUpdatedAt: seen?.updatedAt ?? null, routes }),
  );
  return Object.keys(routes).length;
}

function main() {
  const registry = loadRegistry();
  const registryProblems = validateRegistry(registry);
  assert(
    registryProblems.length === 0,
    `invalid source registry:\n  ${registryProblems.join("\n  ")}`,
  );

  const stopsEnv = readEnvelope("backontrack-stops.json");
  const viewMapEnv = readEnvelope("backontrack-view_ontd_map.json");
  const tripsEnv = readEnvelope("backontrack-trips.json");

  assert(stopsEnv, "backontrack-stops.json missing or malformed");
  assert(viewMapEnv, "backontrack-view_ontd_map.json missing or malformed");
  assert(tripsEnv, "backontrack-trips.json missing or malformed");

  // Operator train sources come from the registry (entries with synthetic config)
  const trainSourceEntries = registry.filter(
    (e) => e.enabled && e.synthetic && e.output,
  );
  const sourceEnvelopes = {};
  const operatorTrains = {};
  for (const entry of trainSourceEntries) {
    const env = readEnvelope(entry.output);
    sourceEnvelopes[entry.id] = env;
    operatorTrains[entry.id] = trainsOf(env);
  }

  // Review gate disabled for now — pass null so every route/station flows through
  // (build-initial-data treats a null index as allow-all). Restore the seen.json
  // read here (and at the other two call sites) to re-enable approval gating.
  const seenIndex = null;
  const stats = {};
  const payload = buildInitialData({
    stops: stopsEnv.data,
    viewMap: viewMapEnv.data,
    trips: tripsEnv.data,
    operatorTrains,
    registry,
    seenIndex,
    stats,
  });

  const stopCount = payload.stops.length;
  const routeCount = Object.keys(payload.viewMap).length;
  const tripCount = Object.keys(payload.trips).length;
  const gatedCount = stats.gatedRouteKeys?.length ?? 0;

  // ── Sanity / parity guards ─────────────────────────────────────────────────
  assert(stopCount > 1000, `expected >1000 stops, got ${stopCount}`);
  assert(routeCount > 50, `expected >50 routes, got ${routeCount}`);
  assert(tripCount > 50, `expected >50 trips, got ${tripCount}`);

  // A corrupt/missing approval index must never blank the map: if more than
  // 10% of routes are gated something is wrong — fail and keep the previous
  // published file (the site keeps serving yesterday's data).
  assert(
    gatedCount <= (routeCount + gatedCount) * 0.1,
    `review gate withheld ${gatedCount}/${routeCount + gatedCount} routes — suspicious seen.json, refusing to publish`,
  );
  if (gatedCount > 0) {
    console.log(
      `[canonicalize] review gate withholding ${gatedCount} unapproved route(s): ${stats.gatedRouteKeys.slice(0, 10).join(", ")}`,
    );
  }

  const syntheticCounts = [];
  for (const entry of trainSourceEntries) {
    const prefix = entry.synthetic.idPrefix;
    const count = countByPrefix(payload.viewMap, prefix);
    // Routes withheld by the review gate still count as "built" — a source
    // whose only routes are pending approval is healthy, not broken.
    const gatedWithPrefix = (stats.gatedRouteKeys ?? []).filter((k) =>
      k.startsWith(prefix),
    ).length;
    const enriched = enrichedRowCount(entry, payload.viewMap, operatorTrains[entry.id]);
    syntheticCounts.push(
      enriched ? `${entry.id} ${count}+${enriched}e` : `${entry.id} ${count}`,
    );
    if (Object.keys(operatorTrains[entry.id]).length > 0) {
      assert(
        count + gatedWithPrefix + enriched > 0,
        `${entry.id} trains present but reached no route — neither a ${prefix} route nor an enriched Back-on-Track row`,
      );
    }
  }

  // No Train4you should survive the merge.
  const t4yLeft = Object.values(payload.viewMap).filter(
    (r) => (r?.agency_id || "").toString().trim() === "UEX",
  ).length;
  assert(t4yLeft === 0, `Train4you (UEX) rows leaked into viewMap: ${t4yLeft}`);

  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(PUBLISHED_DIR, "initial-data.json"),
    JSON.stringify({
      uploadedAt: now,
      generatedAt: now,
      sources: {
        stops: stopsEnv?.uploadedAt ?? null,
        viewMap: viewMapEnv?.uploadedAt ?? null,
        trips: tripsEnv?.uploadedAt ?? null,
        ...Object.fromEntries(
          trainSourceEntries.map((e) => [
            e.id,
            sourceEnvelopes[e.id]?.uploadedAt ?? null,
          ]),
        ),
      },
      data: payload,
    }),
  );

  const historyCount = writeRouteHistory(payload.viewMap, now);

  console.log(
    `[canonicalize] wrote published/initial-data.json — ` +
      `${stopCount} stops, ${routeCount} routes, ${tripCount} trips ` +
      `(synthetic: ${syntheticCounts.join(", ")})`,
  );
  console.log(`[canonicalize] wrote published/route-history.json — ${historyCount} routes`);
}

main();
