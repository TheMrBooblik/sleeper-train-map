// scripts/ai-tasks.mjs
// Nightly best-effort AI assist (GitHub Models, free tier). Three tasks, all
// of which ONLY produce review-queue proposals — AI output never touches live
// data, and any failure (rate limit, outage, bad output) is skipped silently.
//
//   A. Enrich tonight's scrape proposals with clearer titles/summaries.
//   B. Station matcher: injected operator-source station names that fuzzily
//      match an existing Back-on-Track stop → station-alias proposals
//      (dedupes duplicate markers like "Roma Termini" vs "Rome Termini").
//   C. Pricing extraction from operator pages declared in the registry
//      (entry.aiExtract.targets = [{ url, routeKey, notes }]).
//
// Run with: node scripts/ai-tasks.mjs   (GITHUB_TOKEN with models:read)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiAvailable, aiJson, remainingBudget } from "./lib/ai.mjs";
import { htmlToText } from "./lib/html-text.mjs";
import { loadRegistry } from "./lib/registry.mjs";
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
  readJsonFile,
  repoSlug,
} from "../src/pages/api/lib/github-content.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const MAX_ENRICH = 8;
const MAX_ALIAS_CHECKS = 5;
const MAX_EXTRACT_TARGETS = 3;

// ─── Pure helpers (unit-tested in tests/verify-ai-prompts.mjs) ──────────────

export function levenshtein(a, b, cap = 6) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = tmp;
    }
  }
  return prev[b.length];
}

// Injected names with a fuzzy near-miss among BoT stop names: alias candidates.
// Exact matches are already deduped by the injector; aliased names are
// filtered by the caller.
export function findAliasCandidates(injectedNames, botStopNames, max = MAX_ALIAS_CHECKS) {
  const botLower = botStopNames.map((n) => ({ name: n, lower: n.toLowerCase() }));
  const out = [];
  for (const injected of injectedNames) {
    const lower = injected.toLowerCase();
    let best = null;
    for (const bot of botLower) {
      if (bot.lower === lower) {
        best = null; // exact match — injector already handles it
        break;
      }
      const containment =
        (bot.lower.includes(lower) || lower.includes(bot.lower)) &&
        Math.min(lower.length, bot.lower.length) >= 5;
      const distance = levenshtein(lower, bot.lower, 3);
      if (containment || distance <= 3) {
        const score = containment ? 0.5 : distance;
        if (!best || score < best.score) best = { injected, candidate: bot.name, score };
      }
    }
    if (best) out.push(best);
    if (out.length >= max) break;
  }
  return out;
}

export function buildStationMatchPrompt({ injected, candidate }) {
  return {
    system:
      "You verify whether two railway station names refer to the same physical station. " +
      'Respond with JSON only: {"same": true|false, "confidence": 0..1}. ' +
      "Different stations in the same city (e.g. Wien Hbf vs Wien Meidling) are NOT the same.",
    user: `Station A (from an operator API): "${injected}"\nStation B (from the Back-on-Track dataset): "${candidate}"\nAre A and B the same station (possibly in different languages/transliterations)?`,
  };
}

export function parseStationMatch(obj) {
  if (typeof obj?.same !== "boolean") return null;
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { same: obj.same, confidence };
}

export function buildPricingPrompt({ text, routeKey, notes }) {
  return {
    system:
      "You extract night-train ticket pricing from a webpage's text. " +
      'Respond with JSON only: {"fromPrice": number|null, "currency": "EUR"|...} — ' +
      "the cheapest advertised one-way fare for the route in question. " +
      "Use null when no concrete price is stated. Never guess.",
    user:
      `Route: ${routeKey}\n` +
      (notes ? `Hints: ${notes}\n` : "") +
      `Page text (truncated):\n"""\n${text.slice(0, 6000)}\n"""`,
  };
}

export function parsePricing(obj) {
  if (obj?.fromPrice === null) return null;
  const fromPrice = Number(obj?.fromPrice);
  if (!Number.isFinite(fromPrice) || fromPrice <= 0 || fromPrice > 10000) return null;
  const currency = typeof obj?.currency === "string" ? obj.currency.toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { fromPrice, currency };
}

export function buildSummaryPrompt(proposal) {
  return {
    system:
      "You rewrite machine-generated change notifications for a night-train map's review queue. " +
      'Respond with JSON only: {"title": "...", "summary": "..."} — title ≤80 chars, ' +
      "summary ≤300 chars, plain language, keep all factual details (train numbers, stations, days). " +
      "Never invent information.",
    user: JSON.stringify({
      kind: proposal.kind,
      title: proposal.title,
      summary: proposal.summary,
      target: proposal.target,
      before: proposal.before,
      after: proposal.after,
    }),
  };
}

export function parseSummary(obj) {
  const title = typeof obj?.title === "string" ? obj.title.trim() : "";
  const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";
  if (!title || title.length > 120 || summary.length > 600) return null;
  return { title, summary };
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

function readJsonLocal(...segments) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));
  } catch {
    return null;
  }
}

async function taskEnrich(slug, branch, pendingEntries) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const targets = pendingEntries
    .filter((e) => {
      const meta = parseProposalFilename(e.name);
      return meta && meta.source === "scrape" && e.name.startsWith(today);
    })
    .slice(0, MAX_ENRICH);

  let enriched = 0;
  for (const entry of targets) {
    if (!aiAvailable()) break;
    const file = await readJsonFile(slug, branch, `${PENDING_DIR}/${entry.name}`);
    if (file.error || !file.json || file.json.aiEnriched) continue;
    const proposal = file.json;

    const out = parseSummary(await aiJson(buildSummaryPrompt(proposal)));
    if (!out) continue;
    const updated = {
      ...proposal,
      title: out.title,
      summary: out.summary || proposal.summary,
      aiEnriched: true,
    };
    const put = await putJsonFile(
      slug,
      branch,
      `${PENDING_DIR}/${entry.name}`,
      updated,
      `chore(ai): enrich ${proposal.id}`,
      file.sha,
    );
    if (!put.error) enriched++;
  }
  console.log(`[ai] task A: enriched ${enriched}/${targets.length} proposal(s)`);
}

async function taskStationAliases(slug, branch, pendingEntries) {
  const seen = readJsonLocal("data", "canonical", "state", "seen.json");
  const aliases = readJsonLocal("data", "overrides", "station-aliases.json") ?? {};
  const stops = readJsonLocal("public", "data", "scraped", "backontrack-stops.json");
  if (!seen || !stops?.data) {
    console.log("[ai] task B: inputs missing — skipped");
    return;
  }

  const injected = Object.keys(seen.injectedStations ?? {}).filter(
    (name) => !aliases[name.toLowerCase()],
  );
  const botNames = Object.values(stops.data)
    .map((s) => s.stop_name)
    .filter(Boolean);

  const openIds = new Set(
    pendingEntries
      .map((e) => parseProposalFilename(e.name))
      .filter(Boolean)
      .map((m) => `${m.kind}:${m.id}`),
  );

  const candidates = findAliasCandidates(injected, botNames);
  let filed = 0;
  for (const pair of candidates) {
    if (!aiAvailable()) break;
    const stableId = `p_alias-${pair.injected.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}`;
    if (openIds.has(`override.set:${stableId}`)) continue;

    const verdict = parseStationMatch(await aiJson(buildStationMatchPrompt(pair)));
    if (!verdict?.same || verdict.confidence < 0.8) continue;

    const proposal = buildProposal({
      id: stableId,
      source: "ai",
      sourceDetail: "station-matcher",
      kind: "override.set",
      title: `Alias station "${pair.injected}" → "${pair.candidate}"`,
      summary:
        `The operator-injected station "${pair.injected}" appears to be the same as ` +
        `Back-on-Track's "${pair.candidate}" (AI confidence ${verdict.confidence}). ` +
        "Approving merges the duplicate marker.",
      target: { stationName: pair.injected },
      before: null,
      after: { alias: pair.injected.toLowerCase(), canonical: pair.candidate },
      apply: {
        type: "override.set",
        payload: {
          resource: "station-aliases",
          action: "set",
          payload: { alias: pair.injected, canonical: pair.candidate },
        },
      },
    });
    const put = await putJsonFile(
      slug,
      branch,
      `${PENDING_DIR}/${encodeProposalFilename(proposal)}`,
      proposal,
      `chore(ai): alias suggestion ${proposal.id}`,
    );
    if (!put.error) filed++;
  }
  console.log(`[ai] task B: ${candidates.length} candidate(s), ${filed} alias proposal(s) filed`);
}

async function taskPricingExtraction(slug, branch, pendingEntries, registry) {
  const targets = registry
    .filter((e) => e.aiExtract?.targets?.length)
    .flatMap((e) =>
      e.aiExtract.targets.map((t) => ({ ...t, sourceId: e.id })),
    )
    .slice(0, MAX_EXTRACT_TARGETS);
  if (targets.length === 0) {
    console.log("[ai] task C: no aiExtract targets configured — skipped");
    return;
  }

  const openIds = new Set(
    pendingEntries
      .map((e) => parseProposalFilename(e.name))
      .filter(Boolean)
      .map((m) => `${m.kind}:${m.id}`),
  );

  let filed = 0;
  for (const target of targets) {
    if (!aiAvailable()) break;
    if (!target.url || !target.routeKey) continue;
    const stableId = `p_price-${target.routeKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}`;
    if (openIds.has(`price.update:${stableId}`)) continue;

    let text;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(target.url, {
        signal: controller.signal,
        headers: { "User-Agent": "train-map/1.0" },
      }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      text = htmlToText(await res.text());
    } catch {
      continue;
    }

    const price = parsePricing(
      await aiJson(buildPricingPrompt({ text, routeKey: target.routeKey, notes: target.notes })),
    );
    if (!price) continue;

    const proposal = buildProposal({
      id: stableId,
      source: "ai",
      sourceDetail: target.sourceId,
      kind: "price.update",
      title: `Price found: ${target.routeKey} from ${price.fromPrice} ${price.currency}`,
      summary: `Extracted from ${target.url} — verify against the page before approving.`,
      target: { routeKey: target.routeKey },
      after: price,
      apply: {
        type: "price.update",
        payload: {
          routeKey: target.routeKey,
          price: {
            ...price,
            source: "ai-extraction",
            sampledAt: new Date().toISOString(),
            evidenceUrl: target.url,
          },
        },
      },
      evidence: { urls: [target.url], excerpt: text.slice(0, 2000), fetchedAt: new Date().toISOString() },
    });
    const put = await putJsonFile(
      slug,
      branch,
      `${PENDING_DIR}/${encodeProposalFilename(proposal)}`,
      proposal,
      `chore(ai): price extraction ${proposal.id}`,
    );
    if (!put.error) filed++;
  }
  console.log(`[ai] task C: ${filed}/${targets.length} pricing proposal(s) filed`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!aiAvailable()) {
    console.log("[ai] GITHUB_TOKEN missing or budget 0 — nothing to do");
    return;
  }
  if (!isGithubWriteConfigured()) {
    console.log("[ai] GitHub repo not configured — nothing to do");
    return;
  }

  const slug = repoSlug();
  const branch = proposalsBranch();
  const registry = loadRegistry();

  const branchReady = await ensureBranch(slug, branch, "main");
  if (branchReady.error) {
    console.warn(`[ai] ${branchReady.error} — aborting`);
    return;
  }
  const listing = await listDir(slug, branch, PENDING_DIR);
  const pendingEntries = listing.error ? [] : listing.entries;

  await taskEnrich(slug, branch, pendingEntries);
  await taskStationAliases(slug, branch, pendingEntries);
  await taskPricingExtraction(slug, branch, pendingEntries, registry);

  console.log(`[ai] done — request budget remaining: ${remainingBudget()}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[ai] fatal:", err);
    process.exit(1);
  });
}
