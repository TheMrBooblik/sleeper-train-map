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

import { buildLegs, segmentOf } from "../src/lib/plan/legs.mjs";
import { distanceKm } from "../src/components/Map/utils/returnGeometryBranches.js";
import { hydratePlanIndex, packPlanIndex } from "../src/lib/plan/index-codec.mjs";
import { prominenceLookup, scoreCities } from "../src/lib/plan/prominence.mjs";
import CITY_PROMINENCE from "../data/overrides/city-prominence.json" with { type: "json" };
import { buildPairSlug } from "../src/lib/seo/slugify.mjs";
import { cityForStation } from "../src/lib/seo/cities.mjs";
import { getStationTimesForTrain } from "../src/lib/seo/stationTimes.mjs";
import { resolvePricing } from "../src/lib/pricingResolve.mjs";
import { normalizeCountryCode, OPERATOR_COUNTRY_FALLBACK } from "../src/lib/seo/countries.js";
import OPERATOR_PRICING from "../data/overrides/operator-pricing.json" with { type: "json" };
import { stripDisabledRoutes } from "../src/pages/api/lib/build-initial-data.mjs";
import DISABLED_ROUTES from "../data/overrides/disabled-routes.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLISHED = path.join(ROOT, "public/data/published/initial-data.json");
const RAW_STOPS = path.join(ROOT, "public/data/scraped/backontrack-stops.json");

/**
 * Faster than any sleeper runs, straight-line. Night trains average 60–90 km/h
 * over the ground; the fastest legitimate leg in the payload implies 134. At
 * 160 the only thing above the line is a journey time that lost a day.
 */
const MAX_PLAUSIBLE_KMH = 160;
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

  // Station → ISO-2. Two sources, because neither covers everything: the raw
  // Back-on-Track stop index knows its own 29k stations, and the rows carry
  // `origin_country_*` stamps for endpoints — which is the only source for a
  // synthetic operator's stations, since those are absent from BoT's index.
  const countryIndex = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(RAW_STOPS, "utf8"));
    const rows = Array.isArray(raw.data) ? raw.data : Object.values(raw.data ?? raw);
    for (const stop of rows) {
      const code = normalizeCountryCode(stop?.stop_country);
      if (!code) continue;
      // Index every spelling the table carries. Back-on-Track stores Ukrainian
      // stations in Cyrillic ("Київ Пасажирський") while every route spells
      // them in Latin ("Kyiv Pasazhyrskyi"), so a stop_name-only index misses
      // Ukraine entirely — which is exactly the set this ranking has to be able
      // to see. `stop_name_romanized` is the column that bridges it.
      for (const key of [stop.stop_name, stop.stop_name_romanized, stop.stop_name_alt]) {
        if (key) countryIndex.set(String(key).trim().toLowerCase(), code);
      }
    }
  } catch {
    // No raw stops file (a fresh clone before a scrape) — the row stamps below
    // still cover every endpoint, which is what the ranking actually reads.
  }
  for (const route of Object.values(payload.viewMap)) {
    for (const dir of [0, 1]) {
      for (const [stationKey, countryKey] of [
        [`origin_trip_${dir}`, `origin_country_${dir}`],
        [`destination_trip_${dir}`, `destination_country_${dir}`],
      ]) {
        const station = route[stationKey];
        const code = normalizeCountryCode(route[countryKey]);
        if (station && code) countryIndex.set(String(station).toLowerCase(), code);
      }
    }
  }
  // A synthetic operator's stations are not in Back-on-Track's table at all
  // (Beijing, Chengdu, Amtrak's network), so they fall back to the operator's
  // own country — the same map the SEO layer uses for the same reason.
  const countryForOperators = (operatorIds = []) => {
    for (const id of operatorIds) {
      const code = OPERATOR_COUNTRY_FALLBACK[id]?.[0];
      if (code) return normalizeCountryCode(code);
    }
    return "";
  };
  const countryForStation = (station, operatorIds) =>
    countryIndex.get(String(station).trim().toLowerCase()) ||
    countryForOperators(operatorIds) ||
    "";

  const { legs, cities } = buildLegs(payload, {
    pairSlugFor,
    stopTimesFor,
    pricingFor,
    countryForStation,
  });

  // A journey time nobody could have run.
  //
  // Two endpoint clocks cannot express more than a day, so `durationBetween`
  // wraps and the longest trains in the dataset read as the shortest: the
  // Cardinal 26h30 as 3h28, the Canadian's four days as 65 minutes, the Doğu
  // Express as 2h26. `trip.duration` fixes the rows that have a trip, but a
  // synthetic row has none and its feed times carry no date — so for those
  // there is no correct number to be had anywhere in the data.
  //
  // What there is, is proof the number is wrong: straight-line distance divided
  // by the stated time. Anything implying more than MAX_PLAUSIBLE_KMH over the
  // ground it covers is not a sleeper, and great-circle distance UNDERSTATES
  // the track, so the real implied speed is higher still. Such a leg keeps its
  // stops and its times and simply withholds its duration — a blank beats a
  // figure that is a day out, and it stops the short-ride filter deleting the
  // longest trains we carry.
  const stopPos = new Map();
  for (const stop of payload.stops ?? []) {
    const lat = Number(stop?.stop_lat);
    const lon = Number(stop?.stop_lon);
    if (stop?.stop_name && Number.isFinite(lat) && Number.isFinite(lon)) {
      stopPos.set(String(stop.stop_name).trim().toLowerCase(), [lat, lon]);
    }
  }
  let suspect = 0;
  for (const leg of legs) {
    // The end-to-end ride as a reader would see it. NOT leg.durationMinutes:
    // a synthetic row states no endpoint times of its own, and its journey time
    // comes from the per-stop feed clocks that segmentOf reads — which is
    // exactly where the wrapped figures live.
    const whole = segmentOf(leg, 0, leg.stops.length - 1);
    const minutes = whole?.durationMinutes ?? leg.durationMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const a = stopPos.get(leg.stops[0].station.trim().toLowerCase());
    const b = stopPos.get(leg.stops[leg.stops.length - 1].station.trim().toLowerCase());
    if (!a || !b) continue;
    const km = distanceKm(a[0], a[1], b[0], b[1]);
    if (km / (minutes / 60) > MAX_PLAUSIBLE_KMH) {
      leg.durationSuspect = true;
      leg.durationMinutes = null;
      suspect++;
    }
  }

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
  // Suggestion weighting, computed once here so the picker, the landing chips
  // and the destination tie-break all read one number.
  scoreCities(legs, slim, prominenceLookup(CITY_PROMINENCE));
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
  const withCountry = expanded.cities.filter((c) => c.country).length;
  const damped = expanded.cities.filter((c) => c.prominence < 1).length;
  console.log(
    `[build-plan-index] ${withDays} legs have operating days, ${cadence} state only a cadence, ` +
      `${expanded.legs.length - withDays - cadence} have nothing, ${timed} have both endpoint times`,
  );
  const shortHops = expanded.legs.filter((l) => {
    const whole = segmentOf(l, 0, l.stops.length - 1);
    return Number.isFinite(whole?.durationMinutes) && whole.durationMinutes < 240;
  }).length;
  const suspectLegs = expanded.legs.filter((l) => l.durationSuspect).length;
  const priced = expanded.legs.filter((l) => l.pricing?.fromPrice != null).length;
  const advised = expanded.legs.filter((l) => l.pricing?.type).length;
  console.log(
    `[build-plan-index] ${perStop} legs carry per-stop feed times (${stopClocks} stop clocks), ` +
      `${hubs} of ${expanded.cities.length} cities are a terminus, ` +
      `${withCountry} have a country, ${damped} de-emphasised in suggestions`,
  );
  console.log(
    `[build-plan-index] ${advised} legs carry pricing advice, ${priced} carry a from-price`,
  );
  console.log(
    `[build-plan-index] ${suspectLegs} legs withhold an unbelievable duration, ` +
      `${shortHops} run end-to-end in under 4h`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
