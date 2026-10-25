/**
 * A train's price on one night, for the planner.
 *
 * A leg's `pricing` is the train's headline fare — its cheapest night across
 * the whole fare calendar — which is the right figure for "from €40" and the
 * wrong one for a dated plan: the cheapest night may be next week while the
 * plan is for December. Where the operator's own calendar prices the night,
 * the plan quotes that night; elsewhere it keeps the headline, marked
 * `nightUnknown` when the train does have a calendar that misses this night.
 *
 * The calendar rides on the leg in a compact form (`nightFares`):
 *   { start: "2026-10-26", currency: "EUR", prices: [59.99, 0, null, …] }
 * one entry per night from `start` — a number is that night's cheapest berth,
 * 0 a night the operator answered with no berth on sale (or no train), null a
 * night nobody checked. Only credible berths count (credibleClasses): a berth
 * priced at or below its own night's seat is a seat price under a berth's name.
 *
 * Pure and dependency-free beyond fareClasses.mjs and url.mjs.
 */

import { credibleClasses, pricingWithoutFigure } from "../fareClasses.mjs";
import { addDays, daysBetween, isPlanDate } from "./url.mjs";

/** The cheapest credible berth a calendar night sells, or null. */
function cheapestBerth(entry) {
  let best = null;
  for (const amount of Object.values(credibleClasses(entry))) {
    if (Number.isFinite(amount) && amount > 0 && (best == null || amount < best)) best = amount;
  }
  return best;
}

/**
 * A row's `fare_calendar_{dir}` as a leg's `nightFares`, or null when it
 * prices nothing.
 * @param {{currency?: string, nights?: object}} calendar
 */
export function nightFaresFromCalendar(calendar) {
  const dates = Object.keys(calendar?.nights ?? {}).filter(isPlanDate).sort();
  if (!dates.length) return null;
  const start = dates[0];
  const length = daysBetween(start, dates[dates.length - 1]) + 1;
  const prices = Array.from({ length }, () => null);
  let priced = 0;
  for (const date of dates) {
    const entry = calendar.nights[date];
    const amount = entry?.none ? 0 : cheapestBerth(entry);
    if (amount == null) continue;
    prices[daysBetween(start, date)] = amount;
    if (amount > 0) priced++;
  }
  if (!priced) return null;
  return { start, currency: calendar.currency || "", prices };
}

/**
 * What a calendar says about one night: a price, 0 for "no berth on sale",
 * or null when it says nothing.
 */
export function nightFareOn(nightFares, date) {
  if (!nightFares || !isPlanDate(date)) return null;
  const i = daysBetween(nightFares.start, date);
  if (i < 0 || i >= nightFares.prices.length) return null;
  return nightFares.prices[i] ?? null;
}

/**
 * The leg's pricing record for one night: that night's own figure where the
 * calendar has one, no figure where it says nothing is on sale, the headline
 * otherwise.
 */
export function pricingOnNight(leg, date) {
  const pricing = leg?.pricing ?? null;
  const amount = nightFareOn(leg?.nightFares, date);
  if (amount == null) {
    // The train has a calendar and it says nothing about this night (past
    // its end, or not checked yet): the headline still prints as a "from",
    // but it is the cheapest of OTHER nights, so nothing may rank this night
    // by it — the cheapest-nights search would put every night past the
    // calendar level with its best one.
    return leg?.nightFares && pricing?.fromPrice != null ? { ...pricing, nightUnknown: true } : pricing;
  }
  const model = pricingWithoutFigure(pricing) ?? {};
  if (amount === 0) return Object.keys(model).length ? model : null;
  return {
    ...model,
    fromPrice: amount,
    currency: leg.nightFares.currency || pricing?.currency || "",
    travelDate: date,
  };
}

/** The last night a leg's calendar covers, or "" without one. */
export function nightFaresEnd(nightFares) {
  if (!nightFares?.prices?.length) return "";
  return addDays(nightFares.start, nightFares.prices.length - 1);
}
