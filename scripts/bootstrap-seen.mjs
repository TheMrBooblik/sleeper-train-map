// scripts/bootstrap-seen.mjs
// One-off: snapshot the current merged payload and grandfather everything —
// every route key and injected station currently live is marked approved, so
// turning on the review gate changes nothing visually on day one.
// Run once locally, commit data/canonical/state/seen.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { fingerprintRoute } from "./lib/classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRAPED_DIR = path.join(ROOT, "public", "data", "scraped");
const SEEN_PATH = path.join(ROOT, "data", "canonical", "state", "seen.json");

function readEnvelope(name) {
  try {
    const envelope = JSON.parse(
      fs.readFileSync(path.join(SCRAPED_DIR, name), "utf8"),
    );
    return envelope?.uploadedAt ? envelope : null;
  } catch {
    return null;
  }
}

const registry = loadRegistry();
const stopsEnv = readEnvelope("backontrack-stops.json");
const viewMapEnv = readEnvelope("backontrack-view_ontd_map.json");
const tripsEnv = readEnvelope("backontrack-trips.json");
if (!stopsEnv || !viewMapEnv || !tripsEnv) {
  console.error("[bootstrap-seen] scraped Back-on-Track files missing");
  process.exit(1);
}

const operatorTrains = {};
for (const entry of registry) {
  if (!(entry.enabled && entry.synthetic && entry.output)) continue;
  operatorTrains[entry.id] = readEnvelope(entry.output)?.data?.trains ?? {};
}

const stats = {};
const payload = buildInitialData({
  stops: stopsEnv.data,
  viewMap: viewMapEnv.data,
  trips: tripsEnv.data,
  operatorTrains,
  registry,
  stats,
});

const today = new Date().toISOString().slice(0, 10);
const seen = {
  v: 1,
  updatedAt: new Date().toISOString(),
  routes: {},
  injectedStations: {},
};
for (const [key, route] of Object.entries(payload.viewMap)) {
  seen.routes[key] = {
    firstSeen: today,
    lastSeen: today,
    approved: true,
    fingerprint: fingerprintRoute(route),
  };
}
for (const name of stats.injectedStations ?? []) {
  seen.injectedStations[name] = { firstSeen: today, approved: true };
}

fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
fs.writeFileSync(SEEN_PATH, `${JSON.stringify(seen, null, 2)}\n`);
console.log(
  `[bootstrap-seen] wrote ${SEEN_PATH} — grandfathered ` +
    `${Object.keys(seen.routes).length} routes, ` +
    `${Object.keys(seen.injectedStations).length} injected stations (all approved)`,
);
