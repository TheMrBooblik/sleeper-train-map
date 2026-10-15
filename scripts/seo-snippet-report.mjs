#!/usr/bin/env node
/**
 * Read what the staged snippet rollout did: a Search Console "Pages" export in,
 * a treatment-against-control table out, against the baseline frozen before
 * any snippet changed.
 *
 * The rollout renders the fact-bearing snippet only on the corridors
 * `snippetVariantFor()` names (European Sleeper's, to start) and leaves every
 * other connection page on its old wording, byte for byte. That makes the
 * other pages a control group for free: they share the site's drift — its
 * position climbed 50.8 → 17.3 in the five weeks before the baseline closed —
 * so the treatment's change is read NET of theirs. A before/after on the
 * treatment alone would credit the wording with whatever the whole site did.
 *
 * A control page has to have kept everything but its wording, and a priced
 * one has not: no published page carried a fare before the baseline closed
 * (the first nightly official fare, 12306's, landed on 2026-09-26), and a
 * fare calendar, a "From" tile, a price question in the FAQ and a price in
 * the description are a different page. So control-variant pages with a
 * price are read apart, as their own row, and kept out of the net figure —
 * 63 of them in October 2026, ÖBB's 24 Nightjet corridors among them, about
 * half the control group's baseline impressions.
 *
 * A page none of whose trains runs now (a seasonal train out of season) is
 * read apart too, as "seasonal": its title and description lead with the date
 * it runs again under either variant (src/lib/nextDeparture.mjs), so it is
 * neither arm.
 *
 * Read it with three things in mind, which it prints:
 *
 *   - Volume. The four European Sleeper pages took 3 clicks from 793
 *     impressions in the baseline quarter. At that size only a large change
 *     shows, and the per-page table says more than the ratio does.
 *   - What else changed on those pages. The same branch gave them a fare
 *     calendar and a price in the description, so the treatment is the
 *     snippet and the page together, not the snippet alone.
 *   - Google rewrites roughly a third of titles and more descriptions, so a
 *     null means "the meta layer did not move it", never "the facts do not
 *     help".
 *
 * Usage:
 *   node scripts/seo-snippet-report.mjs <gsc-pages.csv>
 *   (export only dates after the rollout deployed)
 */
import fs from "node:fs";

import BASELINE from "../data/seo/snippet-baseline.json" with { type: "json" };
import { getPublishedPairs } from "./lib/published-pairs.mjs";
import { FACTS, FACTS_AGENCIES, snippetVariantFor } from "../src/lib/seo/snippet.mjs";

const ORIGIN = "https://pingwi.com/connections/";
/** Below this many treatment clicks, read the per-page table, not the ratio. */
const MIN_CLICKS_FOR_SIGNAL = 30;

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

/** Impression-weighted position, so a 3-impression page cannot swing the mean. */
function totals(rows) {
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const weighted = rows.reduce((n, r) => n + r.position * r.impressions, 0);
  return {
    pages: rows.length,
    impressions,
    clicks,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weighted / impressions : 0,
  };
}

const pct = (n) => `${(100 * n).toFixed(2)}%`;
const pad = (s, n) => String(s).padStart(n);
const ratio = (after, before) => (before ? after / before : null);
const times = (r) => (r == null ? "n/a" : `${r.toFixed(2)}×`);

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("usage: node scripts/seo-snippet-report.mjs <gsc-pages.csv>");
    process.exit(1);
  }

  const now = new Map();
  for (const row of readCsv(csvPath)) {
    const url = row["Top pages"] || row.Page || "";
    if (!url.startsWith(ORIGIN)) continue;
    now.set(url.slice(ORIGIN.length).replace(/\/$/, ""), {
      clicks: Number(row.Clicks || 0),
      impressions: Number(row.Impressions || 0),
      position: Number(row.Position || 0),
    });
  }

  // Arms from the pages as the build renders them today; only pages with a
  // "before" can be compared, so a pair newer than the baseline sits out. A
  // control page that gained a price since is its own row (see the header).
  const arms = { treatment: [], control: [], priced: [], seasonal: [] };
  const pricedSources = new Set();
  let unbaselined = 0;
  for (const pair of getPublishedPairs()) {
    const before = BASELINE.pages[pair.slug];
    if (!before) {
      unbaselined += 1;
      continue;
    }
    const arm = pair.upcoming
      ? "seasonal"
      : snippetVariantFor(pair.agencyIds) === FACTS
        ? "treatment"
        : pair.fromPrice
          ? "priced"
          : "control";
    if (arm === "priced") for (const s of pair.priceSources ?? []) pricedSources.add(s);
    arms[arm].push({
      slug: pair.slug,
      before,
      after: now.get(pair.slug) || { clicks: 0, impressions: 0, position: 0 },
    });
  }

  console.log(`\nconnection snippets — FACTS on corridors run by: ${[...FACTS_AGENCIES].join(", ")}`);
  console.log(
    `baseline ${BASELINE.baselineWindow.from} → ${BASELINE.baselineWindow.to} (${BASELINE.baselineSource}); after: ${csvPath}`,
  );
  if (unbaselined) console.log(`${unbaselined} published pair(s) are newer than the baseline and sit out.`);
  if (arms.priced.length) {
    console.log(
      `${arms.priced.length} control page(s) gained a price after the baseline (${[...pricedSources].sort().join(", ") || "prices.json"}):\n` +
        "  read apart as \"priced\" and left out of the net, since they changed more than their wording.",
    );
  }

  console.log(`\n${"=".repeat(68)}`);
  console.log("                      pages    impr  clicks      CTR     pos");
  const sums = {};
  if (arms.seasonal.length) {
    console.log(
      `${arms.seasonal.length} page(s) have no train running now and lead with the next season: ` +
        `${arms.seasonal.map((r) => r.slug).join(", ")} — read apart as "seasonal".`,
    );
  }
  for (const arm of ["treatment", "control", "priced", "seasonal"]) {
    if ((arm === "priced" || arm === "seasonal") && !arms[arm].length) continue;
    sums[arm] = {
      before: totals(arms[arm].map((r) => r.before)),
      after: totals(arms[arm].map((r) => r.after)),
    };
    for (const when of ["before", "after"]) {
      const t = sums[arm][when];
      console.log(
        `  ${arm.padEnd(9)} ${when.padEnd(6)} ${pad(t.pages, 6)} ${pad(t.impressions, 7)} ${pad(t.clicks, 7)} ${pad(pct(t.ctr), 8)} ${pad(t.position.toFixed(1), 7)}`,
      );
    }
  }

  const treatmentLift = ratio(sums.treatment.after.ctr, sums.treatment.before.ctr);
  const controlLift = ratio(sums.control.after.ctr, sums.control.before.ctr);
  const net = treatmentLift != null && controlLift ? treatmentLift / controlLift : null;
  const drift = (arm) => sums[arm].after.position - sums[arm].before.position;
  console.log(`\n  CTR      treatment ${times(treatmentLift)}, control ${times(controlLift)} → net ${times(net)}`);
  console.log(
    `  position treatment ${drift("treatment") >= 0 ? "+" : ""}${drift("treatment").toFixed(1)}, ` +
      `control ${drift("control") >= 0 ? "+" : ""}${drift("control").toFixed(1)} (lower is better)`,
  );

  console.log(`\n${"=".repeat(68)}\ntreatment pages`);
  console.log("                                   before                after");
  console.log("                            impr clk   pos      impr clk   pos");
  for (const r of arms.treatment) {
    const cell = (p) => `${pad(p.impressions, 6)} ${pad(p.clicks, 3)} ${pad(p.position ? p.position.toFixed(1) : "–", 5)}`;
    console.log(`  ${r.slug.padEnd(24)} ${cell(r.before)}    ${cell(r.after)}`);
  }

  console.log(`\n${"=".repeat(68)}\nread this before believing the numbers above`);
  const clicks = sums.treatment.after.clicks;
  console.log(
    clicks < MIN_CLICKS_FOR_SIGNAL
      ? `  ${clicks} treatment clicks in this window. At this volume only a large change\n` +
          "  (roughly a doubling) is distinguishable from noise; the per-page table says\n" +
          "  more than the ratio, and a flat reading is not evidence of no effect."
      : `  ${clicks} treatment clicks: enough to read a large change, not a small one.`,
  );
  console.log(
    "  These pages also gained a fare calendar and a price in this change, so the\n" +
      "  treatment is the snippet and the page together.\n" +
      "  Google rewrites roughly a third of titles and more descriptions: a null\n" +
      "  means the meta layer did not move it, not that the facts do not help.",
  );
  console.log();
}

main();
