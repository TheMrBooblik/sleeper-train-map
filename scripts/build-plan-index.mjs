#!/usr/bin/env node
/**
 * Regenerate public/data/published/plan-index.json — the planner's whole
 * dataset, as one static asset.
 *
 * Run: npm run build-plan-index   (also runs nightly, after canonicalize)
 *
 * WHY A FILE AND NOT AN API. The planner needs the leg graph to answer anything
 * at all: "where can I go from Amsterdam" reads every route, and so does every
 * keystroke of the city autocomplete. Serving that per request means re-merging
 * and re-projecting the payload on each one, for data that changes once a night.
 * As a committed artifact it costs nothing: next.config.js already gives
 * /data/:path+ real cache lifetimes, public/sw.js already serves everything
 * under /data/ stale-while-revalidate, and the page itself stays static — which
 * is what lets a shared plan URL resolve without a serverless hop.
 *
 * Disabled routes are stripped exactly as /api/initial-data strips them, so the
 * planner can never offer a route the admin turned off — the same fault the SEO
 * layer had until getPublished() learned to apply the strip.
 */

import fs from "node:fs";
import path from "node:path";

import { buildLegs } from "../src/lib/plan/legs.mjs";
import { hydratePlanIndex, packPlanIndex } from "../src/lib/plan/index-codec.mjs";
import { buildPairSlug } from "../src/lib/seo/slugify.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";
import { getStationTimesForTrain } from "../src/lib/seo/stationTimes.mjs";
import { resolvePricing } from "../src/lib/pricingResolve.mjs";
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };
import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";
import DISABLED_ROUTES from "../data/overrides/disabled-routes.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLISHED = path.join(ROOT, "public/data/published/initial-data.json");
const OUT = path.join(ROOT, "public/data/published/plan-index.json");

/** Read the published payload in either of the two shapes it is written in. */
export function readPublished(file = PUBLISHED) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const data = raw.data || raw;
  return { data, uploadedAt: raw.uploadedAt || raw.generatedAt || "" };
}

/**
 * Build the index from an already-stripped payload. Exported so the verify
 * suite can rebuild it from the same input and compare, rather than trusting
 * the committed file.
 */
export function buildPlanIndex(payload, { generatedAt = "" } = {}) {
  // A leg's connection page is the pair of its own endpoints, whichever way it
  // runs — the same undirected slug /connections/{a}-to-{b} is built from.
  const pairSlugFor = (routeId, direction) => {
    const route = payload.viewMap[routeId] ?? payload.viewMap[Number(routeId)];
    if (!route) return "";
    const origin = route[`origin_trip_${direction}`];
    const destination = route[`destination_trip_${direction}`];
    if (!origin || !destination) return "";
    const a = cityForStation(origin);
    const b = cityForStation(destination);
    return a && b && a !== b ? buildPairSlug(a, b) : "";
  };

  // Per-stop times, where an operator feed carries the train. Endpoint-matched
  // inside getStationTimesForTrain, so a bare number that two operators both
  // use cannot lend one train the other's clock — the collision this repo has
  // met four times over. Only the build can do this: the raw feeds live on
  // disk under public/data/scraped/, which no lambda should be reading.
  const stopTimesFor = ({ train, origin, destination }) => {
    if (!train) return null;
    let stations = null;
    try {
      stations = getStationTimesForTrain(train, { origin, destination });
    } catch {
      return null;
    }
    if (!stations) return null;
    const byName = new Map();
    for (const stop of stations) {
      if (stop?.name) byName.set(stop.name, { arrival: stop.arrival, departure: stop.departure });
    }
    return byName.size ? byName : null;
  };

  const pricingFor = (route) => resolvePricing(route, OPERATOR_PRICING);

  const { legs, cities } = buildLegs(payload, { pairSlugFor, stopTimesFor, pricingFor });

  // A city is worth CHANGING trains in when trains actually start or end there.
  // Without this the journey search happily routes Amsterdam → Vienna via Bad
  // Schandau and Děčín — two village stops on the same through train, offered
  // as if they were a place to break the trip.
  const terminusLegs = new Map();
  for (const leg of legs) {
    for (const end of [leg.stops[0], leg.stops[leg.stops.length - 1]]) {
      terminusLegs.set(end.citySlug, (terminusLegs.get(end.citySlug) || 0) + 1);
    }
  }
  for (const city of cities) city.terminusCount = terminusLegs.get(city.slug) || 0;
  // The per-city station list is build scaffolding — the planner works in
  // cities, and shipping it would be a third of the file for nothing.
  const slim = cities.map(({ stations, ...city }) => city);
  return packPlanIndex({
    version: 1,
    generatedAt,
    counts: { legs: legs.length, cities: slim.length },
    cities: slim,
    legs,
  });
}

function main() {
  const { data, uploadedAt } = readPublished();
  const payload = stripDisabledRoutes(data, DISABLED_ROUTES);
  const index = buildPlanIndex(payload, { generatedAt: uploadedAt });
  // Report against the EXPANDED shape: read packed, `stop.arrival` is undefined
  // on every stop and the run cheerfully reports zero per-stop times for an
  // index that has four thousand of them.
  const expanded = hydratePlanIndex(index);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(index)}\n`);

  const bytes = fs.statSync(OUT).size;
  const timed = expanded.legs.filter((l) => l.departure && l.arrival).length;
  const withDays = expanded.legs.filter((l) => l.days.length).length;
  const cadence = expanded.legs.filter((l) => l.cadence).length;
  console.log(
    `[build-plan-index] ${index.legs.length} legs, ${index.cities.length} cities, ` +
      `${(bytes / 1024).toFixed(0)} KB`,
  );
  const perStop = expanded.legs.filter((l) => l.stops.some((s) => s.arrival || s.departure)).length;
  const stopClocks = expanded.legs
    .flatMap((l) => l.stops)
    .filter((s) => s.arrival || s.departure).length;
  const hubs = expanded.cities.filter((c) => c.terminusCount > 0).length;
  console.log(
    `[build-plan-index] ${withDays} legs have operating days, ${cadence} state only a cadence, ` +
      `${expanded.legs.length - withDays - cadence} have nothing, ${timed} have both endpoint times`,
  );
  const priced = expanded.legs.filter((l) => l.pricing?.fromPrice != null).length;
  const advised = expanded.legs.filter((l) => l.pricing?.type).length;
  console.log(
    `[build-plan-index] ${perStop} legs carry per-stop feed times (${stopClocks} stop clocks), ` +
      `${hubs} of ${expanded.cities.length} cities are a terminus`,
  );
  console.log(
    `[build-plan-index] ${advised} legs carry pricing advice, ${priced} carry a from-price`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
