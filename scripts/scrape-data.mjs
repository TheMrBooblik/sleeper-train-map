// scripts/scrape-data.mjs
// Registry-driven scrape runner: iterates data/sources/registry.json in order,
// running each enabled entry's adapter (scripts/adapters/{adapter}.mjs) and
// writing the per-source files to public/data/scraped/.
//
// Adding a data source = adding a registry entry (+ an adapter module only if
// no existing adapter kind fits). No per-operator code in this file.
//
// Run with: node scripts/scrape-data.mjs

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateRegistry } from "./lib/registry.mjs";
import { enrichViewMap, appendSyntheticLeftovers } from "./lib/enrich-view-map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "public", "data", "scraped");

function write(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify({ uploadedAt: new Date().toISOString(), data }),
  );
  console.log(`[scrape] wrote ${filename}`);
}

// ─── Sticky trains merge ────────────────────────────────────────────────────
// Operator APIs are flaky: a train missing from one night's fetch is usually
// an upstream hiccup, not a discontinued service. For per-source trains files
// we retain yesterday's entries for up to 7 days (stamped lastSeenAt) before
// letting them drop — the classifier files an FYI when one really goes away.

const STICKY_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

function stickyMergeTrains(filename, data) {
  if (!data || typeof data !== "object" || !data.trains) return data;

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), "utf8"));
  } catch {
    return stampLastSeen(data);
  }

  const prevTrains = previous?.data?.trains ?? {};
  const prevUploadedAt = previous?.uploadedAt ?? null;
  const nowIso = new Date().toISOString();
  const merged = {};

  for (const [key, train] of Object.entries(data.trains)) {
    merged[key] = { ...train, lastSeenAt: nowIso };
  }
  let retained = 0;
  for (const [key, train] of Object.entries(prevTrains)) {
    if (key in merged) continue;
    const lastSeen = train.lastSeenAt || prevUploadedAt;
    if (lastSeen && Date.now() - Date.parse(lastSeen) <= STICKY_RETAIN_MS) {
      merged[key] = { ...train, lastSeenAt: lastSeen };
      retained++;
    }
  }
  if (retained > 0) {
    console.log(`[scrape] ${filename}: retained ${retained} train(s) missing from tonight's fetch`);
  }
  return { ...data, trains: merged };
}

function stampLastSeen(data) {
  const nowIso = new Date().toISOString();
  const trains = {};
  for (const [key, train] of Object.entries(data.trains)) {
    trains[key] = { ...train, lastSeenAt: nowIso };
  }
  return { ...data, trains };
}

// ─── Post-step: official-source ⇄ Back-on-Track view map merge ──────────────
// Runs after all adapters: applies every registry entry's `enrich` config to
// the BoT view map (polylines, official stop lists, official_sources stamps —
// see scripts/lib/enrich-view-map.mjs), adds synthetic rows for official
// trains BoT doesn't know about, then writes the final
// backontrack-view_ontd_map.json. (The build step recreates synthetic rows
// from the trains files anyway; this keeps the committed raw file
// self-contained for the GitHub-fallback serving path.)

function finalizeViewMap(ctx, registry) {
  const view_ontd_map = ctx.shared.viewMap;
  if (!view_ontd_map) return; // backontrack is critical — we never get here without it

  // Trains as persisted tonight (incl. sticky-retained); on adapter outage the
  // last committed file keeps enrichment alive.
  const getTrains = (entry) => {
    if (ctx.writtenTrains[entry.output]) return ctx.writtenTrains[entry.output];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, entry.output), "utf8"));
      return raw?.data?.trains ?? {};
    } catch {
      return {};
    }
  };
  const readJson = (relPath) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relPath), "utf8"));
    } catch {
      return null;
    }
  };
  const log = (msg) => console.log(`[scrape] ${msg}`);

  enrichViewMap({ registry, viewMap: view_ontd_map, getTrains, readJson, log });

  for (const entry of registry) {
    if (!entry.enabled || entry.enrich?.strategy !== "trainsByNumber" || !entry.synthetic) continue;
    appendSyntheticLeftovers({ entry, viewMap: view_ontd_map, trains: getTrains(entry), log });
  }

  write("backontrack-view_ontd_map.json", view_ontd_map);
}

// Whether a scheduled external entry runs tonight (mirrors the old workflow
// conditions: weekly = Mondays, or any manual workflow_dispatch / forced run).
function shouldRunToday(schedule) {
  if (schedule === "manual") return false;
  if (schedule === "weekly") {
    return (
      new Date().getUTCDay() === 1 ||
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
      process.env.FORCE_ALL_SOURCES === "1"
    );
  }
  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const registry = loadRegistry();
  const problems = validateRegistry(registry);
  if (problems.length) {
    problems.forEach((p) => console.error(`[scrape] registry: ${p}`));
    throw new Error("invalid source registry");
  }

  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  // Per-source trains files get the sticky merge; raw datasets write as-is.
  // The merged result is exposed on ctx.writtenTrains so adapters/post-steps
  // operate on exactly what was persisted (including retained trains).
  const stickyFiles = new Set(
    registry.filter((e) => e.enabled && e.output).map((e) => e.output),
  );
  const writtenTrains = {};
  const writeWithSticky = (filename, data) => {
    const finalData = stickyFiles.has(filename)
      ? stickyMergeTrains(filename, data)
      : data;
    if (finalData?.trains) writtenTrains[filename] = finalData.trains;
    write(filename, finalData);
  };

  const ctx = {
    today,
    write: writeWithSticky,
    writtenTrains,
    errors,
    shared: {},
    rootDir: ROOT_DIR,
  };

  console.log(`[scrape] starting — date: ${today}`);

  for (const entry of registry) {
    if (!entry.enabled) continue;
    if (entry.adapter) {
      try {
        const mod = await import(`./adapters/${entry.adapter}.mjs`);
        await mod.run(entry, ctx);
      } catch (err) {
        if (entry.critical) throw err;
        errors.push({ source: entry.id, error: err.message });
        console.error(`[scrape] ${entry.id} failed: ${err.message}`);
      }
    } else if (entry.runner === "external" && entry.command) {
      // Registry-scheduled external steps (e.g. the PKP GTFS parse) run inside
      // the scrape so their artifacts are fresh before the enrichment post-step.
      if (!shouldRunToday(entry.schedule)) {
        console.log(`[scrape] ${entry.id}: not scheduled today (${entry.schedule}) — skipped`);
        continue;
      }
      try {
        console.log(`[scrape] ${entry.id}: running "${entry.command}"`);
        execSync(entry.command, { cwd: ROOT_DIR, stdio: "inherit", timeout: 15 * 60 * 1000 });
      } catch (err) {
        errors.push({ source: entry.id, error: err.message });
        console.error(`[scrape] ${entry.id} failed: ${err.message}`);
      }
    }
  }

  finalizeViewMap(ctx, registry);

  console.log(`[scrape] done. errors: ${errors.length}`);
  if (errors.length) console.error("[scrape] errors:", errors);
}

main().catch((err) => {
  console.error("[scrape] fatal:", err);
  process.exit(1);
});
