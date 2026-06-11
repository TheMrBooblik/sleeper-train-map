// scripts/adapters/regiojet-api.mjs
// Weekly price probe for RegioJet via their public search API. Probe pairs
// are configured in the registry entry (no code per route):
//   probe.pricing.pairs = [{ "routeKey": "...", "from": "10202003",
//                            "to": "...", "label": "Praha – Chop" }]
// Station ids match the ones used in data/overrides/operator-booking.json.

import { fetchWithTimeout } from "../lib/scrape-helpers.mjs";
import { extractMinPrice } from "../lib/price-extract.mjs";

const RJ_SEARCH =
  "https://brn-ybus-pubapi.sa.cz/restapi/routes/search/simple";

function sampleDate(daysAhead = 30) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function probePrices(entry) {
  const pairs = entry.probe?.pricing?.pairs ?? [];
  const date = sampleDate();
  const results = [];

  for (const pair of pairs) {
    if (!pair?.routeKey || !pair?.from || !pair?.to) continue;
    const url =
      `${RJ_SEARCH}?fromLocationId=${encodeURIComponent(pair.from)}` +
      `&toLocationId=${encodeURIComponent(pair.to)}` +
      `&fromLocationType=STATION&toLocationType=STATION` +
      `&departureDate=${date}&tariffs=REGULAR`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: { accept: "application/json", "User-Agent": "train-map/1.0" },
      });
      if (!res.ok) {
        console.warn(`[probe:rj] ${pair.label ?? pair.routeKey}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const fromPrice = extractMinPrice(data);
      if (fromPrice == null) continue;
      results.push({
        routeKey: pair.routeKey,
        fromPrice,
        currency: "EUR",
        sampleDate: date,
        evidenceUrl: url,
      });
      console.log(`[probe:rj] ${pair.label ?? pair.routeKey}: from €${fromPrice}`);
    } catch (err) {
      console.warn(`[probe:rj] ${pair.label ?? pair.routeKey}: ${err.message}`);
    }
  }
  return results;
}
