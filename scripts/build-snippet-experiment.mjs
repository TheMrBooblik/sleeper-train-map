#!/usr/bin/env node
/**
 * Seed `data/seo/snippet-experiment.json` from a Search Console "Pages" export.
 *
 * Run ONCE, at the start of the experiment. The output is committed and then
 * frozen: re-running it against a later export would reassign pages and destroy
 * the comparison, so it refuses to overwrite an existing file without --force.
 *
 * The baseline it captures is the reason this script exists rather than a
 * nightly job. Search Console keeps 16 months, but the arms have to be compared
 * against the numbers they had ON THE DAY the split was made, and the split has
 * to be reproducible from the committed file alone — which is what lets
 * `verify-seo-snippets` re-derive it and catch drift.
 *
 * Usage:
 *   node scripts/build-snippet-experiment.mjs <gsc-pages.csv> [--force]
 */
import fs from "node:fs";
import path from "node:path";

import { getPublishedPairs } from "./lib/published-pairs.mjs";
import { assignGroups, winnableClicks } from "../src/lib/seo/experiment-split.mjs";

const OUT = "data/seo/snippet-experiment.json";
const ORIGIN = "https://pingwi.com/connections/";

/** Minimal CSV reader — the GSC export is quoted only around commas in names. */
function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [];
    const row = {};
    cols.forEach((c, i) => {
      row[c] = String(cells[i] || "").replace(/,$/, "").replace(/^"|"$/g, "").trim();
    });
    return row;
  });
}

function main() {
  const [csvPath, ...flags] = process.argv.slice(2);
  if (!csvPath) {
    console.error("usage: node scripts/build-snippet-experiment.mjs <gsc-pages.csv> [--force]");
    process.exit(1);
  }
  if (fs.existsSync(OUT) && !flags.includes("--force")) {
    console.error(
      `${OUT} already exists. The split is frozen once the experiment starts — ` +
        `reassigning pages would destroy the comparison. Pass --force only to reseed a run that never shipped.`,
    );
    process.exit(1);
  }

  // Every published pair is enrolled, including the ones Search Console has
  // never reported: they weigh nothing in the ranking and fall to the tail, but
  // leaving them out would let the treatment formula reach pages with no
  // recorded group at all.
  const pairs = getPublishedPairs();
  const gsc = new Map();
  for (const row of readCsv(csvPath)) {
    const url = row["Top pages"] || row.Page || "";
    if (!url.startsWith(ORIGIN)) continue;
    gsc.set(url.slice(ORIGIN.length).replace(/\/$/, ""), {
      clicks: Number(row.Clicks || 0),
      impressions: Number(row.Impressions || 0),
      position: Number(row.Position || 0),
    });
  }

  const baseline = {};
  for (const p of pairs) {
    const seen = gsc.get(p.slug);
    baseline[p.slug] = {
      clicks: seen?.clicks ?? 0,
      impressions: seen?.impressions ?? 0,
      position: seen?.position ?? 0,
    };
  }

  const groups = assignGroups(baseline);
  const pages = {};
  for (const slug of Object.keys(baseline).sort()) {
    pages[slug] = { group: groups.get(slug), ...baseline[slug] };
  }

  const out = {
    id: "connection-snippet-facts-v1",
    variant: "facts",
    startedAt: new Date().toISOString().slice(0, 10),
    baselineWindow: { from: "2026-06-21", to: "2026-09-20" },
    baselineSource: path.basename(csvPath),
    // The sitemap went from batch 1 (~145 URLs) to batch 2 (~383) in the same
    // change. It lands on both arms alike, but the report has to be able to say
    // when impressions started arriving from pages that were never submitted.
    sitemapBatchFlippedAt: new Date().toISOString().slice(0, 10),
    pages,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const tally = (group) => {
    const rows = Object.values(pages).filter((p) => p.group === group);
    const imp = rows.reduce((n, p) => n + p.impressions, 0);
    const clicks = rows.reduce((n, p) => n + p.clicks, 0);
    const win = rows.reduce((n, p) => n + winnableClicks(p), 0);
    return `${String(rows.length).padStart(3)} pages ${String(imp).padStart(6)} impr ${String(clicks).padStart(3)} clicks  CTR ${((100 * clicks) / Math.max(imp, 1)).toFixed(2)}%  winnable ${win.toFixed(1)}`;
  };
  console.log(`wrote ${OUT} (${Object.keys(pages).length} pages)`);
  console.log(`  treatment: ${tally("treatment")}`);
  console.log(`  control:   ${tally("control")}`);
}

main();
