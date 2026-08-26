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
import { emptyGeometryCache, resolveRouteGeometry } from "./lib/route-geometry.mjs";
import { relationCoordsFromOverpass } from "../src/pages/api/lib/osm-geo.mjs";

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
// Operator APIs are flaky, so we guard against a whole-source outage: if a
// per-source fetch comes back EMPTY tonight, we keep yesterday's entries live
// for up to 7 days (stamped lastSeenAt) rather than blanking the map.
//
// But a fetch that returned trains is authoritative: any train missing from a
// healthy fetch has genuinely been withdrawn, so we drop it immediately to stay
// up to date (this is how seasonal trains like NJ 284 — gone from the ÖBB API
// but still on our map — used to linger for a week). Trade-off: a rare per-train
// detail hiccup on an otherwise-healthy night drops that train for one night.

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

  // Only fall back to the sticky window on a total outage (empty fetch). A
  // healthy fetch is trusted as the current truth, so vanished trains drop now.
  const fetchHealthy = Object.keys(data.trains).length > 0;

  let retained = 0;
  if (!fetchHealthy) {
    for (const [key, train] of Object.entries(prevTrains)) {
      if (key in merged) continue;
      const lastSeen = train.lastSeenAt || prevUploadedAt;
      if (lastSeen && Date.now() - Date.parse(lastSeen) <= STICKY_RETAIN_MS) {
        merged[key] = { ...train, lastSeenAt: lastSeen };
        retained++;
      }
    }
  }
  if (retained > 0) {
    console.log(`[scrape] ${filename}: source empty tonight — retained ${retained} train(s) from the last good fetch`);
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

async function finalizeViewMap(ctx, registry) {
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

  // BoT station-name → coords, for geometry-fallback stop lists.
  const coordIndex = new Map();
  for (const stop of Object.values(ctx.shared.stops ?? {})) {
    if (!stop?.stop_name || !Number.isFinite(stop?.stop_lat) || !Number.isFinite(stop?.stop_lon)) continue;
    const k = stop.stop_name.toLowerCase().trim();
    if (!coordIndex.has(k)) coordIndex.set(k, { lat: stop.stop_lat, lon: stop.stop_lon });
  }
  const stopCoords = (name) => coordIndex.get((name ?? "").toLowerCase().trim()) ?? null;

  // OSM-backed geometry resolver over the shared hash-gated cache (committed
  // as route-geometry.json — only regenerates when a stop list changed).
  const cache = readJson("public/data/scraped/route-geometry.json")?.data ?? emptyGeometryCache();
  const resolveGeometry = (args) =>
    resolveRouteGeometry({
      ...args,
      cache,
      readScrapedRelation: (id) => {
        const raw = readJson(`public/data/scraped/osm-${id}.json`);
        return raw ? relationCoordsFromOverpass(raw.data, id) : null;
      },
      log: (msg) => log(`route-geometry ${msg}`),
    });

  await enrichViewMap({
    registry,
    viewMap: view_ontd_map,
    getTrains,
    readJson,
    stopCoords,
    resolveGeometry,
    log,
  });
  write("route-geometry.json", cache);

  for (const entry of registry) {
    if (!entry.enabled || entry.enrich?.strategy !== "trainsByNumber" || !entry.synthetic) continue;
    appendSyntheticLeftovers({ entry, viewMap: view_ontd_map, trains: getTrains(entry), log });
  }

  write("backontrack-view_ontd_map.json", view_ontd_map);
}

// ─── Source health log ──────────────────────────────────────────────────────
// The runner has always collected per-source errors and then thrown them away
// on exit, which is why "last failed fetch" existed nowhere. Persist them
// instead, merged with the previous file so the history survives a night where
// a source did not run at all (weekly steps, or a source turned off in the
// registry). Read by /api/admin/integrations; committed by the daily workflow
// along with everything else under public/data/scraped/.

function writeSourceHealth(registry, results, runStartedAt) {
  let previous = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "source-health.json"), "utf8"));
    previous = raw?.data?.sources ?? {};
  } catch {
    previous = {};
  }

  const nowIso = new Date().toISOString();
  const sources = { ...previous };
  for (const entry of registry) {
    const result = results[entry.id];
    const prior = previous[entry.id] ?? {};
    if (!result) {
      // Not run tonight (disabled, or not scheduled) — carry the record forward
      // untouched rather than inventing a success or a failure.
      sources[entry.id] = { ...prior, enabled: !!entry.enabled };
      continue;
    }
    sources[entry.id] = {
      enabled: !!entry.enabled,
      lastRunAt: nowIso,
      lastSuccessAt: result.ok ? nowIso : (prior.lastSuccessAt ?? null),
      lastFailureAt: result.ok ? (prior.lastFailureAt ?? null) : nowIso,
      lastError: result.ok ? (prior.lastError ?? null) : result.error,
      trainCount: result.trainCount ?? prior.trainCount ?? null,
      consecutiveFailures: result.ok ? 0 : (prior.consecutiveFailures ?? 0) + 1,
    };
  }

  write("source-health.json", { runStartedAt, runFinishedAt: nowIso, sources });
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
  const runStartedAt = new Date().toISOString();

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

  const results = {};
  const trainCountFor = (entry) =>
    entry.output && writtenTrains[entry.output]
      ? Object.keys(writtenTrains[entry.output]).length
      : null;

  for (const entry of registry) {
    if (!entry.enabled) continue;
    if (entry.adapter) {
      try {
        const mod = await import(`./adapters/${entry.adapter}.mjs`);
        await mod.run(entry, ctx);
        results[entry.id] = { ok: true, trainCount: trainCountFor(entry) };
      } catch (err) {
        results[entry.id] = { ok: false, error: err.message };
        if (entry.critical) {
          writeSourceHealth(registry, results, runStartedAt);
          throw err;
        }
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
        results[entry.id] = { ok: true, trainCount: null };
      } catch (err) {
        results[entry.id] = { ok: false, error: err.message };
        errors.push({ source: entry.id, error: err.message });
        console.error(`[scrape] ${entry.id} failed: ${err.message}`);
      }
    }
  }

  await finalizeViewMap(ctx, registry);
  writeSourceHealth(registry, results, runStartedAt);

  console.log(`[scrape] done. errors: ${errors.length}`);
  if (errors.length) console.error("[scrape] errors:", errors);
}

main().catch((err) => {
  console.error("[scrape] fatal:", err);
  process.exit(1);
});
