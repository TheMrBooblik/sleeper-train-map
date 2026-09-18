/**
 * Build-time reader for the committed plan index.
 *
 * Same shape as src/lib/seo/data.js: a getStaticProps-time fs read out of
 * public/, memoized per process. NOT for an API route — Next does not trace a
 * dynamic file read into the lambda bundle, which is why the planner serves its
 * data as a static asset the browser fetches rather than through an endpoint.
 */

import fs from "node:fs";
import path from "node:path";

import { hydratePlanIndex } from "./index-codec.mjs";
import { byStartCityScore, prominenceLookup } from "./prominence.mjs";
import { START_CITY_LIMIT, topStartCitiesByRegion } from "./regions.mjs";
import CITY_PROMINENCE from "../../../data/overrides/city-prominence.json" with { type: "json" };

const INDEX_PATH = "public/data/published/plan-index.json";

let _index = null;

/** @returns {object|null} the expanded index, or null when it has not been built */
export function getPlanIndex() {
  if (_index === null) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), INDEX_PATH), "utf8"),
      );
      _index = hydratePlanIndex(raw);
    } catch {
      // A missing index must never fail the build: the planner page renders
      // from the asset the client fetches, and these props are only the
      // pre-rendered city chips.
      _index = false;
    }
  }
  return _index || null;
}

/**
 * The cities worth offering as a starting point: somewhere a night train
 * actually begins or ends, ranked by how many night trains serve it.
 *
 * Every region's top, not the global one. The page shows one region at a time
 * and these props are what it paints before the index finishes downloading —
 * with only the default region pre-rendered, switching tabs on a slow
 * connection would land on an empty list.
 *
 * The count shown on a chip IS the sort key (see startCityScore); ranking by
 * one number and printing another is what made this list read as alphabetical.
 * @param {number} limit - per region
 */
export function getTopStartCities(limit = START_CITY_LIMIT) {
  const index = getPlanIndex();
  if (!index) return [];
  const compare = byStartCityScore(prominenceLookup(CITY_PROMINENCE, "always"));
  const byRegion = topStartCitiesByRegion(index.cities, { limit, compare });
  return [...byRegion.values()]
    .flat()
    .map(({ slug, name, country, legCount, terminusCount, routeCount, prominence }) => ({
      slug,
      name,
      country,
      legCount,
      terminusCount,
      routeCount,
      prominence,
    }));
}
