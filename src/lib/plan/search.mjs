/**
 * The two questions the planner answers.
 *
 *   1. "I don't know where I want to go."   departuresFrom(city, date)
 *   2. "I know where I want to go."         findJourneys(from, to, date)
 *
 * Both run over the leg graph from legs.mjs. The second is the interesting one:
 * a night train network is sparse, so most city pairs have no direct sleeper
 * and the honest answer is a chain of nights — Amsterdam → Berlin → Prague →
 * Vienna. That chain is the product, not a fallback, which is why the search
 * returns multi-leg journeys ranked beside direct ones rather than an empty
 * result with a shrug.
 *
 * Pure: no fetching, no dates from the clock, no DOM. Everything comes in.
 */

import { indexLegsByCity, segmentOf } from "./legs.mjs";
import { availabilityFor, isOfferable, STATUS_RANK } from "./availability.mjs";
import { addDays, clampStay, hopDates } from "./url.mjs";

/** Wrap a raw index (legs + cities) with the lookups the search needs. */
export function createPlanner(index) {
  const legs = index?.legs ?? [];
  const cities = index?.cities ?? [];
  const byCity = indexLegsByCity(legs);
  const cityBySlug = new Map(cities.map((c) => [c.slug, c]));
  return { legs, cities, byCity, cityBySlug, generatedAt: index?.generatedAt || "" };
}

/**
 * One boardable ride: a leg, where you get on, where you get off, and whether
 * it runs that night.
 */
function rideFor(leg, boardIndex, alightIndex, date) {
  const segment = segmentOf(leg, boardIndex, alightIndex);
  if (!segment) return null;
  return {
    key: `${leg.id}:${boardIndex}-${alightIndex}`,
    legId: leg.id,
    routeId: leg.routeId,
    train: leg.train,
    operatorIds: leg.operatorIds,
    pairSlug: leg.pairSlug,
    fromPrice: leg.fromPrice,
    date,
    ...segment,
    availability: availabilityFor(leg, date),
  };
}

/**
 * Where a night train could take you from one city.
 *
 * @param {ReturnType<createPlanner>} planner
 * @param {{from: string, date: string, includeUnavailable?: boolean}} query
 * @returns {{city: object|null, destinations: object[]}}
 *   destinations are grouped per city, each with the rides that serve it.
 */
export function departuresFrom(planner, { from, date, includeUnavailable = false } = {}) {
  const city = planner.cityBySlug.get(from) || null;
  const calls = planner.byCity.get(from) || [];
  const grouped = new Map();

  for (const { leg, index } of calls) {
    for (let j = index + 1; j < leg.stops.length; j++) {
      const ride = rideFor(leg, index, j, date);
      if (!ride) continue;
      if (!includeUnavailable && !isOfferable(ride.availability.status)) continue;

      const slug = ride.to.citySlug;
      if (slug === from) continue;
      if (!grouped.has(slug)) {
        grouped.set(slug, {
          city: planner.cityBySlug.get(slug) || { slug, name: ride.to.city, country: "" },
          rides: [],
        });
      }
      grouped.get(slug).rides.push(ride);
    }
  }

  const destinations = [...grouped.values()].map((entry) => {
    entry.rides.sort(compareRides);
    return { ...entry, best: entry.rides[0] };
  });
  destinations.sort(compareDestinations);
  return { city, destinations };
}

/** Best first: confirmed over unconfirmed, then a night's sleep over an evening
 *  hop, then the whole route, then the earlier departure. */
function compareRides(a, b) {
  const rank = STATUS_RANK[a.availability.status] - STATUS_RANK[b.availability.status];
  if (rank) return rank;
  if (a.isOvernight !== b.isOvernight) return a.isOvernight ? -1 : 1;
  if (a.isWholeRoute !== b.isWholeRoute) return a.isWholeRoute ? -1 : 1;
  const depA = a.departure || "99:99";
  const depB = b.departure || "99:99";
  if (depA !== depB) return depA < depB ? -1 : 1;
  return String(a.to.city).localeCompare(String(b.to.city));
}

/**
 * Which destination to show first.
 *
 * Alphabetical put Amersfoort, Bad Schandau and Děčín above Berlin and Prague —
 * they are all stops of the same train, and listing them by name turns "where
 * could you go tonight" into that train's stopping pattern. So: what we can
 * stand behind first, then somewhere you would actually sleep on the way to,
 * then the city more night trains serve.
 */
function compareDestinations(a, b) {
  const rank =
    STATUS_RANK[a.best.availability.status] - STATUS_RANK[b.best.availability.status];
  if (rank) return rank;
  if (a.best.isOvernight !== b.best.isOvernight) return a.best.isOvernight ? -1 : 1;
  const hub = (b.city.legCount ?? 0) - (a.city.legCount ?? 0);
  if (hub) return hub;
  return String(a.city.name).localeCompare(String(b.city.name), undefined, {
    sensitivity: "base",
  });
}

/**
 * Every ride that gets you from one city to another on a given night.
 * @returns {object[]} ranked, best first
 */
export function ridesBetween(planner, { from, to, date, includeUnavailable = true } = {}) {
  const calls = planner.byCity.get(from) || [];
  const rides = [];
  for (const { leg, index } of calls) {
    for (let j = index + 1; j < leg.stops.length; j++) {
      if (leg.stops[j].citySlug !== to) continue;
      const ride = rideFor(leg, index, j, date);
      if (!ride) continue;
      if (!includeUnavailable && !isOfferable(ride.availability.status)) continue;
      rides.push(ride);
    }
  }
  rides.sort(compareRides);
  return rides;
}

/**
 * Resolve a chain of cities the user has already chosen into dated hops.
 *
 * This is what a saved plan renders: the cities are fixed, one night per hop,
 * and each hop departs the day after the previous one arrives plus any
 * stopover nights. A hop with no train is reported as a hop with no train —
 * the plan stays intact and says where it breaks.
 *
 * @param {ReturnType<createPlanner>} planner
 * @param {{cities: string[], date: string, stays?: number[]}} plan
 * @returns {{hops: object[], complete: boolean, nights: number, endDate: string}}
 */
export function resolvePlan(planner, { cities = [], date, stays = [] } = {}) {
  const hopCount = Math.max(0, cities.length - 1);
  const dates = hopDates(date, hopCount, stays);
  const hops = [];

  for (let i = 0; i < hopCount; i++) {
    const from = cities[i];
    const to = cities[i + 1];
    const hopDate = dates[i];
    const rides = ridesBetween(planner, { from, to, date: hopDate });
    hops.push({
      index: i,
      from: planner.cityBySlug.get(from) || { slug: from, name: titleFromSlug(from) },
      to: planner.cityBySlug.get(to) || { slug: to, name: titleFromSlug(to) },
      date: hopDate,
      stayNights: i > 0 ? clampStay(stays[i - 1] ?? 0) : 0,
      rides,
      best: rides[0] || null,
      // A hop is served when at least one train could plausibly run it.
      served: rides.some((r) => isOfferable(r.availability.status)),
    });
  }

  const stopoverNights = stays
    .slice(0, Math.max(0, hopCount - 1))
    .reduce((sum, n) => sum + clampStay(n), 0);
  // Not every hop is a night on a train. Berlin → Prague at 18:13 arriving
  // 22:16 is a four-hour evening ride, and counting it as a night of sleeper
  // travel is the planner telling a traveller they have a bed booked.
  const sleeperNights = hops.filter((h) => h.best?.isOvernight).length;
  return {
    hops,
    complete: hops.length > 0 && hops.every((h) => h.served),
    nights: hopCount + stopoverNights,
    sleeperNights,
    endDate: hopCount ? addDays(dates[hopCount - 1], 1) : date,
  };
}

/** "berlin" → "Berlin", for a city slug the dataset does not know. */
export function titleFromSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Can you break a journey here?
 *
 * Only where trains actually START or END. Every stop on a leg is somewhere you
 * could step off, but that is not the same as somewhere to spend a day and
 * catch another sleeper — and without this rule the search answers "Amsterdam →
 * Vienna" with a change at Bad Schandau and another at Děčín, two village stops
 * on the through train it should have offered directly. `terminusCount` is set
 * by the index build: how many legs begin or end in that city.
 */
export function isInterchange(planner, slug) {
  const city = planner.cityBySlug.get(slug);
  return Boolean(city && city.terminusCount > 0);
}

/**
 * Suggest chains of nights from one city to another, including the direct one.
 *
 * A breadth-first walk over the city graph, bounded by maxLegs. Availability is
 * checked per hop on that hop's own date, so a two-night route is judged on the
 * two nights it would actually use rather than on the departure date twice.
 *
 * @param {ReturnType<createPlanner>} planner
 * @param {{from: string, to: string, date: string, maxLegs?: number, limit?: number}} query
 * @returns {object[]} journeys, direct first, then fewest nights
 */
export function findJourneys(planner, { from, to, date, maxLegs = 3, limit = 12 } = {}) {
  if (!from || !to || from === to) return [];

  const journeys = [];
  const seen = new Set();
  /** @type {{cities: string[], date: string}[]} */
  let frontier = [{ cities: [from], date }];

  for (let depth = 0; depth < maxLegs && frontier.length; depth++) {
    const next = [];
    for (const path of frontier) {
      const tail = path.cities[path.cities.length - 1];
      const { destinations } = departuresFrom(planner, {
        from: tail,
        date: path.date,
        includeUnavailable: false,
      });

      for (const destination of destinations) {
        const slug = destination.city.slug;
        // No revisiting: a night train trip that returns to a city it already
        // slept in is a worse answer than the shorter path that stopped there.
        if (path.cities.includes(slug)) continue;
        const cities = [...path.cities, slug];

        if (slug === to) {
          const key = cities.join(">");
          if (seen.has(key)) continue;
          seen.add(key);
          journeys.push(buildJourney(planner, cities, date));
          continue;
        }
        // Only keep growing a path that could still be shorter than maxLegs,
        // and only through a city you can actually change trains in.
        if (depth + 1 < maxLegs && isInterchange(planner, slug)) {
          next.push({ cities, date: addDays(path.date, 1) });
        }
      }
    }
    // Breadth-first over a graph this dense needs a cap, or the third level is
    // tens of thousands of paths for an answer nobody scrolls to. Biggest hubs
    // first, so the cap drops the least promising paths rather than the tail of
    // whatever order the legs happened to be in.
    next.sort(
      (a, b) =>
        (planner.cityBySlug.get(b.cities[b.cities.length - 1])?.terminusCount ?? 0) -
        (planner.cityBySlug.get(a.cities[a.cities.length - 1])?.terminusCount ?? 0),
    );
    frontier = next.slice(0, 400);
  }

  journeys.sort(
    (a, b) =>
      a.hops.length - b.hops.length ||
      (a.complete === b.complete ? 0 : a.complete ? -1 : 1) ||
      a.nights - b.nights ||
      interchangeWeight(planner, b) - interchangeWeight(planner, a),
  );
  return journeys.slice(0, limit);
}

/** Prefer a change in a big hub over a change in a one-train terminus. */
function interchangeWeight(planner, journey) {
  return journey.cities
    .slice(1, -1)
    .reduce((sum, slug) => sum + (planner.cityBySlug.get(slug)?.legCount ?? 0), 0);
}

function buildJourney(planner, cities, date) {
  const resolved = resolvePlan(planner, { cities, date });
  return { cities, date, ...resolved };
}
