// scripts/classify-changes.mjs
// Nightly step (after scrape + canonicalize): builds the un-gated payload,
// classifies changes against data/canonical/state/seen.json, files proposals
// on the `proposals` branch, and persists the updated seen index (committed
// by the workflow's auto-commit step).
//
// Failure semantics: if any proposal fails to land on GitHub, the seen index
// is NOT written — the whole classification simply re-runs next night (open
// proposals are deduped via their filenames). This guarantees nothing is ever
// gated without a matching queue item the admin can approve.
//
// Run with: node scripts/classify-changes.mjs  (needs GITHUB_TOKEN to file
// proposals; without it the script only reports what it would do.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialData } from "../src/pages/api/lib/build-initial-data.mjs";
import {
  PENDING_DIR,
  encodeProposalFilename,
  parseProposalFilename,
} from "../src/pages/api/lib/proposals.mjs";
import {
  ensureBranch,
  isGithubWriteConfigured,
  listDir,
  proposalsBranch,
  putJsonFile,
  repoSlug,
} from "../src/pages/api/lib/github-content.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { classify } from "./lib/classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRAPED_DIR = path.join(ROOT, "public", "data", "scraped");
const SEEN_PATH = path.join(ROOT, "data", "canonical", "state", "seen.json");

function readEnvelope(name) {
  try {
    const envelope = JSON.parse(
      fs.readFileSync(path.join(SCRAPED_DIR, name), "utf8"),
    );
    return envelope?.uploadedAt ? envelope : null;
  } catch {
    return null;
  }
}

function readSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Build the un-gated payload + stats from the scraped files (same inputs as
// canonicalize, but without the seen gate so new entities are visible here).
function buildCandidate(registry) {
  const stopsEnv = readEnvelope("backontrack-stops.json");
  const viewMapEnv = readEnvelope("backontrack-view_ontd_map.json");
  const tripsEnv = readEnvelope("backontrack-trips.json");
  if (!stopsEnv || !viewMapEnv || !tripsEnv) {
    throw new Error("scraped Back-on-Track files missing — run the scrape first");
  }
  const operatorTrains = {};
  for (const entry of registry) {
    if (!(entry.enabled && entry.synthetic && entry.output)) continue;
    operatorTrains[entry.id] = readEnvelope(entry.output)?.data?.trains ?? {};
  }
  const stats = {};
  const payload = buildInitialData({
    stops: stopsEnv.data,
    viewMap: viewMapEnv.data,
    trips: tripsEnv.data,
    operatorTrains,
    registry,
    stats,
  });
  return { payload, stats };
}

async function main() {
  const registry = loadRegistry();
  const previousSeen = readSeen();
  if (!previousSeen) {
    console.error(
      "[classify] data/canonical/state/seen.json missing — run scripts/bootstrap-seen.mjs once first",
    );
    process.exit(1);
  }

  const { payload, stats } = buildCandidate(registry);

  const githubReady = isGithubWriteConfigured();
  const slug = repoSlug();
  const branch = proposalsBranch();

  // Dedup against open proposals: targets are deterministic, so we encode the
  // dedup key into the proposal id itself (stable per kind+target) — checking
  // open filenames is then a single directory listing.
  let openKeys = new Set();
  if (githubReady) {
    try {
      const listing = await listDir(slug, branch, PENDING_DIR);
      if (!listing.error) {
        for (const entry of listing.entries) {
          const meta = parseProposalFilename(entry.name);
          if (meta) openKeys.add(`${meta.kind}:${meta.id}`);
        }
      }
    } catch (err) {
      console.warn(`[classify] could not list open proposals: ${err.message}`);
    }
  }

  const result = classify({
    previousSeen,
    viewMap: payload.viewMap,
    injectedStations: stats.injectedStations ?? [],
    // Dedup happens below on stable target-derived ids, not inside classify.
    openProposalKeys: new Set(),
  });

  // Stable, target-derived ids so re-running can't duplicate open proposals.
  const withIds = result.proposals.map((p) => {
    const target = p.target.routeKey || p.target.stationName || "general";
    const stable = `p_${target.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    return { ...p, id: stable };
  });
  const newProposals = withIds.filter((p) => !openKeys.has(`${p.kind}:${p.id}`));

  console.log(
    `[classify] routes: ${Object.keys(payload.viewMap).length} seen, ` +
      `${result.gatedRouteKeys.length} gated; proposals: ${withIds.length} ` +
      `(${withIds.length - newProposals.length} already open, ${result.droppedProposals} dropped by cap)`,
  );

  if (!githubReady && newProposals.length > 0) {
    console.warn(
      `[classify] GITHUB_TOKEN not configured — ${newProposals.length} proposal(s) NOT filed; ` +
        "seen index left untouched so this retries next run:",
    );
    newProposals.forEach((p) => console.warn(`  - [${p.kind}] ${p.title}`));
    return;
  }

  let allLanded = true;
  if (newProposals.length > 0) {
    const branchReady = await ensureBranch(slug, branch, "main");
    if (branchReady.error) throw new Error(`Failed to ${branchReady.error}`);

    for (const proposal of newProposals) {
      const filename = encodeProposalFilename(proposal);
      const put = await putJsonFile(
        slug,
        branch,
        `${PENDING_DIR}/${filename}`,
        proposal,
        `chore(classify): ${proposal.kind} ${proposal.id}`,
      );
      if (put.error) {
        // 422 with existing content = already there (race) — treat as landed.
        console.error(`[classify] failed to ${put.error}`);
        allLanded = false;
        break;
      }
      console.log(`[classify] filed ${proposal.kind}: ${proposal.title}`);
    }
  }

  if (!allLanded) {
    console.error(
      "[classify] proposal filing incomplete — seen index NOT updated (will retry next run)",
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
  fs.writeFileSync(SEEN_PATH, `${JSON.stringify(result.nextSeen, null, 2)}\n`);
  console.log(
    `[classify] seen index updated — ${Object.keys(result.nextSeen.routes).length} routes, ` +
      `${Object.keys(result.nextSeen.injectedStations).length} injected stations tracked`,
  );
}

main().catch((err) => {
  console.error("[classify] fatal:", err);
  process.exit(1);
});
