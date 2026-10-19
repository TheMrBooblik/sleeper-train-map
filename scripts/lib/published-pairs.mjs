/**
 * The connection pages as the build emits them, rebuilt from the published
 * artifact in raw node.
 *
 * `aggregate.js` and `data.js` are the real source of this, and neither loads
 * outside the Next build — they reach `src/components/Map/utils/routeStyleUtils`
 * through an extensionless specifier. So the pieces they use that ARE
 * dependency-free (`cityForStation`, `buildPairSlug`, `orderCityPair`,
 * `formatTrainNumber`, the calendar) are composed here the same way, which is
 * how `verify-seo-urls` already reads the payload.
 *
 * Times are taken from the published plan index rather than from the viewMap
 * row, because a synthetic row states none of its own: ÖBB's NJ 13486 carries
 * no `origin_departure_time_0`, and `getRouteDetail` falls back to the first
 * operator-feed stop for it. The plan index is that same enriched stop list,
 * already committed, so a reconstruction that skipped it would test the
 * fallback path on exactly the pages the experiment cares about most.
 */
import fs from "node:fs";
import path from "node:path";

import { cityForStation } from "../../src/lib/seo/cities.mjs";
import { buildPairSlug, orderCityPair } from "../../src/lib/seo/slugify.mjs";
import { formatTrainNumber, splitAgencyIds } from "../../src/lib/operatorAgencies.mjs";
import { OPERATORS } from "../../src/lib/seo/operatorNames.mjs";
import { formatDurationMinutes, routeDurationMinutes } from "../../src/lib/seo/format.js";
import { formatMoney } from "../../src/lib/fareClasses.mjs";
import { resolvePricing } from "../../src/lib/pricingResolve.mjs";
import { parseBotServiceString, renderCalendar } from "../../src/pages/api/lib/calendar.mjs";
import { rowNextDeparture } from "../../src/lib/nextDeparture.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

/**
 * "from €40", as `formatFromPrice()` (src/lib/operatorPricing.js) renders a
 * route's resolved pricing — that module imports its JSON without an import
 * attribute and cannot load in raw node, so its two lines are restated here.
 * A price now reaches the snippet: European Sleeper's rows carry their fare
 * calendar's cheapest night.
 */
function formatFromPrice(pricing) {
  if (!pricing || pricing.fromPrice == null) return "";
  const amount = pricing.fromPrice;
  return typeof amount === "number" && Number.isFinite(amount)
    ? `from ${formatMoney(amount, pricing.currency)}`
    : "";
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/** Rendered "days of operation" for a direction, as `data.js` renders it. */
function serviceDaysFor(raw) {
  if (!raw) return "";
  try {
    return renderCalendar(parseBotServiceString(raw)) || raw;
  } catch {
    return raw;
  }
}

/** routeId:direction -> { departure, arrival, stopCount } from the plan index. */
function planClocks() {
  const index = readJson("public/data/published/plan-index.json");
  const out = new Map();
  for (const leg of index.legs || []) {
    const stops = leg.stops || [];
    out.set(`${leg.routeId}:${leg.direction}`, {
      departure: leg.departure || stops[0]?.[3] || stops[0]?.[2] || "",
      arrival: leg.arrival || stops[stops.length - 1]?.[2] || "",
      stopCount: stops.length,
    });
  }
  return out;
}

/**
 * Every published city pair, with the inputs `connectionSnippet()` takes.
 *
 * @returns {{slug:string, cityA:string, cityB:string, trainCount:number,
 *            operatorNames:string, fromPrice:string, directions:object[]}[]}
 */
export function getPublishedPairs({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const payload = readJson("public/data/published/initial-data.json").data;
  // Endpoint coordinates, so the duration plausibility gate is exercised here
  // the same way the build exercises it.
  const stopPos = new Map();
  for (const stop of payload.stops || []) {
    const lat = Number(stop?.stop_lat);
    const lon = Number(stop?.stop_lon);
    if (stop?.stop_name && Number.isFinite(lat) && Number.isFinite(lon)) {
      stopPos.set(String(stop.stop_name), [lat, lon]);
    }
  }
  const disabled = new Set(readJson("data/overrides/disabled-routes.json").map(String));
  const operatorPricing = readJson("data/overrides/operator-pricing.json");
  const clocks = planClocks();

  const tripsByRoute = new Map();
  for (const trip of Object.values(payload.trips)) {
    const key = String(trip.route_id);
    if (!tripsByRoute.has(key)) tripsByRoute.set(key, []);
    tripsByRoute.get(key).push(trip);
  }

  const pairs = new Map();
  for (const route of Object.values(payload.viewMap)) {
    const routeId = String(route.route_id);
    if (disabled.has(routeId)) continue;

    const trips = tripsByRoute.get(routeId) || [];
    const factTrip = trips.find((t) => Number(t.direction_id) === 0) || trips[0] || null;
    // As `getRouteDetail` states it: measured from the row's own endpoint times
    // where an official source corrected them, the trip's figure otherwise.
    const durationText = formatDurationMinutes(routeDurationMinutes(route, factTrip));
    const pricing = resolvePricing(route, operatorPricing);
    const classes = (factTrip && factTrip.classes ? String(factTrip.classes) : "").trim();
    const operatorIds = splitAgencyIds(route.agency_id);
    const operatorNames = operatorIds
      .map((id) => OPERATORS[id]?.name)
      .filter(Boolean)
      .join(", ");

    for (const dir of [0, 1]) {
      const origin = route[`origin_trip_${dir}`];
      const destination = route[`destination_trip_${dir}`];
      if (!origin || !destination) continue;

      const originCity = cityForStation(origin);
      const destCity = cityForStation(destination);
      if (!originCity || !destCity || originCity === destCity) continue;

      const slug = buildPairSlug(originCity, destCity);
      if (!slug) continue;
      const [cityA, cityB] = orderCityPair(originCity, destCity);
      if (!pairs.has(slug)) {
        pairs.set(slug, {
          slug, cityA, cityB, routeIds: new Set(), operators: new Set(), agencyIds: new Set(), prices: [], directions: [],
          running: 0,
        });
      }
      const entry = pairs.get(slug);
      if (!entry.routeIds.has(routeId) && pricing?.fromPrice != null) entry.prices.push(pricing);
      if (!entry.routeIds.has(routeId) && !rowNextDeparture(route, today)) entry.running += 1;
      entry.routeIds.add(routeId);
      for (const name of operatorNames.split(", ").filter(Boolean)) entry.operators.add(name);
      for (const id of operatorIds) entry.agencyIds.add(id);

      const clock = clocks.get(`${routeId}:${dir}`) || {};
      entry.directions.push({
        trainLabel: formatTrainNumber(route[`trip_short_name_${dir}`], route.agency_id) || "",
        operator: operatorNames.split(", ")[0] || "",
        origin,
        destination,
        originCity,
        destinationCity: destCity,
        departure: route[`origin_departure_time_${dir}`] || clock.departure || "",
        arrival: route[`destination_arrival_time_${dir}`] || clock.arrival || "",
        serviceDays: serviceDaysFor(route[`service_id_${dir}`] || factTrip?.service_id || ""),
        stopCount: clock.stopCount || 0,
        originPos: stopPos.get(origin) || null,
        destinationPos: stopPos.get(destination) || null,
        durationText,
        classes,
      });
    }
  }

  return [...pairs.values()]
    .map((p) => {
      // The pair's cheapest route, as [pair].js picks it.
      const cheapest = p.prices.length
        ? p.prices.reduce((a, b) => (a.fromPrice <= b.fromPrice ? a : b))
        : null;
      return {
        slug: p.slug,
        cityA: p.cityA,
        cityB: p.cityB,
        trainCount: p.routeIds.size,
        operatorNames: [...p.operators].join(", "),
        // Every operator a train on the corridor names — what the snippet
        // rollout gates on (snippetVariantFor in src/lib/seo/snippet.mjs).
        agencyIds: [...p.agencyIds],
        fromPrice: formatFromPrice(cheapest),
        // Who prices the corridor's trains (pricing.source: a registry id for
        // a nightly official fare). The snippet report reads a page that
        // gained a price apart from its control group.
        priceSources: [...new Set(p.prices.map((x) => x.source).filter(Boolean))].sort(),
        // No train on the corridor runs now (a seasonal train out of season):
        // the page and its snippet lead with the next run under either variant.
        upcoming: p.running === 0,
        directions: p.directions,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
