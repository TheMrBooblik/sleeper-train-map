// scripts/adapters/gtfs-sleeper.mjs
// Generic GTFS sleeper adapter: downloads an operator's official GTFS feed,
// filters it to a curated allowlist of routes that actually offer sleeping cars
// (GTFS doesn't flag sleeper service), and writes the standard per-source trains
// file. Those trains become synthetic map routes via the registry's `synthetic`
// config — the same path NightJet/Chinese/Italian use. Drives Amtrak + VIA Rail.
//
// Registry params:
//   feedUrl    GTFS .zip URL
//   configPath repo-relative JSON allowlist (array of route names, or { routes: [] })
//   agency     agency_id stamp (e.g. "AMTK")
//   operator   display operator name (e.g. "Amtrak")
//   canonicalizeStationNames
//              run every emitted stop name through the shared alias table.
//              Opt-in, because it only helps a feed whose stations are also in
//              Back-on-Track's table under another spelling: the enrichment
//              writes these names into via_*, and a via station only becomes a
//              map dot when a coordinate-bearing stop of that exact name
//              exists — SNCF's "Nice-Ville" has to become "Nice Ville" or the
//              stop is text on a page and nothing on the map. Left off for
//              Amtrak/VIA, whose stations are not in that table at all.
//
// Run a single source against an already-unpacked feed (skips download):
//   node -e "import('./scripts/adapters/gtfs-sleeper.mjs')" — see GTFS_DIR below.

import fs from "node:fs";
import path from "node:path";
import {
  downloadGtfs,
  loadGtfsDir,
  buildSleeperTrains,
  stationNameCanonicalizer,
} from "../lib/gtfs.mjs";
import { resolveCanonicalStationName } from "../../src/pages/api/lib/primitives.mjs";
import { runSncfOpenDataPass } from "../lib/sncf-open-data-pass.mjs";

function loadAllowlist(configPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.routes;
  if (!Array.isArray(list)) {
    throw new Error(`allowlist ${configPath} must be an array or { routes: [...] }`);
  }
  return list;
}

export async function run(entry, ctx) {
  const { feedUrl, configPath, agency, operator } = entry.params ?? {};
  if (!feedUrl || !configPath) {
    throw new Error(`${entry.id}: params.feedUrl and params.configPath are required`);
  }

  const allowlist = loadAllowlist(path.join(ctx.rootDir, configPath));
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);

  // Allow pointing at a pre-unpacked feed (CI re-use / debugging); otherwise
  // download + unzip into gtfs-data/, like the PKP/RegioJet parsers.
  const manualDir = process.env[`${entry.id.toUpperCase().replace(/-/g, "_")}_GTFS_DIR`];
  const gtfsDir = manualDir
    ? path.resolve(ctx.rootDir, manualDir)
    : path.join(ctx.rootDir, "gtfs-data", `${entry.id}-unpacked`);

  if (!manualDir) {
    log(`downloading ${feedUrl}`);
    await downloadGtfs(feedUrl, gtfsDir);
  }

  const gtfs = loadGtfsDir(gtfsDir);
  const stats = {};
  const trains = buildSleeperTrains({
    gtfs,
    allowlist,
    agency: agency || entry.synthetic?.agency?.value || entry.id,
    operator: operator || entry.label,
    log,
    stats,
    stationRenames: entry.synthetic?.stationRenames,
    canonicalizeName: stationNameCanonicalizer(
      entry.params,
      resolveCanonicalStationName,
    ),
  });

  const built = Object.keys(trains).length;

  // Freshness safety net: if the feed has routes but our curated allowlist
  // matched none of them, the feed's naming almost certainly drifted. Fail
  // loudly (recorded as a per-source error by the runner) so sticky-merge keeps
  // yesterday's data instead of silently publishing an empty operator.
  if (built === 0 && stats.feedRouteCount > 0) {
    throw new Error(
      `${entry.id}: 0 of ${stats.feedRouteCount} feed routes matched the allowlist — feed naming may have changed (unmatched: ${(stats.unmatched || []).join(", ")})`,
    );
  }

  // SNCF's own open data beside its timetable: fare ranges and punctuality
  // (scripts/lib/sncf-open-data-pass.mjs). Opt-in per entry, never fatal.
  if (entry.params?.openData) {
    await runSncfOpenDataPass(trains, { entry, ctx, gtfs, log });
  }

  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  log(`stored ${built} trains`);
}
