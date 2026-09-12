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
  // An enrich option is read by name, so a misspelling silently means "off" —
  // the same failure mode probe.pricing.adapter had.
  [
    { ...base, enrich: { strategy: "trainsByNumber", updateVai: true } },
    "misspelled enrich option",
  ],
  [
    { ...base, enrich: { strategy: "trainsByNumber", viaOnlyIfRicher: true } },
    "viaOnlyIfRicher guarding an updateVia that is off",
  ],
  [{ ...base, endpoint: "" }, "empty endpoint string"],
  [
    { ...base, endpoint: "https://a.example/feed.zip", params: { feedUrl: "https://b.example/feed.zip" } },
    "endpoint drifted from params.feedUrl",
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

// Every enabled source must name the concrete address it reads, so the
// integration dashboard can print it instead of a category ("official API").
for (const entry of registry) {
  if (!entry.enabled) continue;
  if (!entry.endpoint) {
    problems.push(`[${entry.id}] enabled entry must declare an endpoint`);
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

// ─── SCRAPE_ONLY selection ──────────────────────────────────────────────────
// The filter that lets a branch scrape one source and show the result in its
// own preview instead of being reviewed after a merge. Two properties matter
// and neither is obvious from reading it: a name that is not in the registry
// must be reported rather than silently producing an empty run (which reads
// identically to "that source found nothing tonight"), and an unset variable
// must mean *all* sources, since the nightly job sets nothing.
{
  const { selectSources } = await import("../scripts/scrape-data.mjs");
  const ids = (sel) => sel.sources.map((e) => e.id);

  for (const unset of [undefined, "", "  ", ",, ,"]) {
    const sel = selectSources(registry, unset);
    if (sel.filtered || sel.sources.length !== registry.length) {
      problems.push(`SCRAPE_ONLY=${JSON.stringify(unset)} must run every source`);
    }
  }

  const one = selectSources(registry, " entur-vy ");
  if (ids(one).join(",") !== "entur-vy" || !one.filtered) {
    problems.push(`SCRAPE_ONLY=entur-vy selected ${ids(one).join(",")}`);
  }

  const three = selectSources(registry, "entur-vy,entur-sjn, entur-goa");
  if (ids(three).join(",") !== "entur-vy,entur-sjn,entur-goa") {
    problems.push(`a three-source filter selected ${ids(three).join(",")}`);
  }

  const typo = selectSources(registry, "entur-vy,entur-vyg");
  if (typo.unknown.join(",") !== "entur-vyg") {
    problems.push(`an unknown id must be reported, got ${JSON.stringify(typo.unknown)}`);
  }
  if (ids(typo).join(",") !== "entur-vy") {
    problems.push(`an unknown id must not change the selection, got ${ids(typo).join(",")}`);
  }

  // Selection order follows the registry, not the variable: the runner's
  // post-step reads each source's trains in registry order and pkp-plk runs
  // after pkp-gtfs regenerates the bundle.
  const reversed = selectSources(registry, "entur-goa,entur-vy");
  if (ids(reversed).join(",") !== "entur-vy,entur-goa") {
    problems.push(`selection must keep registry order, got ${ids(reversed).join(",")}`);
  }
}

// ─── Which sources a branch touches ─────────────────────────────────────────
// The default the branch-refresh workflow runs on. The rule that is easy to
// get wrong is the adapter one: a gtfs-sleeper edit touches six operators at
// once, and refreshing only the one whose allowlist changed would leave the
// other five unverified against the change that broke them.
{
  const { changedSources } = await import("../scripts/changed-sources.mjs");
  const enabled = registry.filter((e) => e.enabled);
  const same = JSON.parse(JSON.stringify(registry));

  const none = changedSources(registry, same, ["src/components/Map/DynamicMap.js"]);
  if (none.length) {
    problems.push(`a component-only change needs no scrape, got ${none.join(",")}`);
  }

  const viaAllowlist = changedSources(registry, same, [
    "data/sources/entur-vy-sleepers.json",
  ]);
  if (viaAllowlist.join(",") !== "entur-vy") {
    problems.push(`an allowlist change selects its own source, got ${viaAllowlist.join(",")}`);
  }

  const viaAdapter = changedSources(registry, same, ["scripts/adapters/gtfs-sleeper.mjs"]);
  const sharing = enabled
    .filter((e) => e.adapter === "gtfs-sleeper")
    .map((e) => e.id);
  if (viaAdapter.join(",") !== sharing.join(",")) {
    problems.push(
      `an adapter change must select every source sharing it: expected ${sharing.join(",")}, got ${viaAdapter.join(",")}`,
    );
  }

  // A registry entry that changed, with no file of its own touched.
  const edited = JSON.parse(JSON.stringify(registry));
  const target = edited.find((e) => e.enabled);
  target.freshness = { ...(target.freshness ?? {}), ttlHours: 999 };
  const viaEntry = changedSources(edited, registry, []);
  if (!viaEntry.includes(target.id)) {
    problems.push(`an edited registry entry must select itself (${target.id})`);
  }

  // No base registry (shallow clone) must not claim every source is new.
  const noBase = changedSources(registry, null, ["README.md"]);
  if (noBase.length) {
    problems.push(`an unreadable base ref must select nothing, got ${noBase.join(",")}`);
  }

  // A disabled entry never gets scraped whatever changed under it.
  const disabled = registry.find((e) => !e.enabled);
  if (disabled) {
    const withDisabled = changedSources(registry, null, [
      disabled.params?.configPath ?? `scripts/adapters/${disabled.adapter}.mjs`,
    ]);
    if (withDisabled.includes(disabled.id)) {
      problems.push(`a disabled source must not be scraped (${disabled.id})`);
    }
  }
}

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-registry: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`verify-registry: ${registry.length} entries OK`);
