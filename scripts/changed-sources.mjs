// scripts/changed-sources.mjs
// Which registry sources does this branch actually change?
//
// Prints a comma-separated list of source ids for SCRAPE_ONLY, so a branch can
// refresh the data for what it touches and nothing else. Scraping everything
// would work too, but it buries the one thing under review in a whole night of
// unrelated upstream churn — and the point of running this on a branch is to be
// able to READ the diff before merging it.
//
// Three ways a branch touches a source, all read off the registry rather than
// hardcoded:
//   1. its entry in data/sources/registry.json changed (added, enabled, params
//      edited) — compared per id against the base ref, since a text diff of one
//      big JSON file cannot say whose entry moved;
//   2. its params.configPath changed — the curated allowlist is the source's
//      real input;
//   3. its adapter module changed — which selects every entry sharing it, the
//      way a gtfs-sleeper change touches Amtrak, VIA, SNCF and all three Entur
//      feeds at once.
//
// Silent about everything else: a change to the merge, the components or the
// tests needs no fetch. Empty output means "nothing to scrape", which the
// caller should treat as success, not as a failed detection.
//
// Usage:
//   node scripts/changed-sources.mjs                       # vs origin/main
//   node scripts/changed-sources.mjs --base origin/main
//   node scripts/changed-sources.mjs --files a.json,b.mjs --base-registry old.json

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./lib/registry.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/**
 * @param {Array} registry        current registry entries
 * @param {Array|null} baseRegistry  the same file at the base ref, or null when
 *                                unreadable — then rule 1 is skipped rather
 *                                than reporting every source as changed.
 * @param {string[]} changedFiles repo-relative paths
 */
export function changedSources(registry, baseRegistry, changedFiles) {
  const files = new Set((changedFiles || []).map((f) => f.trim()).filter(Boolean));
  const hit = new Set();

  const baseById = new Map(
    Array.isArray(baseRegistry) ? baseRegistry.map((e) => [e.id, e]) : [],
  );
  const canCompare = Array.isArray(baseRegistry);

  for (const entry of registry) {
    if (!entry.enabled) continue;

    if (canCompare) {
      const before = baseById.get(entry.id);
      if (JSON.stringify(before) !== JSON.stringify(entry)) hit.add(entry.id);
    }

    const configPath = entry.params?.configPath;
    if (configPath && files.has(configPath)) hit.add(entry.id);

    if (entry.adapter && files.has(`scripts/adapters/${entry.adapter}.mjs`)) {
      hit.add(entry.id);
    }
  }

  // Registry order, not discovery order: the runner's post-step reads sources
  // in registry order and one of them maintains another's input.
  return registry.filter((e) => hit.has(e.id)).map((e) => e.id);
}

function gitLines(command) {
  try {
    return execSync(command, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const base = arg("base", "origin/main");
  const registry = loadRegistry();

  const filesArg = arg("files");
  const changedFiles = filesArg
    ? filesArg.split(",")
    : gitLines(`git diff --name-only ${base}...HEAD`);

  const baseRegistryPath = arg("base-registry");
  let baseRegistry = null;
  try {
    const raw = baseRegistryPath
      ? fs.readFileSync(path.join(ROOT, baseRegistryPath), "utf8")
      : execSync(`git show ${base}:data/sources/registry.json`, {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
    const parsed = JSON.parse(raw);
    baseRegistry = Array.isArray(parsed) ? parsed : parsed?.sources;
  } catch {
    // A base ref we cannot read (shallow clone, first commit) leaves rule 1
    // off. Better to scrape the sources whose files changed than to claim
    // every source is new.
    console.error(`[changed-sources] could not read ${base}:data/sources/registry.json`);
  }

  const ids = changedSources(registry, baseRegistry, changedFiles);
  console.error(
    `[changed-sources] ${changedFiles.length} changed file(s) vs ${base} → ` +
      `${ids.length ? ids.join(", ") : "no source needs a fetch"}`,
  );
  process.stdout.write(ids.join(","));
}

if (process.argv[1] && process.argv[1].endsWith("changed-sources.mjs")) main();
