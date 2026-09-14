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
//   3. any module its code reaches changed — which selects every entry sharing
//      an adapter, the way a gtfs-sleeper change touches Amtrak, VIA, SNCF and
//      all three Entur feeds at once.
//
// Rule 3 used to match the adapter's own file and nothing else, and that made
// the mechanism miss most of what it exists to catch. A branch that fixed how
// SNCF's service days are read edited scripts/lib/gtfs.mjs — the library the
// adapter imports, where nearly all of the pipeline's logic lives — and the
// labelled run reported "Nothing to refresh" in 45 seconds. Every adapter but
// two imports shared modules, so the blind spot covered them all.
//
// So an entry's code is now its whole import closure: follow relative
// specifiers from its entry point until they stop resolving to repo files. A
// registry entry with `runner: "external"` has no adapter at all, and its
// closure starts at the script its `command` runs (resolved through
// package.json), which is how an edit to the PKP GTFS parser now selects
// pkp-gtfs.
//
// The walk reads specifiers with a regex rather than a parser, so it can also
// see one inside a comment or a JSDoc type. That is deliberate: the error it
// makes is to scrape a source that needed no fetch, and the error it avoids is
// to merge a pipeline change nobody could see run.
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

// What a specifier may leave out. "" first, because every specifier in
// scripts/ carries its extension already and only the src/ modules they reach
// into omit it.
const MODULE_EXTENSIONS = ["", ".mjs", ".js", ".json", ".jsx", "/index.mjs", "/index.js"];

// from "./x" | import "./x" | import("./x") | require("./x"), relative only —
// a bare specifier is an npm package, not a repo file. A template literal
// (`./adapters/${id}.mjs`) cannot be resolved without running the code, and the
// one place that shape occurs is the runner loading an adapter by id, which the
// entry point already covers.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

export function specifiersIn(source) {
  const out = [];
  for (const match of String(source).matchAll(SPECIFIER)) out.push(match[1]);
  return out;
}

/**
 * A specifier resolved to the repo-relative file it names, or null when it
 * names nothing we can read — a node builtin reached by a relative path, a
 * deleted module, an extension we do not list.
 *
 * @param {string} fromFile repo-relative path of the importing module
 * @param {string} spec     the specifier as written
 * @param {(relPath: string) => string|null} readFile
 */
export function resolveSpecifier(fromFile, spec, readFile) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  // A specifier climbing out of the repo is not ours to follow.
  if (base.startsWith("..")) return null;
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = base + ext;
    if (readFile(candidate) != null) return candidate;
  }
  return null;
}

/**
 * Every repo file an entry point reaches through relative imports, itself
 * included. Unreadable files are skipped rather than thrown on: a closure that
 * stops early still selects more than the entry point alone, while a throw
 * would take the whole mechanism down over one bad specifier.
 *
 * @param {string} entryPath repo-relative path
 * @param {(relPath: string) => string|null} readFile
 * @returns {Set<string>}
 */
export function moduleClosure(entryPath, readFile) {
  const seen = new Set();
  if (!entryPath) return seen;
  const queue = [path.posix.normalize(entryPath)];

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    const source = readFile(current);
    if (source == null) continue;
    seen.add(current);
    for (const spec of specifiersIn(source)) {
      const next = resolveSpecifier(current, spec, readFile);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * Where a registry entry's code starts. An adapter entry points at its module;
 * a `runner: "external"` entry has none, so its command is resolved through
 * package.json ("npm run parse-pkp-gtfs" → "node scripts/parse-pkp-gtfs.js").
 */
export function entryPointFor(entry, packageScripts = {}) {
  if (entry.adapter) return `scripts/adapters/${entry.adapter}.mjs`;
  if (!entry.command) return null;

  const npmRun = String(entry.command).match(/\bnpm\s+run\s+([\w:-]+)/);
  const command = npmRun ? String(packageScripts[npmRun[1]] ?? "") : String(entry.command);
  const script = command.match(/(?:^|\s)((?:\.\/)?(?:scripts|src)\/[^\s"']+\.(?:mjs|cjs|js))/);
  return script ? script[1].replace(/^\.\//, "") : null;
}

/**
 * Per source id, every repo file its code reaches. Built once so the closures
 * are walked once rather than per changed file.
 *
 * @param {Array} registry
 * @param {{ readFile: (relPath: string) => string|null, packageScripts?: object }} io
 * @returns {Map<string, Set<string>>}
 */
export function sourceEntryModules(registry, { readFile, packageScripts = {} }) {
  const byEntryPoint = new Map();
  const out = new Map();
  for (const entry of registry) {
    const entryPoint = entryPointFor(entry, packageScripts);
    if (!entryPoint) continue;
    if (!byEntryPoint.has(entryPoint)) {
      byEntryPoint.set(entryPoint, moduleClosure(entryPoint, readFile));
    }
    out.set(entry.id, byEntryPoint.get(entryPoint));
  }
  return out;
}

/**
 * @param {Array} registry        current registry entries
 * @param {Array|null} baseRegistry  the same file at the base ref, or null when
 *                                unreadable — then rule 1 is skipped rather
 *                                than reporting every source as changed.
 * @param {string[]} changedFiles repo-relative paths
 * @param {Map<string, Set<string>>} entryModules  per source, every file its code
 *                                lives in (sourceEntryModules). Required rather
 *                                than defaulted: a default that guesses narrowly
 *                                is how rule 3 came to miss scripts/lib in the
 *                                first place, and it would fail the same way
 *                                again — silently, reporting success.
 */
export function changedSources(registry, baseRegistry, changedFiles, entryModules) {
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

    for (const file of entryModules.get(entry.id) ?? []) {
      if (files.has(file)) {
        hit.add(entry.id);
        break;
      }
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

/** Repo-relative reader, memoised: resolution probes each candidate extension. */
export function diskReader(root = ROOT) {
  const cache = new Map();
  return (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    let text = null;
    try {
      const full = path.join(root, relPath);
      if (fs.statSync(full).isFile()) text = fs.readFileSync(full, "utf8");
    } catch {
      text = null;
    }
    cache.set(relPath, text);
    return text;
  };
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

  let packageScripts = {};
  try {
    packageScripts =
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {};
  } catch {
    console.error("[changed-sources] could not read package.json scripts");
  }

  const entryModules = sourceEntryModules(registry, {
    readFile: diskReader(),
    packageScripts,
  });

  const ids = changedSources(registry, baseRegistry, changedFiles, entryModules);
  console.error(
    `[changed-sources] ${changedFiles.length} changed file(s) vs ${base} → ` +
      `${ids.length ? ids.join(", ") : "no source needs a fetch"}`,
  );
  // "Nothing to scrape" is the answer you cannot check by reading it, and the
  // one that hid this script's own blind spot for a release: the run went green
  // in 45 seconds and said the branch touched no source, while the branch was
  // a change to the GTFS library eight sources read. So when the answer is
  // nothing, show the work — the files it weighed and how much code it knows.
  if (!ids.length && changedFiles.length) {
    const shown = changedFiles.slice(0, 20);
    console.error(
      `[changed-sources] none of these is source code or input: ${shown.join(", ")}` +
        (changedFiles.length > shown.length ? ` (+${changedFiles.length - shown.length} more)` : ""),
    );
    const reachable = new Set();
    for (const files of entryModules.values()) for (const f of files) reachable.add(f);
    console.error(
      `[changed-sources] ${reachable.size} file(s) across ${entryModules.size} source(s) would have counted.`,
    );
  }
  process.stdout.write(ids.join(","));
}

if (process.argv[1] && process.argv[1].endsWith("changed-sources.mjs")) main();
