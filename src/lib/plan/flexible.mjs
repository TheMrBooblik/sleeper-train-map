/**
 * "Any time" and "some time in November": a trip without a night, asked for
 * its cheapest one.
 *
 * Every other question the planner answers has a night. This one asks the
 * planner to try them all — each night in the window is resolved exactly as
 * its dated plan would be (the direct train, and for two cities the ways
 * through with a change), priced on that night where the operator publishes a
 * fare calendar (nightFares.mjs), and the nights ranked by what the trip
 * costs. Opening one is opening that dated plan, so the price on the list is
 * the price the plan shows.
 *
 * Pure: no clock, no DOM. `today` comes in.
 */

import { addDays, addMonths, monthOf, nightsInMonth } from "./url.mjs";
import { isOfferable } from "./availability.mjs";
import { journeyFare } from "./journeyFare.mjs";
import { toEur } from "../fx.mjs";
import { compareDestinations, departuresFrom, findJourneys, resolvePlan } from "./search.mjs";

/**
 * How far "any time" looks: about three months, which is as far as the
 * longest fare calendar reaches (European Sleeper's 92 nights). Past a
 * calendar a train quotes its lowest fare, which says nothing about the night.
 */
export const ANYTIME_NIGHTS = 92;

/** How many months the picker offers, this one included. */
export const MONTH_CHOICES = 6;

/** The nights a flexible search tries, in order. */
export function flexibleNights({ today, month = null, nights = ANYTIME_NIGHTS } = {}) {
  if (!today) return [];
  if (month) return nightsInMonth(month, today);
  return Array.from({ length: nights }, (_, i) => addDays(today, i));
}

/** This month and the next few: ["2026-10", "2026-11", …]. */
export function monthChoices(today, count = MONTH_CHOICES) {
  const first = monthOf(today);
  if (!first) return [];
  return Array.from({ length: count }, (_, i) => addMonths(first, i));
}

/**
 * Cheapest first, then fewer trains, then the earlier arrival. Ranked on
 * `rank`, which is the total only where it is a price for THIS night.
 */
function compareOptions(a, b) {
  const ra = a.rank;
  const rb = b.rank;
  const byPrice =
    ra == null || rb == null
      ? (ra == null) - (rb == null)
      : ra.currency !== rb.currency
        ? (ra.currency < rb.currency ? -1 : 1)
        : ra.cents - rb.cents;
  return (
    byPrice ||
    a.hops.length - b.hops.length ||
    String(a.endDate).localeCompare(String(b.endDate))
  );
}

/** A ride's price can rank its night: it is that night's, or the same every night. */
export function pricedForNight(ride) {
  const pricing = ride?.pricing;
  return Boolean(
    pricing && pricing.fromPrice != null && Number.isFinite(Number(pricing.fromPrice)) && !pricing.nightUnknown,
  );
}

function asOption(source, kind) {
  const option = {
    kind,
    cities: source.cities,
    date: source.date,
    stays: source.stays ?? [],
    hops: source.hops,
    nights: source.nights,
    endDate: source.endDate,
  };
  const rides = option.hops.map((h) => h.best);
  option.fare = journeyFare(rides);
  option.rank =
    option.fare?.cents != null && rides.every(pricedForNight)
      ? { cents: option.fare.cents, currency: option.fare.currency }
      : null;
  return option;
}

/**
 * The cheapest way to make the trip leaving on one night, or null when
 * nothing does.
 *
 * The plan as given counts when every hop has a train that could run and
 * that you can make. For two cities the ways through with a change count
 * too — via Berlin can be cheaper than the direct train, and on most nights a
 * pair has no direct train at all.
 *
 * @param {{cities: string[], stays?: number[], date: string}} query
 */
export function cheapestOnNight(planner, { cities = [], stays = [], date } = {}) {
  if (cities.length < 2 || !date) return null;
  const options = [];
  const plan = resolvePlan(planner, { cities, date, stays });
  // "Served" is not enough: a hop's best train is the one the plan prints, and
  // it must be one that could run and that you can make.
  const usable = (hop) =>
    hop.best && isOfferable(hop.best.availability.status) && hop.connection?.status !== "missed";
  if (plan.complete && plan.hops.every(usable)) {
    options.push(asOption({ ...plan, cities, date, stays }, "plan"));
  }
  if (cities.length === 2) {
    const [from, to] = cities;
    for (const journey of findJourneys(planner, { from, to, date, maxLegs: 3, limit: 6 })) {
      if (journey.hops.length < 2 || journey.date !== date) continue;
      options.push(asOption(journey, "journey"));
    }
  }
  options.sort(compareOptions);
  return options[0] ?? null;
}

/**
 * The nights worth showing out of a flexible search.
 *
 * @param {{date: string, option: object|null}[]} results
 * @param {{limit?: number}} [options]
 * @returns {{
 *   cheapest: object[],         // the cheapest priced nights, cheapest first
 *   firstNights: object[],      // the first nights anything runs, when none is priced
 *   byMonth: Map<string, object>, // month → its cheapest night (priced first)
 *   running: number,            // nights something runs
 *   priced: number,             // nights with a total for that night
 *   varies: boolean,            // the priced nights do not all cost the same
 * }}
 */
export function summarizeNights(results = [], { limit = 5 } = {}) {
  const running = results.filter((r) => r.option);
  const priced = running.filter((r) => r.option.rank);
  const byPrice = (a, b) => compareOptions(a.option, b.option) || a.date.localeCompare(b.date);

  const byMonth = new Map();
  for (const result of running) {
    const month = monthOf(result.date);
    const held = byMonth.get(month);
    if (!held || byPrice(result, held) < 0) byMonth.set(month, result);
  }

  return {
    cheapest: [...priced].sort(byPrice).slice(0, limit),
    firstNights: priced.length ? [] : running.slice(0, limit),
    byMonth,
    running: running.length,
    priced: priced.length,
    // False when every priced night costs the same — trains with one fare
    // for every night, where a "cheapest nights" list would be a list of ties.
    varies: new Set(priced.map((r) => `${r.option.rank.currency}:${r.option.rank.cents}`)).size > 1,
  };
}

/**
 * The nights of a month as a Monday-first grid, with blanks before the 1st:
 * each cell `{date, option}` or null.
 */
export function monthGrid(month, results = []) {
  const nights = nightsInMonth(month);
  if (!nights.length) return [];
  const byDate = new Map(results.map((r) => [r.date, r]));
  const [y, m] = month.split("-").map(Number);
  const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: firstWeekday }, () => null);
  for (const date of nights) cells.push({ date, option: byDate.get(date)?.option ?? null, tried: byDate.has(date) });
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Two rides whose prices can be compared for their own nights. */
function samePrice(a, b) {
  return (
    pricedForNight(a) &&
    pricedForNight(b) &&
    (a.pricing.currency || "") === (b.pricing.currency || "")
  );
}

/**
 * "Where could you go from Paris, any time": every destination a train
 * reaches on some night in the window, each with its cheapest night.
 *
 * @param {{from: string, nights: string[]}} query
 * @returns {object[]} like departuresFrom's destinations, plus `date` (the
 *   night `best` is for) and `nightCount` (the nights a train goes there)
 */
export function departuresAnyNight(planner, { from, nights = [] } = {}) {
  const byCity = new Map();
  for (const date of nights) {
    for (const destination of departuresFrom(planner, { from, date }).destinations) {
      const cheapest = [...destination.rides].sort((a, b) =>
        samePrice(a, b) ? Number(a.pricing.fromPrice) - Number(b.pricing.fromPrice) : 0,
      )[0];
      const held = byCity.get(destination.city.slug);
      if (!held) {
        byCity.set(destination.city.slug, { city: destination.city, best: cheapest, date, nightCount: 1 });
        continue;
      }
      held.nightCount++;
      // A later night only takes over when it is cheaper, or when it is the
      // first with a price for its own night; otherwise the nearest stands.
      const cheaper = samePrice(cheapest, held.best)
        ? Number(cheapest.pricing.fromPrice) < Number(held.best.pricing.fromPrice)
        : pricedForNight(cheapest) && !pricedForNight(held.best);
      if (cheaper) {
        held.best = cheapest;
        held.date = date;
      }
    }
  }
  return [...byCity.values()].sort(compareDestinations);
}

/**
 * A ride's price in euros, for ordering destinations whose trains sell in
 * different currencies (Prague's list mixes European Sleeper's euros with
 * ČD's koruna). Null when the ride cannot rank: no figure, a headline that is
 * not this night's (pricedForNight), or a currency with no rate.
 */
export function rideEuroPrice(ride, table) {
  if (!pricedForNight(ride)) return null;
  const amount = Number(ride.pricing.fromPrice);
  const currency = ride.pricing.currency || "";
  if (!currency) return null;
  return currency === "EUR" ? amount : toEur(amount, currency, table);
}

/**
 * "Where could you go from Prague", cheapest first: a destination whose train
 * states a fare comes before one that does not, by that fare; everything that
 * price cannot separate keeps the order it came in (what we can stand behind,
 * a night's sleep, a train that ends there — compareDestinations).
 */
export function cheapestDestinationsFirst(destinations = [], table) {
  return destinations
    .map((destination, i) => ({ destination, i, eur: rideEuroPrice(destination.best, table) }))
    .sort((a, b) => (a.eur == null) - (b.eur == null) || (a.eur ?? 0) - (b.eur ?? 0) || a.i - b.i)
    .map((entry) => entry.destination);
}
