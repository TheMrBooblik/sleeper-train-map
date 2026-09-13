// scripts/adapters/nightjet-offers.mjs
// Weekly price probe: samples NightJet connections ~30 days out and reports
// the cheapest advertised fare per route. The nightjet.com booking API is
// undocumented and shifts shape — extraction is defensive (price-extract.mjs)
// and every result lands in the review queue, never directly on the map.
//
// Which routes get sampled is selectProbeTargets()'s call, not this file's: the
// budget is small against an undocumented API, so it has to be spent on routes
// that still have no price (see scripts/lib/probe-rotation.mjs).

import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { extractMinPrice } from "../lib/price-extract.mjs";
import { selectProbeTargets, weeksSinceEpoch } from "../lib/probe-rotation.mjs";

// Courtesy spacing between calls to an API that owes us nothing.
const REQUEST_SPACING_MS = 1200;

function sampleDate(daysAhead = 30) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<{prices: Array<object>, attempted: number, errors: string[]}>}
 */
export function probeCandidates(entry, ctx) {
  const njFile = JSON.parse(
    fs.readFileSync(
      path.join(ctx.rootDir, "public", "data", "scraped", entry.output),
      "utf8",
    ),
  );
  const trains = njFile?.data?.trains ?? {};
  const seenRoutes = ctx.seenRoutes ?? new Set();

  // Trains whose synthetic route key is live and whose endpoint stations carry
  // numeric EVA ids (required by the connection API).
  return Object.entries(trains)
    .map(([lineName, train]) => {
      const routeKey = `nj_standalone_${lineName.replace(/\s+/g, "_")}`;
      const stations = train.stations ?? [];
      const from = stations[0]?.id;
      const to = stations[stations.length - 1]?.id;
      if (!seenRoutes.has(routeKey)) return null;
      if (!/^\d+$/.test(String(from ?? "")) || !/^\d+$/.test(String(to ?? ""))) return null;
      return { routeKey, lineName, from: String(from), to: String(to) };
    })
    .filter(Boolean);
}

export async function probePrices(entry, ctx) {
  const sampleRoutes = entry.probe?.pricing?.sampleRoutes ?? 4;
  const date = sampleDate();
  const errors = [];

  let candidates;
  try {
    candidates = probeCandidates(entry, ctx);
  } catch (err) {
    // No trains file is a real failure, not an empty night: say so, or the
    // health record reads "ran, found nothing" and hides a missing scrape.
    return { prices: [], attempted: 0, errors: [`${entry.output} unreadable: ${err.message}`] };
  }

  const targets = selectProbeTargets(candidates, ctx.prices ?? {}, {
    sampleSize: sampleRoutes,
    rotation: weeksSinceEpoch(),
  });
  console.log(
    `[probe:nj] ${candidates.length} probe-able route(s), sampling ${targets.length}: ${targets
      .map((t) => t.lineName)
      .join(", ")}`,
  );

  const prices = [];
  for (const [i, c] of targets.entries()) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    const url = buildProbeUrl({ from: c.from, to: c.to, date });
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${c.lineName}: HTTP ${res.status}`);
        console.warn(`[probe:nj] ${c.lineName}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const fromPrice = extractMinPrice(data);
      if (fromPrice == null) {
        errors.push(`${c.lineName}: no price field found`);
        console.warn(`[probe:nj] ${c.lineName}: no price field found`);
        continue;
      }
      prices.push({
        routeKey: c.routeKey,
        fromPrice,
        currency: "EUR",
        sampleDate: date,
        evidenceUrl: url,
      });
      console.log(`[probe:nj] ${c.lineName}: from €${fromPrice} (${date})`);
    } catch (err) {
      errors.push(`${c.lineName}: ${err.message}`);
      console.warn(`[probe:nj] ${c.lineName}: ${err.message}`);
    }
  }
  return { prices, attempted: targets.length, errors };
}

/**
 * The URL the probe would call for one route, so the debug script can print and
 * fetch exactly what the nightly job does rather than a hand-built guess.
 */
export function buildProbeUrl({ from, to, date }) {
  return `https://www.nightjet.com/nj-booking-ocp/connection/${from}/${to}/${date}`;
}

export { sampleDate };
