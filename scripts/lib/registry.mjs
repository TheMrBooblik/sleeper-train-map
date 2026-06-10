// scripts/lib/registry.mjs
// Loader + validator for the source registry (data/sources/registry.json).
// The registry is the single place that declares every data source: which
// adapter scrapes it, which file it writes, and how its trains merge into the
// map payload (synthetic config consumed by build-initial-data.mjs).
//
// Scripts read it from disk via loadRegistry(); API routes bundle it via
// `import ... with { type: "json" }` instead (Next.js doesn't trace fs reads).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "sources",
  "registry.json",
);

const KNOWN_KINDS = new Set([
  "backontrack",
  "json-api",
  "html",
  "gtfs",
  "static-config",
  "osm",
  "canonical-routes",
]);

const KNOWN_DEDUP_STRATEGIES = new Set(["exact", "icn"]);

export function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

// Pure: returns an array of human-readable problems (empty = valid).
export function validateRegistryEntry(entry) {
  const errors = [];
  const id = entry?.id;
  const tag = id ? `[${id}]` : "[<missing id>]";

  if (!id || typeof id !== "string") errors.push(`${tag} id must be a non-empty string`);
  if (!entry?.label) errors.push(`${tag} label is required`);
  if (!KNOWN_KINDS.has(entry?.kind)) errors.push(`${tag} unknown kind "${entry?.kind}"`);
  if (typeof entry?.enabled !== "boolean") errors.push(`${tag} enabled must be boolean`);
  if (entry?.adapter != null && typeof entry.adapter !== "string") {
    errors.push(`${tag} adapter must be a string or null`);
  }
  if (entry?.adapter == null && entry?.runner !== "external" && entry?.kind !== "canonical-routes") {
    if (entry?.enabled) errors.push(`${tag} enabled entry needs an adapter or runner:"external"`);
  }
  if (entry?.output != null && !/^[\w.-]+\.json$/.test(entry.output)) {
    errors.push(`${tag} output must be a bare .json filename`);
  }

  const synthetic = entry?.synthetic;
  if (synthetic != null) {
    if (!synthetic.idPrefix || typeof synthetic.idPrefix !== "string") {
      errors.push(`${tag} synthetic.idPrefix must be a non-empty string`);
    }
    const agency = synthetic.agency;
    if (agency?.from === "fixed") {
      if (!agency.value) errors.push(`${tag} synthetic.agency.value required when from:"fixed"`);
    } else if (agency?.from === "data") {
      if (!agency.fallback) errors.push(`${tag} synthetic.agency.fallback required when from:"data"`);
    } else {
      errors.push(`${tag} synthetic.agency.from must be "fixed" or "data"`);
    }
    if (synthetic.dedupStrategy != null && !KNOWN_DEDUP_STRATEGIES.has(synthetic.dedupStrategy)) {
      errors.push(`${tag} unknown dedupStrategy "${synthetic.dedupStrategy}"`);
    }
    if (!entry?.output) {
      errors.push(`${tag} synthetic entries must declare an output trains file`);
    }
  }

  return errors;
}

// Pure: cross-entry checks (uniqueness, ordering invariants).
export function validateRegistry(registry) {
  const errors = [];
  if (!Array.isArray(registry) || registry.length === 0) {
    return ["registry must be a non-empty array"];
  }

  registry.forEach((entry) => errors.push(...validateRegistryEntry(entry)));

  const ids = registry.map((e) => e?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push("duplicate entry ids");

  const outputs = registry.map((e) => e?.output).filter(Boolean);
  if (new Set(outputs).size !== outputs.length) errors.push("duplicate output filenames");

  // The runner executes entries in array order. Back-on-Track must come first:
  // the cd adapter reads its trips, and the post-step merges into its view map.
  const botIndex = registry.findIndex((e) => e?.kind === "backontrack");
  if (botIndex === -1) {
    errors.push("registry must contain a backontrack entry");
  } else {
    if (!registry[botIndex].critical) {
      errors.push("backontrack entry must be critical (everything depends on it)");
    }
    registry.forEach((entry, i) => {
      if (i < botIndex && entry?.enabled && (entry?.synthetic || entry?.kind === "html")) {
        errors.push(`[${entry.id}] must come after backontrack in the registry`);
      }
    });
  }

  return errors;
}
