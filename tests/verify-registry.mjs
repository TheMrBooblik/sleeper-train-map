// tests/verify-registry.mjs
// Validates data/sources/registry.json: entry shapes, unique ids/outputs,
// adapters resolve to real modules, ordering invariants.
// Run: npm run verify-registry

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRegistry,
  trustConfig,
  validateRegistry,
  validateRegistryEntry,
} from "../scripts/lib/registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = path.join(__dirname, "..", "scripts", "adapters");

const registry = loadRegistry();
const problems = validateRegistry(registry);

// Schema rejections for the trusted/enrich/external-runner fields.
const base = { v: 1, id: "x", label: "X", kind: "json-api", enabled: false };
const invalidEntries = [
  [{ ...base, trusted: true }, "trusted without official"],
  [{ ...base, trusted: "yes", official: true }, "non-boolean trusted"],
  [{ ...base, schedule: "hourly" }, "unknown schedule"],
  [{ ...base, runner: "external" }, "external runner without command"],
  [{ ...base, enrich: { strategy: "magic" } }, "unknown enrich strategy"],
  [
    { ...base, enrich: { strategy: "trainsByNumber", agencyIds: [""] } },
    "empty enrich agencyIds entry",
  ],
];
for (const [entry, label] of invalidEntries) {
  if (validateRegistryEntry(entry).length === 0) {
    problems.push(`validateRegistryEntry accepted invalid entry: ${label}`);
  }
}
if (
  validateRegistryEntry({
    ...base,
    official: true,
    trusted: true,
    schedule: "daily",
    enrich: { strategy: "gtfsBundle", agencyIds: ["PKP"] },
  }).length !== 0
) {
  problems.push("validateRegistryEntry rejected a valid trusted entry");
}

// trustConfig only picks up enabled trusted entries.
const trust = trustConfig([
  { id: "a", enabled: true, official: true, trusted: true, synthetic: { idPrefix: "a_" } },
  { id: "b", enabled: false, official: true, trusted: true, synthetic: { idPrefix: "b_" } },
  { id: "c", enabled: true, official: true, trusted: false },
]);
if (![...trust.sourceIds].every((id) => id === "a") || trust.sourceIds.size !== 1) {
  problems.push("trustConfig must include only enabled trusted entries");
}
if (trust.prefixes.join(",") !== "a_") {
  problems.push("trustConfig prefixes must come from enabled trusted synthetic entries");
}

// Every declared adapter must exist as a module.
for (const entry of registry) {
  if (!entry.adapter) continue;
  const file = path.join(ADAPTERS_DIR, `${entry.adapter}.mjs`);
  if (!fs.existsSync(file)) {
    problems.push(`[${entry.id}] adapter module missing: scripts/adapters/${entry.adapter}.mjs`);
  }
}

// static-config entries must point at an existing config file.
for (const entry of registry) {
  const configPath = entry.params?.configPath;
  if (!configPath) continue;
  if (!fs.existsSync(path.join(__dirname, "..", configPath))) {
    problems.push(`[${entry.id}] params.configPath missing: ${configPath}`);
  }
}

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-registry: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`verify-registry: ${registry.length} entries OK`);
