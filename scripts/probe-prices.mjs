// scripts/probe-prices.mjs
// Weekly price probe runner: every registry entry with a probe.pricing config
// gets its adapter's probePrices() called; new/changed from-prices become
// price.update proposals in the review queue (skip when identical to what's
// already published in data/canonical/prices.json).
//
// Run with: node scripts/probe-prices.mjs   (GITHUB_TOKEN to file proposals)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./lib/registry.mjs";
import { mergeProbeHealth, normalizeProbeResult } from "./lib/probe-health.mjs";
import {
  PENDING_DIR,
  buildProposal,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MAX_PROPOSALS = 10;

function readJsonLocal(...segments) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read → merge → write public/data/scraped/probe-health.json. The merge itself
 * is pure (scripts/lib/probe-health.mjs); this only touches disk and warns about
 * probes that have gone quiet, which is the whole point of the file.
 */
function writeProbeHealth(entries, outcomes, runStartedAt) {
  const file = path.join(ROOT, "public", "data", "scraped", "probe-health.json");
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"))?.data?.probes ?? {};
  } catch {
    previous = {};
  }

  const nowIso = new Date().toISOString();
  const probes = mergeProbeHealth(previous, entries, outcomes, nowIso);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        { uploadedAt: nowIso, data: { runStartedAt, runFinishedAt: nowIso, probes } },
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    console.warn(`[probe] could not write probe-health.json: ${err.message}`);
  }

  for (const [id, p] of Object.entries(probes)) {
    if (p.consecutiveEmptyRuns > 0) {
      console.warn(
        `[probe] ${id}: ${p.consecutiveEmptyRuns} consecutive run(s) with no price` +
          (p.lastError ? ` — last error: ${p.lastError}` : ""),
      );
    }
  }
}

async function main() {
  const registry = loadRegistry();
  const probeEntries = registry.filter((e) => e.probe?.pricing?.adapter);
  if (probeEntries.length === 0) {
    console.log("[probe] no probe configs in the registry — nothing to do");
    return;
  }

  const currentPrices = readJsonLocal("data", "canonical", "prices.json") ?? {};
  const seen = readJsonLocal("data", "canonical", "state", "seen.json");
  const ctx = {
    rootDir: ROOT,
    seenRoutes: new Set(Object.keys(seen?.routes ?? {})),
    // What already has a price. The adapter spends its small request budget on
    // routes that do not, so coverage widens run over run instead of re-reading
    // the same four every Monday.
    prices: currentPrices,
  };

  const runStartedAt = new Date().toISOString();
  const findings = [];
  const outcomes = {};
  for (const entry of probeEntries) {
    try {
      const mod = await import(`./adapters/${entry.probe.pricing.adapter}.mjs`);
      const outcome = normalizeProbeResult(await mod.probePrices(entry, ctx));
      outcomes[entry.id] = outcome;
      findings.push(...outcome.prices.map((r) => ({ ...r, sourceId: entry.id })));
    } catch (err) {
      // A throwing adapter (a bad module name, a parse error) used to vanish
      // into this warning. Record it, so the dashboard shows a probe that has
      // not worked in weeks instead of one that simply had nothing to say.
      outcomes[entry.id] = { prices: [], attempted: 0, errors: [err.message] };
      console.warn(`[probe] ${entry.id}: ${err.message}`);
    }
  }

  // Written before the proposals are filed: whether the run found anything is
  // exactly the fact worth recording when it found nothing.
  writeProbeHealth(probeEntries, outcomes, runStartedAt);

  // Skip prices identical to what's already live (±1 cent).
  const changed = findings.filter((f) => {
    const current = currentPrices[f.routeKey];
    return !current || Math.abs(current.fromPrice - f.fromPrice) > 0.01;
  });
  console.log(`[probe] ${findings.length} price(s) found, ${changed.length} new/changed`);
  if (changed.length === 0) return;

  if (!isGithubWriteConfigured()) {
    console.warn("[probe] GITHUB_TOKEN not configured — proposals not filed:");
    changed.forEach((f) => console.warn(`  - ${f.routeKey}: ${f.fromPrice} ${f.currency}`));
    return;
  }

  const slug = repoSlug();
  const branch = proposalsBranch();
  const branchReady = await ensureBranch(slug, branch, "main");
  if (branchReady.error) throw new Error(`Failed to ${branchReady.error}`);

  const listing = await listDir(slug, branch, PENDING_DIR);
  const openIds = new Set(
    (listing.error ? [] : listing.entries)
      .map((e) => parseProposalFilename(e.name))
      .filter(Boolean)
      .map((m) => `${m.kind}:${m.id}`),
  );

  let filed = 0;
  for (const f of changed.slice(0, MAX_PROPOSALS)) {
    const stableId = `p_price-${f.routeKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}`;
    if (openIds.has(`price.update:${stableId}`)) continue;

    const previous = currentPrices[f.routeKey] ?? null;
    const proposal = buildProposal({
      id: stableId,
      source: "probe",
      sourceDetail: f.sourceId,
      kind: "price.update",
      title: `Price: ${f.routeKey} from ${f.fromPrice} ${f.currency}`,
      summary: previous
        ? `Cheapest sampled fare changed ${previous.fromPrice} → ${f.fromPrice} ${f.currency} (sample date ${f.sampleDate}).`
        : `First sampled fare: ${f.fromPrice} ${f.currency} (sample date ${f.sampleDate}).`,
      target: { routeKey: f.routeKey },
      before: previous,
      after: { fromPrice: f.fromPrice, currency: f.currency },
      apply: {
        type: "price.update",
        payload: {
          routeKey: f.routeKey,
          price: {
            fromPrice: f.fromPrice,
            currency: f.currency,
            source: `probe:${f.sourceId}`,
            sampledAt: new Date().toISOString(),
            sampleDate: f.sampleDate,
            evidenceUrl: f.evidenceUrl,
          },
        },
      },
      evidence: { urls: [f.evidenceUrl] },
    });
    const put = await putJsonFile(
      slug,
      branch,
      `${PENDING_DIR}/${encodeProposalFilename(proposal)}`,
      proposal,
      `chore(probe): price ${proposal.id}`,
    );
    if (put.error) {
      console.warn(`[probe] failed to ${put.error}`);
      continue;
    }
    filed++;
  }
  console.log(`[probe] filed ${filed} price proposal(s)`);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
