// scripts/adapters/caucasus.mjs
// Caucasus railways: curated static routes (Georgian Railway, ADY) merged with
// the live railway.ge international-trains scrape (GR 371/372).

import { buildTrainsFromConfig, resolveConfigPath } from "./static-config.mjs";
import { fetchGRInternationalTrains } from "./railway-ge.mjs";

export async function run(entry, ctx) {
  const staticTrains = buildTrainsFromConfig(resolveConfigPath(entry, ctx));
  const grScraped = entry.params?.scrapeRailwayGe ? await fetchGRInternationalTrains() : {};
  const trains = { ...staticTrains, ...grScraped };
  ctx.write(entry.output, { uploadedAt: ctx.today, trains });
  console.log(`[scrape] stored ${Object.keys(trains).length} Caucasus trains`);
}
