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

import { indexLegsByCity, isShortHop, MIN_TRIP_MINUTES, segmentOf } from "./legs.mjs";
import { availabilityFor, isOfferable, STATUS_RANK } from "./availability.mjs";
import { addDays, clampStay, daysBetween } from "./url.mjs";
import { suggestionScore } from "./prominence.mjs";
import { arrivalDayOffset, connectionBetween, segmentTimes } from "./timeline.mjs";

/** Wrap a raw index (legs + cities) with the lookups the search needs. */
export function createPlanner(index) {
  const legs = index?.legs ?? [];
  const cities = index?.cities ?? [];
  const byCity = indexLegsByCity(legs);
  const cityBySlug = new Map(cities.map((c) => [c.slug, c]));
  return {
    legs,
    cities,
    byCity,
    cityBySlug,
    generatedAt: index?.generatedAt || "",
    // Date-independent rides out of each city, filled in by the journey search.
    ridesFromCity: new Map(),
  };
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
    agencyId: leg.agencyId || "",
    pairSlug: leg.pairSlug,
    pricing: leg.pricing,
    date,
    ...segment,
    // When you are actually on board, in minutes after midnight of `date` —
    // what a change of trains is checked against (timeline.mjs).
    times: segmentTimes(leg, boardIndex, alightIndex),
    availability: availabilityFor(leg, date),
  };
}

/**
 * The calendar date you step off a ride: its night plus however many mornings
 * it runs into. Unknown → the usual sleeper's next morning.
 */
export function rideArrivalDate(ride) {
  if (!ride?.date) return "";
  return addDays(ride.date, Math.max(1, arrivalDayOffset(ride.times) ?? 1));
}

/**
 * Where a night train could take you from one city.
 *
 * @param {ReturnType<createPlanner>} planner
 * @param {{from: string, date: string, includeUnavailable?: boolean}} query
 * @returns {{city: object|null, destinations: object[]}}
 *   destinations are grouped per city, each with the rides that serve it.
 */
export function departuresFrom(planner, {
  from,
  date,
  includeUnavailable = false,
  includeShortHops = false,
} = {}) {
  const city = planner.cityBySlug.get(from) || null;
  const calls = planner.byCity.get(from) || [];
  const grouped = new Map();

  for (const { leg, index } of calls) {
    for (let j = index + 1; j < leg.stops.length; j++) {
      const ride = rideFor(leg, index, j, date);
      if (!ride) continue;
      if (!includeUnavailable && !isOfferable(ride.availability.status)) continue;
      // A ride we can prove is under four hours is not a sleeper journey, and
      // offering it here is what turned "where could you go tonight" into the
      // stopping pattern of whichever train happens to pass. An UNKNOWN
      // duration is kept: 31% of segments have none, and a long-distance train
      // whose stated time is not believable withholds it entirely.
      if (!includeShortHops && isShortHop(ride.durationMinutes)) continue;

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
 * Alphabetical turns "where could you go tonight" into a stopping pattern: from
 * Amsterdam it put Amersfoort and Bad Schandau above Berlin and Prague, and
 * from Paris it opened with Assier, Aubin, Capdenac, Cransac and Gramat — five
 * villages on the Rodez sleeper, above Rodez and Toulouse.
 *
 * So, in order: what we can stand behind, then somewhere you would actually
 * sleep on the way to, then whether the train ENDS there (a destination rather
 * than a stop it passes through at three in the morning), then how much of the
 * night-train network that city sees.
 */
function compareDestinations(a, b) {
  const rank =
    STATUS_RANK[a.best.availability.status] - STATUS_RANK[b.best.availability.status];
  if (rank) return rank;
  if (a.best.isOvernight !== b.best.isOvernight) return a.best.isOvernight ? -1 : 1;
  if (a.best.isTerminus !== b.best.isTerminus) return a.best.isTerminus ? -1 : 1;
  // Below every fact about the ride, and never above one: a confirmed train to
  // a de-emphasised city still outranks an unconfirmed train to a headline one.
  const suggested = suggestionScore(b.city) - suggestionScore(a.city);
  if (suggested) return suggested;
  return String(a.city.name).localeCompare(String(b.city.name), undefined, {
    sensitivity: "base",
  });
}

/**
 * Every ride that gets you from one city to another on a given night.
 *
 * Short hops are dropped here too — but never to the point of claiming a
 * corridor has no train. Someone who typed Brussels → Amsterdam asked about
 * that pair specifically, and European Sleeper really does run it in 3h09; the
 * honest answer is the train with a caveat, not "no night train we know of".
 * So when the filter would empty the result, the short rides come back and the
 * caller is told (`onlyShortHops`).
 *
 * @returns {{rides: object[], onlyShortHops: boolean}}
 */
export function ridesBetween(planner, { from, to, date, includeUnavailable = true } = {}) {
  const calls = planner.byCity.get(from) || [];
  const all = [];
  for (const { leg, index } of calls) {
    for (let j = index + 1; j < leg.stops.length; j++) {
      if (leg.stops[j].citySlug !== to) continue;
      const ride = rideFor(leg, index, j, date);
      if (!ride) continue;
      if (!includeUnavailable && !isOfferable(ride.availability.status)) continue;
      all.push(ride);
    }
  }
  all.sort(compareRides);
  const worthwhile = all.filter((r) => !isShortHop(r.durationMinutes));
  return worthwhile.length > 0
    ? { rides: worthwhile, onlyShortHops: false }
    : { rides: all, onlyShortHops: all.length > 0 };
}

/**
 * The first night after `date` on which a train could take you from one city to
 * another, or null when none does within `within` nights.
 *
 * A hop with no train on the chosen night is the planner's most common dead
 * end for someone who already knows where they are going — most sleepers run
 * two or three times a week — and "not this night" without a next one leaves
 * them paging through dates one by one. Offerable means the same as it does for
 * `served`: confirmed, or a train whose days we do not know.
 *
 * @returns {{date: string, nightsLater: number, status: string}|null}
 */
export function nextServedNight(planner, { from, to, date, within = 60, after = null } = {}) {
  if (!from || !to || !date) return null;
  for (let n = 1; n <= within; n++) {
    const night = addDays(date, n);
    const { rides } = ridesBetween(planner, { from, to, date: night });
    // `after` is the train you arrive on: a night is only an answer if the
    // onward train leaves after you get there.
    const ride = rides.find(
      (r) =>
        isOfferable(r.availability.status) &&
        (!after ||
          connectionBetween(after.arrival, r.times?.departure, daysBetween(after.date, night))
            .status !== "missed"),
    );
    if (ride) return { date: night, nightsLater: n, status: ride.availability.status };
  }
  return null;
}

/**
 * Resolve a chain of cities the user has already chosen into dated hops.
 *
 * This is what a saved plan renders: the cities are fixed, one train per hop,
 * and each hop leaves on the night after the previous train gets in plus any
 * stopover nights. "After it gets in" is read off that train's own clock: the
 * usual sleeper arrives the next morning, so the next one leaves that evening;
 * a 32-hour Reunification Express arrives the morning after that. A hop with no
 * train is reported as a hop with no train — the plan stays intact and says
 * where it breaks.
 *
 * Each hop after the first also says how the change works (`connection`): a
 * train that has left before you arrive is ranked last and does not count as
 * serving the hop, which is what used to put a 05:39 departure after a 09:39
 * arrival in the same plan.
 *
 * @param {ReturnType<createPlanner>} planner
 * `after` is the train you arrive in the first city on, when this plan is a
 * stretch of a longer one (a journey filling a gap): its first hop is then a
 * change like any other.
 *
 * @param {{cities: string[], date: string, stays?: number[], after?: object|null}} plan
 * @returns {{hops: object[], complete: boolean, nights: number, endDate: string}}
 */
export function resolvePlan(planner, { cities = [], date, stays = [], after: arrivingOn = null } = {}) {
  const hopCount = Math.max(0, cities.length - 1);
  const hops = [];

  for (let i = 0; i < hopCount; i++) {
    const from = cities[i];
    const to = cities[i + 1];
    const previous = hops[i - 1] || null;
    const arrivedOn = previous?.best || null;
    const hopDate = previous
      ? addDays(
          arrivedOn ? rideArrivalDate(arrivedOn) : addDays(previous.date, 1),
          clampStay(stays[i - 1] ?? 0),
        )
      : date;
    const { rides, onlyShortHops } = ridesBetween(planner, { from, to, date: hopDate });

    const after = arrivedOn
      ? { date: arrivedOn.date, arrival: arrivedOn.times?.arrival }
      : i === 0
        ? arrivingOn
        : null;
    if (after) {
      const nightsApart = daysBetween(after.date, hopDate);
      for (const ride of rides) {
        ride.connection = connectionBetween(after.arrival, ride.times?.departure, nightsApart);
      }
      // Stable: the order ridesBetween chose stands among the trains you can make.
      rides.sort(
        (a, b) =>
          Number(a.connection.status === "missed") - Number(b.connection.status === "missed"),
      );
    }

    hops.push({
      index: i,
      from: planner.cityBySlug.get(from) || { slug: from, name: titleFromSlug(from) },
      to: planner.cityBySlug.get(to) || { slug: to, name: titleFromSlug(to) },
      date: hopDate,
      stayNights: i > 0 ? clampStay(stays[i - 1] ?? 0) : 0,
      rides,
      best: rides[0] || null,
      // How the change from the previous train works, for the best train here.
      connection: after ? rides[0]?.connection ?? null : null,
      // The train you arrive on, for "when does the next one leave".
      after,
      // True when the only trains on this corridor are under four hours: the
      // hop is real but it is a day-train distance, and the UI says so rather
      // than presenting it as a night on a sleeper.
      onlyShortHops,
      // A hop is served when at least one train could plausibly run it — and
      // has not left before you get there.
      served: rides.some(
        (r) => isOfferable(r.availability.status) && r.connection?.status !== "missed",
      ),
    });
  }

  const stopoverNights = stays
    .slice(0, Math.max(0, hopCount - 1))
    .reduce((sum, n) => sum + clampStay(n), 0);
  // Not every hop is a night on a train. Berlin → Prague at 18:13 arriving
  // 22:16 is a four-hour evening ride, and counting it as a night of sleeper
  // travel is the planner telling a traveller they have a bed booked.
  const sleeperNights = hops.filter((h) => h.best?.isOvernight).length;
  const last = hops[hopCount - 1];
  const endDate = last ? (last.best ? rideArrivalDate(last.best) : addDays(last.date, 1)) : date;
  return {
    hops,
    complete: hops.length > 0 && hops.every((h) => h.served),
    nights: hopCount ? daysBetween(date, endDate) : 0,
    stopoverNights,
    sleeperNights,
    endDate,
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
 * Every ride out of a city worth changing onto, whatever the night: built once
 * per city and kept on the planner, because the journey search asks the same
 * city for several nights and from several directions.
 */
function ridesFromCity(planner, slug) {
  const cached = planner.ridesFromCity?.get(slug);
  if (cached) return cached;
  const out = [];
  for (const { leg, index } of planner.byCity.get(slug) || []) {
    for (let j = index + 1; j < leg.stops.length; j++) {
      const segment = segmentOf(leg, index, j);
      if (!segment || segment.to.citySlug === slug) continue;
      // A chain is never stitched from half-hour hops — see MIN_TRIP_MINUTES.
      if (isShortHop(segment.durationMinutes)) continue;
      out.push({ leg, boardIndex: index, alightIndex: j, toSlug: segment.to.citySlug });
    }
  }
  planner.ridesFromCity?.set(slug, out);
  return out;
}

/**
 * Every city a night train reaches from `slug` without a change, whatever the
 * night — what the "To" picker offers first and marks "direct". The same
 * rides the journey search starts from, so a city marked direct is one the
 * search can answer with a single train.
 * @returns {Set<string>}
 */
export function directDestinations(planner, slug) {
  if (!planner || !slug) return new Set();
  return new Set(ridesFromCity(planner, slug).map((r) => r.toSlug));
}

/**
 * Journeys from one city to another with changes of train, including the
 * direct one.
 *
 * A night-train network is sparse — Paris has no sleeper to Vienna or Prague at
 * all — so the honest answer to most pairs is a change somewhere in between,
 * and the search exists to find the ones that actually connect:
 *
 *   - Each change is checked against the two trains' own clocks (timeline.mjs):
 *     the onward train must leave at least MIN_CHANGE_MINUTES after you get in.
 *     Where a stop's time is not published the change is kept as possible
 *     rather than confirmed, never as certain.
 *   - You may wait at a change. Most sleepers run two or three nights a week,
 *     so "the next night" alone dead-ends the search on the first city whose
 *     onward train does not run tomorrow; up to `maxWaitNights` extra nights in
 *     the city are tried, and the plan carries them as stopover nights.
 *   - `flexNights` lets the first train leave that many nights later — for when
 *     nothing at all leaves on the chosen night.
 *   - `after` ({date, arrival}, a hop's own `after`) is the train you arrive on
 *     when the search fills a gap in a longer plan: the first onward train has
 *     to leave after it gets in, like every other change.
 *   - Changes happen only where trains start or end (isInterchange), and a
 *     journey that arrives no earlier than one with fewer trains is dropped.
 *     That rule is what removed Brussels → Vienna → Lviv → Budapest and
 *     Amsterdam → Vienna → Munich → Rome, which the old breadth-first walk
 *     offered beside the routes they are worse versions of.
 *
 * Each journey comes back resolved exactly as its plan URL resolves (cities,
 * first night, stopover nights), so following it shows what the card showed.
 *
 * @param {ReturnType<createPlanner>} planner
 * @param {{from: string, to: string, date: string, maxLegs?: number, limit?: number,
 *          maxWaitNights?: number, flexNights?: number, after?: object|null}} query
 * @returns {object[]} soonest arrival day first, then fewest changes
 */
export function findJourneys(
  planner,
  {
    from,
    to,
    date,
    maxLegs = 3,
    limit = 12,
    maxWaitNights = 2,
    flexNights = 0,
    after = null,
  } = {},
) {
  if (!from || !to || from === to || !date) return [];

  const availability = new Map();
  const offerable = (leg, night) => {
    const key = `${leg.id}@${night}`;
    if (!availability.has(key)) {
      availability.set(key, isOfferable(availabilityFor(leg, night).status));
    }
    return availability.get(key);
  };

  /** A partial journey: where it is, when it got there, how. */
  let frontier = [{ cities: [from], steps: [] }];
  const arrivals = [];
  // Earliest arrival per city over every shallower level: reaching a city later
  // with more trains can only lead to worse journeys.
  const earliestAt = new Map();

  for (let depth = 0; depth < maxLegs && frontier.length; depth++) {
    const next = [];
    for (const path of frontier) {
      const tail = path.cities[path.cities.length - 1];
      const previous =
        path.steps[path.steps.length - 1] ||
        (after ? { night: after.date, times: { arrival: after.arrival }, arrivedBefore: true } : null);
      // The gap a longer plan asks to fill already has its night.
      const firstNight =
        previous && !previous.arrivedBefore
          ? addDays(previous.night, Math.max(1, arrivalDayOffset(previous.times) ?? 1))
          : date;
      const window = path.steps.length ? maxWaitNights : flexNights;
      const templates = ridesFromCity(planner, tail);

      for (let wait = 0; wait <= window; wait++) {
        const night = addDays(firstNight, wait);
        for (const template of templates) {
          const { leg, toSlug } = template;
          // No revisiting: a trip that returns to a city it already passed
          // through is a worse answer than the one that stopped there.
          if (path.cities.includes(toSlug)) continue;
          const arrives = toSlug === to;
          if (!arrives && (depth + 1 >= maxLegs || !isInterchange(planner, toSlug))) continue;
          // Staying on the same train is not a change.
          if (previous && previous.leg === leg && previous.alightIndex === template.boardIndex) {
            continue;
          }
          if (!offerable(leg, night)) continue;

          const times = segmentTimes(leg, template.boardIndex, template.alightIndex);
          let connection = null;
          if (previous) {
            connection = connectionBetween(
              previous.times?.arrival,
              times?.departure,
              daysBetween(previous.night, night),
            );
            if (connection.status === "missed") continue;
          }

          const step = { ...template, night, times, connection };
          const arrivalAt = absoluteArrival(step);
          const candidate = {
            cities: [...path.cities, toSlug],
            steps: [...path.steps, step],
            arrivalAt,
          };
          if (arrives) {
            arrivals.push(candidate);
            continue;
          }
          const seen = earliestAt.get(toSlug);
          if (seen != null && seen <= arrivalAt) continue;
          next.push(candidate);
        }
      }
    }

    // Keep the two earliest arrivals per city: onward options depend only on
    // when you get there, and a second label survives a no-revisit clash.
    next.sort((a, b) => a.arrivalAt - b.arrivalAt);
    const perCity = new Map();
    const kept = [];
    for (const candidate of next) {
      const slug = candidate.cities[candidate.cities.length - 1];
      const count = perCity.get(slug) ?? 0;
      if (count >= 2) continue;
      perCity.set(slug, count + 1);
      kept.push(candidate);
    }
    for (const candidate of kept) {
      const slug = candidate.cities[candidate.cities.length - 1];
      if (!earliestAt.has(slug) || earliestAt.get(slug) > candidate.arrivalAt) {
        earliestAt.set(slug, candidate.arrivalAt);
      }
    }
    frontier = kept.slice(0, 400);
  }

  // A journey is worth showing only if nothing with fewer (or as many) trains
  // gets there earlier on the same cities — and only once per city chain.
  arrivals.sort((a, b) => a.steps.length - b.steps.length || a.arrivalAt - b.arrivalAt);
  const best = new Map();
  const chosen = [];
  let fewerTrainsArrive = Infinity;
  let currentLegs = 0;
  let thisLevelBest = Infinity;
  for (const candidate of arrivals) {
    if (candidate.steps.length !== currentLegs) {
      fewerTrainsArrive = Math.min(fewerTrainsArrive, thisLevelBest);
      currentLegs = candidate.steps.length;
      thisLevelBest = Infinity;
    }
    if (candidate.arrivalAt >= fewerTrainsArrive) continue;
    thisLevelBest = Math.min(thisLevelBest, candidate.arrivalAt);
    const key = candidate.cities.join(">");
    if (best.has(key)) continue;
    best.set(key, candidate);
    chosen.push(candidate);
  }

  const journeys = [];
  for (const candidate of chosen) {
    const journey = buildJourney(planner, candidate, after);
    if (journey) journeys.push(journey);
  }
  journeys.sort(
    (a, b) =>
      daysBetween(b.endDate, a.endDate) ||
      a.hops.length - b.hops.length ||
      (a.complete === b.complete ? 0 : a.complete ? -1 : 1) ||
      unconfirmedCount(a) - unconfirmedCount(b) ||
      a.arrivalAt - b.arrivalAt ||
      interchangeWeight(planner, b) - interchangeWeight(planner, a),
  );
  return journeys.slice(0, limit);
}

/** Minutes since the epoch, roughly, at which a step gets in — for ranking. */
function absoluteArrival(step) {
  const lo = step.times?.arrival?.[0];
  const base = daysBetween("2000-01-01", step.night) * 24 * 60;
  return base + (Number.isFinite(lo) ? lo : 24 * 60 + 9 * 60);
}

/** Hops whose train runs on days we cannot confirm, or whose change we cannot. */
function unconfirmedCount(journey) {
  return journey.hops.filter(
    (h) => h.best?.availability?.status !== "runs" || (h.connection && h.connection.status !== "ok"),
  ).length;
}

/** Prefer a change in a big hub over a change in a one-train terminus. */
function interchangeWeight(planner, journey) {
  return journey.cities
    .slice(1, -1)
    .reduce((sum, slug) => sum + (planner.cityBySlug.get(slug)?.legCount ?? 0), 0);
}

/**
 * Turn a found path into the plan its URL would resolve to: first night plus
 * the stopover nights that reproduce each later night. Null when the plan
 * cannot reproduce the path (resolvePlan put a hop later than the search did).
 */
function buildJourney(planner, candidate, after) {
  const { cities, steps } = candidate;
  const date = steps[0].night;
  const stays = [];
  let resolved = resolvePlan(planner, { cities, date, stays, after });
  for (let i = 1; i < steps.length; i++) {
    const gap = daysBetween(resolved.hops[i].date, steps[i].night);
    if (gap < 0) return null;
    stays[i - 1] = gap;
    if (gap > 0) resolved = resolvePlan(planner, { cities, date, stays, after });
  }
  if (!resolved.hops.every((hop) => hop.best && hop.connection?.status !== "missed")) return null;
  const last = resolved.hops[resolved.hops.length - 1].best;
  return {
    cities,
    date,
    stays: stays.some((n) => n > 0) ? stays : [],
    arrivalAt: absoluteArrival({ night: last.date, times: last.times }),
    ...resolved,
  };
}

/**
 * Put a found journey into a plan in place of one of its hops.
 *
 * `[A, B, C]` with the journey A → X → B inserted for hop 0 becomes
 * `[A, X, B, C]`, the stopover nights in X carried, the nights after B kept,
 * and — when the journey leaves later than the hop did — the wait added to the
 * night before it (or to the trip's first night, for hop 0).
 *
 * @param {{cities: string[], date: string, stays?: number[]}} plan
 * @param {number} hopIndex
 * @param {{cities: string[], date: string, stays?: number[]}} journey
 * @param {string} hopDate - the night the plan had this hop on
 * @returns {{cities: string[], date: string, stays: number[]}}
 */
export function spliceJourney(plan, hopIndex, journey, hopDate) {
  const cities = [...(plan.cities || [])];
  const stays = [...(plan.stays || [])];
  const between = journey.cities.slice(1, -1);
  const hops = Math.max(0, cities.length - 1);
  while (stays.length < hops - 1) stays.push(0);
  const later = Math.max(0, daysBetween(hopDate, journey.date));
  const journeyStays = between.map((_, i) => clampStay(journey.stays?.[i] ?? 0));

  let date = plan.date;
  if (hopIndex === 0) date = later ? addDays(plan.date, later) : plan.date;
  else stays[hopIndex - 1] = clampStay((stays[hopIndex - 1] ?? 0) + later);

  cities.splice(hopIndex + 1, 0, ...between);
  stays.splice(hopIndex, 0, ...journeyStays);
  return { cities, date, stays: stays.slice(0, Math.max(0, cities.length - 2)) };
}
