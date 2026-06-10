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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRAPED_DIR = path.join(ROOT, "public", "data", "scraped");
const PUBLISHED_DIR = path.join(ROOT, "public", "data", "published");

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

function assert(condition, message) {
  if (!condition) {
    console.error(`[canonicalize] ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function countByPrefix(viewMap, prefix) {
  return Object.keys(viewMap).filter((k) => k.startsWith(prefix)).length;
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

  const payload = buildInitialData({
    stops: stopsEnv.data,
    viewMap: viewMapEnv.data,
    trips: tripsEnv.data,
    operatorTrains,
    registry,
  });

  const stopCount = payload.stops.length;
  const routeCount = Object.keys(payload.viewMap).length;
  const tripCount = Object.keys(payload.trips).length;

  // ── Sanity / parity guards ─────────────────────────────────────────────────
  assert(stopCount > 1000, `expected >1000 stops, got ${stopCount}`);
  assert(routeCount > 50, `expected >50 routes, got ${routeCount}`);
  assert(tripCount > 50, `expected >50 trips, got ${tripCount}`);

  const syntheticCounts = [];
  for (const entry of trainSourceEntries) {
    const prefix = entry.synthetic.idPrefix;
    const count = countByPrefix(payload.viewMap, prefix);
    syntheticCounts.push(`${entry.id} ${count}`);
    if (Object.keys(operatorTrains[entry.id]).length > 0) {
      assert(
        count > 0,
        `${entry.id} trains present but no ${prefix} routes built`,
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

  console.log(
    `[canonicalize] wrote published/initial-data.json — ` +
      `${stopCount} stops, ${routeCount} routes, ${tripCount} trips ` +
      `(synthetic: ${syntheticCounts.join(", ")})`,
  );
}

main();
