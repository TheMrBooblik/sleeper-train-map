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
import { fileURLToPath } from "node:url";
import { loadRegistry, validateRegistry } from "./lib/registry.mjs";

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

// ─── Post-step: NightJet ⇄ Back-on-Track view map merge ────────────────────
// Runs after all adapters: merges official NJ polylines into the BoT view map
// and adds synthetic rows for NJ/EN trains BoT doesn't know about, then writes
// the final backontrack-view_ontd_map.json. (The build step recreates synthetic
// rows from nightjet-trains.json anyway; this keeps the committed raw file
// self-contained for the GitHub-fallback serving path.)

function finalizeViewMap(ctx) {
  const view_ontd_map = ctx.shared.viewMap;
  if (!view_ontd_map) return; // backontrack is critical — we never get here without it

  const njTrains = ctx.shared.njTrains ?? {};

  // Merge NJ polylines into view_ontd_map
  Object.values(view_ontd_map).forEach((route) => {
    const names = [route.trip_short_name_0, route.trip_short_name_1].filter(Boolean);
    for (const name of names) {
      const match = njTrains[name.trim()];
      if (match?.polyline) {
        route.nj_polyline = match.polyline;
        break;
      }
    }
  });

  // Synthetic routes for NJ trains not in Back-on-Track
  const botMatchedNJNumbers = new Set();
  Object.values(view_ontd_map).forEach((route) => {
    [route.trip_short_name_0, route.trip_short_name_1]
      .filter(Boolean)
      .forEach((n) => botMatchedNJNumbers.add(n.trim()));
  });

  const unmatchedNJ = Object.entries(njTrains).filter(
    ([lineName, data]) =>
      !botMatchedNJNumbers.has(lineName) && data.polyline && data.stations?.length >= 2,
  );

  const syntheticPaired = new Set();
  unmatchedNJ.forEach(([lineName, data]) => {
    if (syntheticPaired.has(lineName)) return;

    const origin = data.stations[0].name;
    const dest = data.stations[data.stations.length - 1].name;

    const reversePair = unmatchedNJ.find(
      ([k, v]) =>
        k !== lineName &&
        !syntheticPaired.has(k) &&
        v.stations?.[0]?.name === dest &&
        v.stations?.[v.stations.length - 1]?.name === origin,
    );

    const safeId = lineName.replace(/\s+/g, "_");
    const entry = {
      route_id: `nj_standalone_${safeId}`,
      agency_id: "ÖBB",
      trip_short_name_0: lineName,
      origin_trip_0: origin,
      destination_trip_0: dest,
      via_0: data.stations.slice(1, -1).map((s) => s.name).join(" - "),
      route_long_name: `${origin} – ${dest}`,
      nj_polyline: data.polyline,
      is_active: "Y",
    };

    if (reversePair) {
      const [revName, revData] = reversePair;
      entry.trip_short_name_1 = revName;
      entry.origin_trip_1 = revData.stations[0].name;
      entry.destination_trip_1 = revData.stations[revData.stations.length - 1].name;
      entry.via_1 = revData.stations.slice(1, -1).map((s) => s.name).join(" - ");
      syntheticPaired.add(revName);
    }

    syntheticPaired.add(lineName);
    view_ontd_map[entry.route_id] = entry;
    console.log(`[scrape] synthetic route: ${entry.route_id} (${origin} – ${dest})`);
  });

  write("backontrack-view_ontd_map.json", view_ontd_map);
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
    if (!entry.enabled || !entry.adapter) continue;
    try {
      const mod = await import(`./adapters/${entry.adapter}.mjs`);
      await mod.run(entry, ctx);
    } catch (err) {
      if (entry.critical) throw err;
      errors.push({ source: entry.id, error: err.message });
      console.error(`[scrape] ${entry.id} failed: ${err.message}`);
    }
  }

  finalizeViewMap(ctx);

  console.log(`[scrape] done. errors: ${errors.length}`);
  if (errors.length) console.error("[scrape] errors:", errors);
}

main().catch((err) => {
  console.error("[scrape] fatal:", err);
  process.exit(1);
});
