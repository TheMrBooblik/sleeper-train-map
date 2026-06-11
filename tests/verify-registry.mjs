// tests/verify-registry.mjs
// Validates data/sources/registry.json: entry shapes, unique ids/outputs,
// adapters resolve to real modules, ordering invariants.
// Run: npm run verify-registry

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateRegistry } from "../scripts/lib/registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = path.join(__dirname, "..", "scripts", "adapters");

const registry = loadRegistry();
const problems = validateRegistry(registry);

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
