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
 * actually begins or ends, busiest first.
 * @param {number} limit
 */
export function getTopStartCities(limit = 24) {
  const index = getPlanIndex();
  if (!index) return [];
  return index.cities
    .filter((city) => city.terminusCount > 0)
    .sort((a, b) => b.legCount - a.legCount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ slug, name, country, legCount, terminusCount }) => ({
      slug,
      name,
      country,
      legCount,
      terminusCount,
    }));
}
