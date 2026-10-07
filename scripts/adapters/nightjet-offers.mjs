// scripts/adapters/nightjet-offers.mjs
// Weekly price probe: samples NightJet trains ~30 days out and reports the
// cheapest berth per route. Every result lands in the review queue, never
// directly on the map — the nightly fare calendar (scripts/lib/nj-fares.mjs)
// is what prices the rows, and this probe reads the same endpoint the same
// way, so `npm run probe-prices:debug` (the `run-probes` label) shows exactly
// what that calendar is built from.
//
// It used to call the booking flow's /connection/{from}/{to}/{date}, which now
// sits behind a proof-of-work captcha and answered 400 on every run
// (probe-health.json: four empty runs in a row, "NJ 1236: HTTP 400").
//
// Which routes get sampled is selectProbeTargets()'s call, not this file's: the
// budget is small against an undocumented API, so it has to be spent on routes
// that still have no price (see scripts/lib/probe-rotation.mjs).

import fs from "node:fs";
import path from "node:path";
import { cheapestClass } from "../lib/fare-calendar.mjs";
import { buildOffersUrl, fetchNjOffers, pricingEnds } from "../lib/nj-fares.mjs";
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

  // Trains whose synthetic route key is live and whose ends carry the 7-digit
  // station ids the price search takes (the same ends the calendar prices).
  return Object.entries(trains)
    .map(([lineName, train]) => {
      const routeKey = `nj_standalone_${lineName.replace(/\s+/g, "_")}`;
      if (!seenRoutes.has(routeKey)) return null;
      const ends = pricingEnds(train);
      if (!ends) return null;
      // `priced`: the nightly calendar already prices this train, and its
      // figure outranks a prices.json entry, so a proposal for it would
      // change nothing once approved. Kept as a candidate for the debug
      // script, which shows what the endpoint answers either way.
      return { routeKey, lineName, from: ends.fromId, to: ends.toId, priced: Boolean(train.fare) };
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

  // Only what the nightly fare calendar does not price: a proposal for a train
  // it prices would be overwritten by stampOfficialFares the night it lands.
  const calendarPriced = candidates.filter((c) => c.priced).length;
  candidates = candidates.filter((c) => !c.priced);
  if (calendarPriced) {
    console.log(`[probe:nj] ${calendarPriced} route(s) left out: the nightly fare calendar prices them`);
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
    const url = buildProbeUrl({ ...c, date });
    try {
      const answer = await fetchNjOffers({ trainName: c.lineName, fromId: c.from, toId: c.to, date });
      // The first journey on or after the sample date that sells a berth.
      const night = answer.dates.find((d) => d >= date && cheapestClass(answer.nights[d].classes));
      if (!night) {
        errors.push(`${c.lineName}: no berth on sale in ${answer.rows} journey(s) from ${date}`);
        console.warn(`[probe:nj] ${c.lineName}: no berth on sale in ${answer.rows} journey(s) from ${date}`);
        continue;
      }
      const [seatClass, fromPrice] = cheapestClass(answer.nights[night].classes);
      prices.push({
        routeKey: c.routeKey,
        fromPrice,
        currency: "EUR",
        sampleDate: night,
        evidenceUrl: url,
      });
      console.log(`[probe:nj] ${c.lineName}: ${seatClass} from €${fromPrice} (${night})`);
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
export function buildProbeUrl({ lineName, from, to, date }) {
  return buildOffersUrl({ trainName: lineName, fromId: from, toId: to, date });
}

export { sampleDate };
