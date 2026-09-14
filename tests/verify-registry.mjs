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
// get wrong is rule 3, and it WAS wrong: matching only the adapter's own file
// missed every change to the libraries the adapters import, which is where
// nearly all of the pipeline's logic lives. A branch that changed how SNCF's
// service days are read edited scripts/lib/gtfs.mjs, and the labelled run
// reported "Nothing to refresh".
{
  const {
    changedSources,
    moduleClosure,
    entryPointFor,
    sourceEntryModules,
    diskReader,
    specifiersIn,
  } = await import("../scripts/changed-sources.mjs");
  const enabled = registry.filter((e) => e.enabled);
  const same = JSON.parse(JSON.stringify(registry));
  const packageScripts =
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).scripts ?? {};
  const entryModules = sourceEntryModules(registry, {
    readFile: diskReader(),
    packageScripts,
  });
  const changed = (files) => changedSources(registry, same, files, entryModules);

  // ── The import closure, against a fixture rather than the repo ──
  {
    const files = {
      "scripts/adapters/fake.mjs": `
        import { a } from "../lib/one.mjs";
        import "./sibling.mjs";
        import data from "../../data/thing.json";
        import { x } from "node:fs";
        import { y } from "some-npm-package";
        /** @param {import("../lib/typed.mjs").T} t */
      `,
      "scripts/lib/one.mjs": `import { b } from "./two.mjs";`,
      // A cycle: two imports one back. The walk must terminate.
      "scripts/lib/two.mjs": `import { a } from "./one.mjs";\nimport { u } from "./gone.mjs";`,
      "scripts/lib/typed.mjs": "export const T = 1;",
      "scripts/adapters/sibling.mjs": "export const s = 1;",
      "data/thing.json": '{"k":1}',
      // Extensionless, the shape src/ uses.
      "src/lib/deep.js": "export const d = 1;",
    };
    const readFile = (p) => (p in files ? files[p] : null);

    const closure = moduleClosure("scripts/adapters/fake.mjs", readFile);
    const expected = [
      "data/thing.json",
      "scripts/adapters/fake.mjs",
      "scripts/adapters/sibling.mjs",
      "scripts/lib/one.mjs",
      "scripts/lib/two.mjs",
      "scripts/lib/typed.mjs",
    ];
    const got = [...closure].sort();
    if (got.join(",") !== expected.join(",")) {
      problems.push(`module closure: expected ${expected.join(",")}, got ${got.join(",")}`);
    }
    // node: and npm specifiers are not repo files; a missing one is skipped.
    for (const absent of ["node:fs", "some-npm-package", "scripts/lib/gone.mjs"]) {
      if (closure.has(absent)) problems.push(`closure must not contain ${absent}`);
    }

    // An extensionless specifier still resolves — src/ writes them that way.
    files["scripts/lib/one.mjs"] = `import { d } from "../../src/lib/deep";`;
    if (!moduleClosure("scripts/adapters/fake.mjs", readFile).has("src/lib/deep.js")) {
      problems.push("an extensionless specifier must resolve to its .js file");
    }

    // A specifier climbing out of the repo is not ours to follow.
    if (specifiersIn(`import x from "../../../outside.mjs";`).length !== 1) {
      problems.push("specifiersIn must read a relative specifier");
    }
    if (moduleClosure("scripts/adapters/fake.mjs", () => "import x from '../../../../x.mjs';").size !== 1) {
      problems.push("a specifier outside the repo must not be followed");
    }
  }

  // ── Where an entry's code starts ──
  {
    const cases = [
      [{ adapter: "gtfs-sleeper" }, "scripts/adapters/gtfs-sleeper.mjs"],
      [{ command: "npm run parse-pkp-gtfs" }, "scripts/parse-pkp-gtfs.js"],
      [{ command: "node scripts/one-off.mjs --flag" }, "scripts/one-off.mjs"],
      [{ command: "npm run nonexistent-script" }, null],
      [{}, null],
    ];
    for (const [entry, want] of cases) {
      const got = entryPointFor(entry, packageScripts);
      if (got !== want) {
        problems.push(`entryPointFor(${JSON.stringify(entry)}): expected ${want}, got ${got}`);
      }
    }
    // Every enabled entry must have a resolvable entry point, or its code is
    // invisible to the refresh the same way scripts/lib was.
    for (const entry of enabled) {
      if (!entryModules.get(entry.id)?.size) {
        problems.push(`${entry.id} reaches no module, so no code change can select it`);
      }
    }
  }

  const none = changed(["src/components/Map/DynamicMap.js"]);
  if (none.length) {
    problems.push(`a component-only change needs no scrape, got ${none.join(",")}`);
  }

  const viaAllowlist = changed(["data/sources/entur-vy-sleepers.json"]);
  if (viaAllowlist.join(",") !== "entur-vy") {
    problems.push(`an allowlist change selects its own source, got ${viaAllowlist.join(",")}`);
  }

  const viaAdapter = changed(["scripts/adapters/gtfs-sleeper.mjs"]);
  const sharing = enabled.filter((e) => e.adapter === "gtfs-sleeper").map((e) => e.id);
  if (viaAdapter.join(",") !== sharing.join(",")) {
    problems.push(
      `an adapter change must select every source sharing it: expected ${sharing.join(",")}, got ${viaAdapter.join(",")}`,
    );
  }

  // The regression. gtfs.mjs is imported by the adapter, not the registry, so
  // the old rule saw nothing here.
  const viaLibrary = changed(["scripts/lib/gtfs.mjs"]);
  for (const id of sharing) {
    if (!viaLibrary.includes(id)) {
      problems.push(`a scripts/lib/gtfs.mjs change must select ${id}, got ${viaLibrary.join(",")}`);
    }
  }
  if (!viaLibrary.includes("europeansleeper")) {
    problems.push("europeansleeper reads gtfs.mjs through its own adapter and must be selected");
  }
  // …and it must still be a selection, not a floodlight: a source that never
  // touches GTFS stays out.
  for (const id of ["nightjet", "cd", "backontrack"]) {
    if (viaLibrary.includes(id)) {
      problems.push(`${id} does not read gtfs.mjs and must not be selected`);
    }
  }

  // An external entry has no adapter at all; its code is the script it runs.
  const viaExternal = changed(["scripts/parse-pkp-gtfs.js"]);
  if (viaExternal.join(",") !== "pkp-gtfs") {
    problems.push(`the PKP parser must select pkp-gtfs, got ${viaExternal.join(",")}`);
  }

  // A registry entry that changed, with no file of its own touched.
  const edited = JSON.parse(JSON.stringify(registry));
  const target = edited.find((e) => e.enabled);
  target.freshness = { ...(target.freshness ?? {}), ttlHours: 999 };
  const viaEntry = changedSources(edited, registry, [], entryModules);
  if (!viaEntry.includes(target.id)) {
    problems.push(`an edited registry entry must select itself (${target.id})`);
  }

  // No base registry (shallow clone) must not claim every source is new.
  const noBase = changedSources(registry, null, ["README.md"], entryModules);
  if (noBase.length) {
    problems.push(`an unreadable base ref must select nothing, got ${noBase.join(",")}`);
  }

  // A disabled entry never gets scraped whatever changed under it.
  const disabled = registry.find((e) => !e.enabled);
  if (disabled) {
    const withDisabled = changedSources(
      registry,
      null,
      [...(entryModules.get(disabled.id) ?? []), disabled.params?.configPath].filter(Boolean),
      entryModules,
    );
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
