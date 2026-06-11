// scripts/adapters/nightjet-offers.mjs
// Weekly price probe: samples NightJet connections ~30 days out and reports
// the cheapest advertised fare per route. The nightjet.com booking API is
// undocumented and shifts shape — extraction is defensive (price-extract.mjs)
// and every result lands in the review queue, never directly on the map.

import fs from "node:fs";
import path from "node:path";
import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { extractMinPrice } from "../lib/price-extract.mjs";

function sampleDate(daysAhead = 30) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {Promise<Array<{routeKey, fromPrice, currency, sampleDate, evidenceUrl}>>}
 */
export async function probePrices(entry, ctx) {
  const sampleRoutes = entry.probe?.pricing?.sampleRoutes ?? 4;
  const date = sampleDate();

  let njFile;
  try {
    njFile = JSON.parse(
      fs.readFileSync(
        path.join(ctx.rootDir, "public", "data", "scraped", entry.output),
        "utf8",
      ),
    );
  } catch {
    return [];
  }
  const trains = njFile?.data?.trains ?? {};
  const seenRoutes = ctx.seenRoutes ?? new Set();

  // Pick trains whose synthetic route key is live and whose endpoint stations
  // carry numeric EVA ids (required by the connection API).
  const candidates = Object.entries(trains)
    .map(([lineName, train]) => {
      const routeKey = `nj_standalone_${lineName.replace(/\s+/g, "_")}`;
      const stations = train.stations ?? [];
      const from = stations[0]?.id;
      const to = stations[stations.length - 1]?.id;
      if (!seenRoutes.has(routeKey)) return null;
      if (!/^\d+$/.test(String(from ?? "")) || !/^\d+$/.test(String(to ?? ""))) return null;
      return { routeKey, lineName, from: String(from), to: String(to) };
    })
    .filter(Boolean)
    .slice(0, sampleRoutes);

  const results = [];
  for (const c of candidates) {
    const url = `https://www.nightjet.com/nj-booking-ocp/connection/${c.from}/${c.to}/${date}`;
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        console.warn(`[probe:nj] ${c.lineName}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const fromPrice = extractMinPrice(data);
      if (fromPrice == null) {
        console.warn(`[probe:nj] ${c.lineName}: no price field found`);
        continue;
      }
      results.push({
        routeKey: c.routeKey,
        fromPrice,
        currency: "EUR",
        sampleDate: date,
        evidenceUrl: url,
      });
      console.log(`[probe:nj] ${c.lineName}: from €${fromPrice} (${date})`);
    } catch (err) {
      console.warn(`[probe:nj] ${c.lineName}: ${err.message}`);
    }
  }
  return results;
}
