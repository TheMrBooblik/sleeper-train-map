#!/usr/bin/env node
/**
 * Seed `data/seo/snippet-baseline.json` from a Search Console "Pages" export.
 *
 * Run ONCE, on the day the new snippets ship. The output is committed and then
 * frozen: re-running it against a later export overwrites the "before" with the
 * "after" and there is nothing left to compare, so it refuses to overwrite an
 * existing file without --force.
 *
 * Freezing it is the whole point. Search Console keeps 16 months of data, but a
 * report built from a window that moves with the calendar cannot say what the
 * pages were doing on the day the wording changed — and with the site's own
 * position having moved 50.8 to 17.3 in the five weeks before, that date is the
 * only fixed point the before/after has.
 *
 * Usage:
 *   node scripts/build-snippet-baseline.mjs <gsc-pages.csv> [--force]
 */
import fs from "node:fs";
import path from "node:path";

import { getPublishedPairs } from "./lib/published-pairs.mjs";
import { winnableClicks } from "../src/lib/seo/ctrBenchmark.mjs";

const OUT = "data/seo/snippet-baseline.json";
/** When SITEMAP_BATCH went 1 → 2 in src/pages/sitemap.xml.js. */
const SITEMAP_BATCH_2_DATE = "2026-09-22";
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
    console.error("usage: node scripts/build-snippet-baseline.mjs <gsc-pages.csv> [--force]");
    process.exit(1);
  }
  if (fs.existsSync(OUT) && !flags.includes("--force")) {
    console.error(
      `${OUT} already exists. The baseline is frozen on the day the snippets shipped — ` +
        `reseeding it would overwrite the "before" with the "after". Pass --force only for a run that never shipped.`,
    );
    process.exit(1);
  }

  // Every published pair is recorded, including the ones Search Console has
  // never reported: a page at zero is a real starting point, and leaving it out
  // would quietly exclude it from the "after" too.
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

  const pages = {};
  for (const slug of Object.keys(baseline).sort()) pages[slug] = baseline[slug];

  const out = {
    id: "connection-snippet-facts-v1",
    shippedAt: new Date().toISOString().slice(0, 10),
    baselineWindow: { from: "2026-06-21", to: "2026-09-20" },
    baselineSource: path.basename(csvPath),
    // The sitemap went from batch 1 (~145 URLs) to batch 2 (382), so the report
    // has to be able to say when impressions started arriving from pages that
    // had never been submitted. It is the date of that commit and not of this
    // run — the two are only the same if you seed on the day you flip it.
    sitemapBatchFlippedAt: SITEMAP_BATCH_2_DATE,
    pages,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const rows = Object.values(pages);
  const imp = rows.reduce((n, p) => n + p.impressions, 0);
  const clicks = rows.reduce((n, p) => n + p.clicks, 0);
  const win = rows.reduce((n, p) => n + winnableClicks(p), 0);
  console.log(`wrote ${OUT} (${rows.length} pages)`);
  console.log(
    `  baseline: ${imp} impressions, ${clicks} clicks, CTR ${((100 * clicks) / Math.max(imp, 1)).toFixed(2)}%, winnable ${win.toFixed(1)}`,
  );
}

main();
