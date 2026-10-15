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
import { validateOperatorAgencies } from "./operator-agencies.mjs";

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
  "xml",
]);

const KNOWN_DEDUP_STRATEGIES = new Set(["exact", "icn"]);

const KNOWN_ENRICH_STRATEGIES = new Set(["trainsByNumber", "gtfsBundle"]);

// Every enrich option is a plain boolean or string the strategy reads by name,
// so a misspelled one does not fail — it silently means "off", which is the
// same failure mode the probe.pricing adapter typo had. Enumerate them.
const KNOWN_ENRICH_KEYS = new Set([
  "strategy",
  "agencyIds",
  "setPolyline",
  "polylineMode",
  "geometryFallback",
  "updateVia",
  "viaOnlyIfRicher",
  "setTimes",
  "updateEndpoints",
  "updateServiceDays",
  "stamp",
  "requireSameTrain",
]);

const KNOWN_SCHEDULES = new Set(["daily", "weekly", "manual"]);

export function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

// Trust config for the nightly classifier: routes from trusted sources are
// auto-approved (no review-queue gate). A route is trusted when its key starts
// with a trusted source's synthetic idPrefix, or when the scrape post-step
// stamped its row with official_sources containing a trusted source id.
export function trustConfig(registry) {
  const trusted = (registry ?? []).filter((e) => e?.enabled && e.trusted === true);
  return {
    sourceIds: new Set(trusted.map((e) => e.id)),
    prefixes: trusted.map((e) => e.synthetic?.idPrefix).filter(Boolean),
  };
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
  if (entry?.trusted != null && typeof entry.trusted !== "boolean") {
    errors.push(`${tag} trusted must be boolean`);
  }
  if (entry?.trusted === true && entry?.official !== true) {
    errors.push(`${tag} trusted sources must be official (trusted implies official:true)`);
  }
  if (entry?.schedule != null && !KNOWN_SCHEDULES.has(entry.schedule)) {
    errors.push(`${tag} unknown schedule "${entry.schedule}"`);
  }
  if (entry?.runner === "external" && !(typeof entry?.command === "string" && entry.command.trim())) {
    errors.push(`${tag} runner:"external" requires a non-empty command`);
  }

  // `endpoint` is the concrete thing this source reads — the URL you would open
  // to see the raw data (or a repo path, for the internal sources). It exists so
  // the integration dashboard can print the real address instead of a category
  // like "official API"; nothing in the scrape pipeline consumes it. Where the
  // adapter is already driven by a URL in params, the two must agree, so the
  // documentation cannot drift away from what the adapter actually fetches.
  for (const field of ["endpoint", "docsUrl"]) {
    if (entry?.[field] != null && !(typeof entry[field] === "string" && entry[field].trim())) {
      errors.push(`${tag} ${field} must be a non-empty string or null`);
    }
  }
  const paramUrl = entry?.params?.feedUrl ?? entry?.params?.baseUrl ?? null;
  if (paramUrl && entry?.endpoint && entry.endpoint !== paramUrl) {
    errors.push(`${tag} endpoint must match params.${entry?.params?.feedUrl ? "feedUrl" : "baseUrl"} ("${paramUrl}")`);
  }
  // Which carrier runs a train, read off the operator's own words
  // (scripts/lib/operator-agencies.mjs). A typo would quietly send every
  // partner train to its fallback carrier, so the mapping is checked here.
  if (entry?.params?.operatorAgencies != null) {
    for (const message of validateOperatorAgencies(entry.params.operatorAgencies)) {
      errors.push(`${tag} params.${message}`);
    }
  }

  const enrich = entry?.enrich;
  if (enrich != null) {
    if (!KNOWN_ENRICH_STRATEGIES.has(enrich.strategy)) {
      errors.push(`${tag} unknown enrich.strategy "${enrich?.strategy}"`);
    }
    if (enrich.agencyIds != null && !(Array.isArray(enrich.agencyIds) && enrich.agencyIds.every((a) => typeof a === "string" && a))) {
      errors.push(`${tag} enrich.agencyIds must be an array of non-empty strings`);
    }
    const unknown = Object.keys(enrich).filter((k) => !KNOWN_ENRICH_KEYS.has(k));
    if (unknown.length) {
      errors.push(`${tag} unknown enrich option(s): ${unknown.join(", ")}`);
    }
    if (enrich.viaOnlyIfRicher && !enrich.updateVia) {
      errors.push(`${tag} enrich.viaOnlyIfRicher guards updateVia, which is off`);
    }
  }

  // A price probe is wired by config alone: probe-prices.mjs dynamic-imports
  // probe.pricing.adapter inside a try/catch, so a typo in the module name
  // degrades to one warning in a continue-on-error workflow step and the probe
  // is simply never run. Validate it here, where the scrape refuses to start.
  const probePricing = entry?.probe?.pricing;
  if (probePricing != null) {
    if (!(typeof probePricing.adapter === "string" && probePricing.adapter.trim())) {
      errors.push(`${tag} probe.pricing.adapter must be a non-empty string`);
    }
    if (
      probePricing.sampleRoutes != null &&
      !(Number.isInteger(probePricing.sampleRoutes) && probePricing.sampleRoutes > 0)
    ) {
      errors.push(`${tag} probe.pricing.sampleRoutes must be a positive integer`);
    }
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
    if (
      synthetic.botMatchAgencies != null &&
      !(
        Array.isArray(synthetic.botMatchAgencies) &&
        synthetic.botMatchAgencies.every((a) => typeof a === "string" && a)
      )
    ) {
      errors.push(`${tag} synthetic.botMatchAgencies must be an array of non-empty strings`);
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

  // A carrier "published by" another source hands that source its trains; a
  // misspelt id would hand them to nobody, so the source must exist and be
  // another entry.
  for (const entry of registry) {
    for (const carrier of entry?.params?.operatorAgencies?.carriers ?? []) {
      const by = carrier?.publishedBy;
      if (typeof by !== "string" || !by) continue;
      if (by === entry.id) errors.push(`[${entry.id}] params.operatorAgencies: ${carrier.agency} is publishedBy the source itself`);
      else if (!ids.includes(by)) errors.push(`[${entry.id}] params.operatorAgencies: ${carrier.agency} publishedBy unknown source "${by}"`);
    }
  }

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
