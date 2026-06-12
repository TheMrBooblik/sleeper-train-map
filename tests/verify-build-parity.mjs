// tests/verify-build-parity.mjs
// Golden parity test for the registry-driven merge refactor: feeds the
// committed scraped envelopes through buildInitialData() — with the committed
// seen index, exactly like scripts/canonicalize.mjs — and asserts the result
// matches the committed published/initial-data.json (which was built from the
// same scrape run). Any semantic drift in the merge shows up here.
// Note: changes to merge inputs between scrape commits (e.g. approved alias
// overrides) make this fail by design — regenerate via `npm run canonicalize`.
// Run: npm run verify-build-parity

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
import { loadRegistry } from "../scripts/lib/registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRAPED_DIR = path.join(ROOT, "public", "data", "scraped");
const PUBLISHED = path.join(ROOT, "public", "data", "published", "initial-data.json");

function readEnvelope(name) {
  try {
    const envelope = JSON.parse(fs.readFileSync(path.join(SCRAPED_DIR, name), "utf8"));
    return envelope?.uploadedAt ? envelope : null;
  } catch {
    return null;
  }
}

// Returns the path of the first difference between two JSON values, or null.
function firstDiff(a, b, crumb = "$") {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${crumb} (type ${typeof a} vs ${typeof b})`;
  if (a === null || b === null) return `${crumb} (${a} vs ${b})`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${crumb} (array vs object)`;
  if (typeof a !== "object") return `${crumb} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    const extraA = aKeys.filter((k) => !(k in b)).slice(0, 5);
    const extraB = bKeys.filter((k) => !(k in a)).slice(0, 5);
    return `${crumb} (key count ${aKeys.length} vs ${bKeys.length}; only-built: ${extraA.join(",") || "-"}; only-published: ${extraB.join(",") || "-"})`;
  }
  for (const k of aKeys) {
    if (!(k in b)) return `${crumb}.${k} (missing in published)`;
    const d = firstDiff(a[k], b[k], `${crumb}.${k}`);
    if (d) return d;
  }
  return null;
}

const published = JSON.parse(fs.readFileSync(PUBLISHED, "utf8"));
const registry = loadRegistry();

const stopsEnv = readEnvelope("backontrack-stops.json");
const viewMapEnv = readEnvelope("backontrack-view_ontd_map.json");
const tripsEnv = readEnvelope("backontrack-trips.json");
if (!stopsEnv || !viewMapEnv || !tripsEnv) {
  console.error("verify-build-parity: scraped BoT files missing — cannot run");
  process.exit(1);
}

const operatorTrains = {};
for (const entry of registry) {
  if (!(entry.enabled && entry.synthetic && entry.output)) continue;
  operatorTrains[entry.id] = readEnvelope(entry.output)?.data?.trains ?? {};
}

// Same gate as canonicalize: without it the test compares an un-gated build
// against the gated published artifact and goes red whenever anything is
// pending review.
let seenIndex = null;
try {
  seenIndex = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "canonical", "state", "seen.json"), "utf8"),
  );
} catch {
  seenIndex = null;
}

const payload = buildInitialData({
  stops: stopsEnv.data,
  viewMap: viewMapEnv.data,
  trips: tripsEnv.data,
  operatorTrains,
  registry,
  seenIndex,
});

const expected = published.data;
const failures = [];

if (payload.stops.length !== expected.stops.length) {
  failures.push(`stop count: built ${payload.stops.length} vs published ${expected.stops.length}`);
}

const builtRouteKeys = new Set(Object.keys(payload.viewMap));
const publishedRouteKeys = new Set(Object.keys(expected.viewMap));
const onlyBuilt = [...builtRouteKeys].filter((k) => !publishedRouteKeys.has(k));
const onlyPublished = [...publishedRouteKeys].filter((k) => !builtRouteKeys.has(k));
if (onlyBuilt.length || onlyPublished.length) {
  failures.push(
    `route keys differ — only-built: [${onlyBuilt.slice(0, 10).join(", ")}] only-published: [${onlyPublished.slice(0, 10).join(", ")}]`,
  );
}

const builtTripKeys = Object.keys(payload.trips).length;
const publishedTripKeys = Object.keys(expected.trips).length;
if (builtTripKeys !== publishedTripKeys) {
  failures.push(`trip count: built ${builtTripKeys} vs published ${publishedTripKeys}`);
}

// Deep equality (field-level) — strongest guarantee, reported by first diff path.
const deep = firstDiff(payload, expected);
if (deep) failures.push(`first deep difference at ${deep}`);

if (failures.length) {
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("\nverify-build-parity: FAILED");
  process.exit(1);
}

console.log(
  `verify-build-parity: OK — ${payload.stops.length} stops, ${builtRouteKeys.size} routes, ${builtTripKeys} trips identical to published artifact`,
);
