#!/usr/bin/env node
/**
 * Read the snippet experiment: a Search Console "Pages" export in, a
 * treatment-vs-control table out.
 *
 * The headline is a DIFFERENCE IN DIFFERENCES, not a before/after, because the
 * site's own baseline moves fast — average position went from 50.8 to 17.3 in
 * the five weeks before the experiment started, and impressions from 575 a week
 * to 4 900. Any before/after on the treatment arm alone would be reading that
 * trend. What the control arm is for is to cancel it: if both arms move
 * together, nothing happened; if the treatment arm moves and the control does
 * not, the snippet did it.
 *
 * It reports on pages ranking in the top 20 first, and everything second. A
 * page at position 65 with 660 impressions and no clicks (aurillac-to-paris)
 * cannot be rescued by a title, and letting it into the headline dilutes a real
 * effect with impressions on which no title could ever have won.
 *
 * Two readings that are NOT a result, printed so they cannot be mistaken for one:
 *   - a large position move in either arm confounds the CTR change outright;
 *   - Google rewrites roughly a third of titles and more descriptions, so a null
 *     result means "the meta layer did not move it", never "the facts do not
 *     help". The next lever after a null is on-page depth.
 *
 * Usage:
 *   node scripts/seo-experiment-report.mjs <gsc-pages.csv>
 */
import fs from "node:fs";

import { getExperiment } from "../src/lib/seo/experiment.mjs";
import { CONTROL_GROUP, TREATMENT_GROUP } from "../src/lib/seo/experiment-split.mjs";

const ORIGIN = "https://pingwi.com/connections/";
const RANKING_BAND = 20;

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

function table(label, before, after) {
  console.log(`\n${label}`);
  console.log("                  pages   impr  clicks     CTR   pos");
  for (const [name, t] of [["baseline", before], ["now     ", after]]) {
    console.log(
      `  ${name}      ${pad(t.pages, 6)} ${pad(t.impressions, 6)} ${pad(t.clicks, 7)} ${pad(pct(t.ctr), 7)} ${pad(t.position.toFixed(1), 5)}`,
    );
  }
  const lift = before.ctr ? after.ctr / before.ctr : null;
  console.log(`  CTR change    ${lift === null ? "  n/a (no baseline clicks)" : `${pad(lift.toFixed(2), 8)}×`}`);
  return lift;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("usage: node scripts/seo-experiment-report.mjs <gsc-pages.csv>");
    process.exit(1);
  }
  const experiment = getExperiment();

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

  const rows = Object.entries(experiment.pages).map(([slug, page]) => ({
    slug,
    group: page.group,
    before: { clicks: page.clicks, impressions: page.impressions, position: page.position },
    after: now.get(slug) || { clicks: 0, impressions: 0, position: 0 },
  }));

  console.log(`\n${experiment.id}  —  started ${experiment.startedAt}, baseline ${experiment.baselineWindow.from} → ${experiment.baselineWindow.to}`);
  console.log(`sitemap went to batch 2 on ${experiment.sitemapBatchFlippedAt}; both arms are affected alike.`);
  console.log(`export: ${csvPath}`);

  const lifts = {};
  for (const [scope, keep] of [
    [`ranking band (position ≤ ${RANKING_BAND} in either period)`, (r) => (r.before.position > 0 && r.before.position <= RANKING_BAND) || (r.after.position > 0 && r.after.position <= RANKING_BAND)],
    ["all enrolled pages", () => true],
  ]) {
    console.log(`\n${"=".repeat(62)}\n${scope}`);
    for (const group of [TREATMENT_GROUP, CONTROL_GROUP]) {
      const sel = rows.filter((r) => r.group === group && keep(r));
      const lift = table(
        `  ${group}`,
        totals(sel.map((r) => r.before)),
        totals(sel.map((r) => r.after)),
      );
      lifts[`${scope}:${group}`] = lift;
    }
    const t = lifts[`${scope}:${TREATMENT_GROUP}`];
    const c = lifts[`${scope}:${CONTROL_GROUP}`];
    console.log(
      `\n  → difference in differences: ${t && c ? `${(t / c).toFixed(2)}×` : "n/a"}` +
        "   (1.00 = the arms moved together, i.e. no effect)",
    );
  }

  // Confounders, printed as findings rather than left for the reader to spot.
  console.log(`\n${"=".repeat(62)}\nread this before believing the number above`);
  for (const group of [TREATMENT_GROUP, CONTROL_GROUP]) {
    const sel = rows.filter((r) => r.group === group);
    const drift = totals(sel.map((r) => r.after)).position - totals(sel.map((r) => r.before)).position;
    console.log(
      `  ${group} average position moved ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}` +
        (Math.abs(drift) > 3 ? "  ← large; the CTR change is confounded by ranking" : ""),
    );
  }
  const treatedClicks = totals(rows.filter((r) => r.group === TREATMENT_GROUP).map((r) => r.after)).clicks;
  if (treatedClicks < 30) {
    console.log(
      `  the treatment arm has ${treatedClicks} clicks in this window. This design resolves a large\n` +
        "  effect (≥2×); it cannot separate a 20-30% improvement from noise. Wait longer.",
    );
  }
  console.log();
}

main();
