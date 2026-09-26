#!/usr/bin/env node
/**
 * Read what the new pair-page snippets did: a Search Console "Pages" export in,
 * a before/after table out, against the baseline frozen on the day they shipped.
 *
 * It is a before/after and not a controlled comparison, and that was measured
 * rather than assumed. A 50/50 split of these pages puts ~19 and ~11 clicks in
 * the two arms per quarter; separating 19 from 27 — a +40% lift, a very good
 * result for a snippet rewrite — needs a gap above ~2·√(19+27) ≈ 14 and the gap
 * is 8. Only a doubling was resolvable, and only over a full quarter, so
 * holding half the pages back bought an answer that would not have arrived.
 * See CLAUDE.md.
 *
 * What that costs is attribution, so the report is built to be read carefully:
 *
 *   - The headline is the position ≤ 20 band. A page at position 65 with 660
 *     impressions and no clicks cannot be rescued by a title, and averaging it
 *     in dilutes a real change with impressions nothing could have won.
 *   - Position drift is printed beside it. The site's own position moved 50.8
 *     to 17.3 in the five weeks before this shipped; if it keeps moving, the
 *     CTR change is that trend and not the wording.
 *   - So is the sitemap flip date, which added 237 pages to the sitemap in the
 *     same change and brings its own impressions.
 *   - And a power line, because at these click counts a small change is not
 *     distinguishable from noise however it is presented.
 *
 * A null result means "the meta layer did not move it", never "the facts do not
 * help": Google rewrites roughly a third of titles and more descriptions. The
 * next lever after a null is on-page depth.
 *
 * Usage:
 *   node scripts/seo-snippet-report.mjs <gsc-pages.csv>
 */
import fs from "node:fs";

import BASELINE from "../data/seo/snippet-baseline.json" with { type: "json" };

const ORIGIN = "https://pingwi.com/connections/";
const RANKING_BAND = 20;
/** Below this many clicks in the window, the readout cannot separate small changes. */
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

  const rows = Object.entries(BASELINE.pages).map(([slug, page]) => ({
    slug,
    before: { clicks: page.clicks, impressions: page.impressions, position: page.position },
    after: now.get(slug) || { clicks: 0, impressions: 0, position: 0 },
  }));

  console.log(
    `\n${BASELINE.id}  —  shipped ${BASELINE.shippedAt}, baseline ${BASELINE.baselineWindow.from} → ${BASELINE.baselineWindow.to}`,
  );
  console.log(`sitemap went to batch 2 on ${BASELINE.sitemapBatchFlippedAt}, which brings impressions of its own.`);
  console.log(`export: ${csvPath}`);

  for (const [scope, keep] of [
    [
      `ranking band (position ≤ ${RANKING_BAND} in either period) — read this one`,
      (r) =>
        (r.before.position > 0 && r.before.position <= RANKING_BAND) ||
        (r.after.position > 0 && r.after.position <= RANKING_BAND),
    ],
    ["all 240 pairs", () => true],
  ]) {
    const sel = rows.filter(keep);
    const before = totals(sel.map((r) => r.before));
    const after = totals(sel.map((r) => r.after));
    console.log(`\n${"=".repeat(64)}\n${scope}`);
    console.log("                pages   impr  clicks     CTR   pos");
    for (const [name, t] of [["before", before], ["after ", after]]) {
      console.log(
        `  ${name}      ${pad(t.pages, 6)} ${pad(t.impressions, 6)} ${pad(t.clicks, 7)} ${pad(pct(t.ctr), 7)} ${pad(t.position.toFixed(1), 5)}`,
      );
    }
    const lift = before.ctr ? after.ctr / before.ctr : null;
    const drift = after.position - before.position;
    console.log(`  CTR change  ${lift === null ? "  n/a (no clicks before)" : `${pad(lift.toFixed(2), 8)}×`}`);
    console.log(`  position    ${pad((drift >= 0 ? "+" : "") + drift.toFixed(1), 8)}`);
    if (Math.abs(drift) > 3) {
      console.log("    ← moved a lot; the CTR change is that and not the wording");
    }
  }

  console.log(`\n${"=".repeat(64)}\nread this before believing the number above`);
  const all = totals(rows.map((r) => r.after));
  if (all.clicks < MIN_CLICKS_FOR_SIGNAL) {
    console.log(
      `  ${all.clicks} clicks in this window. At this volume only a large change (roughly a\n` +
        "  doubling) is distinguishable from noise — a flat reading is not evidence of\n" +
        "  no effect. Wait longer before concluding anything.",
    );
  } else {
    console.log(`  ${all.clicks} clicks in this window, enough to read a large change but not a small one.`);
  }
  console.log(
    "  Google rewrites roughly a third of titles and more descriptions, so a null\n" +
      "  result means the meta layer did not move it, not that the facts do not help.",
  );
  console.log();
}

main();
