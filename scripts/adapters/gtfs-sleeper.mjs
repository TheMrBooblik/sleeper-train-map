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
//
// Run a single source against an already-unpacked feed (skips download):
//   node -e "import('./scripts/adapters/gtfs-sleeper.mjs')" — see GTFS_DIR below.

import fs from "node:fs";
import path from "node:path";
import { downloadGtfs, loadGtfsDir, buildSleeperTrains } from "../lib/gtfs.mjs";

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
  const trains = buildSleeperTrains({
    gtfs,
    allowlist,
    agency: agency || entry.synthetic?.agency?.value || entry.id,
    operator: operator || entry.label,
    log,
  });

  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  log(`stored ${Object.keys(trains).length} trains`);
}
