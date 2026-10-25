/**
 * What a journey with changes costs: each train's fare and their sum.
 *
 * A traveller choosing between "via Berlin" and "via Hamburg" compares the
 * total first, so it is read off the trains the plan would book — each hop's
 * best ride — and shown as "€40 + €69.90 = €109.90".
 *
 * Only what can be stood behind is added up:
 *   - a train with no published fare is a gap, not a zero, so there is no total
 *     and the gap is shown as "?";
 *   - fares in different currencies are not summed (no total, each part in its
 *     own currency);
 *   - a yield-managed fare is a floor ("from"), so a total including one is a
 *     floor too.
 *
 * Pure and dependency-free beyond fareClasses.mjs.
 */

import { formatMoney } from "../fareClasses.mjs";

/** "€69.90" rather than "€69.9" beside a whole-euro figure in the same sum. */
function money(amount, currency) {
  if (!Number.isFinite(amount)) return "";
  if (Number.isInteger(amount)) return formatMoney(amount, currency);
  const text = formatMoney(amount, currency);
  // Grouped currencies (yen, dong…) are already whole; leave those alone.
  return /\.\d$/.test(text) ? `${text}0` : text;
}

/**
 * @param {object[]} rides - each hop's best ride (null for a hop without one)
 * @returns {null | {
 *   parts: string[],      // one per train, "?" where no fare is published
 *   total: string|null,   // the sum, or null when it cannot be stated
 *   from: boolean,        // any fare is a floor ("from")
 *   complete: boolean,    // every train has a fare in one currency
 *   cents: number|null,   // the total in cents, for ordering journeys
 *   currency: string|null,
 * }} null when no train on the journey has a fare at all
 */
export function journeyFare(rides = []) {
  const fares = rides.map((ride) => {
    const pricing = ride?.pricing;
    const amount = Number(pricing?.fromPrice);
    return pricing && pricing.fromPrice != null && Number.isFinite(amount)
      ? { amount, currency: pricing.currency || "", dynamic: pricing.type !== "fixed" }
      : null;
  });
  if (!fares.some(Boolean)) return null;

  const currencies = new Set(fares.filter(Boolean).map((f) => f.currency));
  const complete = fares.every(Boolean) && currencies.size === 1;
  const currency = [...currencies][0];
  // Cents, not floats: 40 + 69.9 must print 109.90, not 109.90000000000001.
  const totalCents = complete ? fares.reduce((sum, f) => sum + Math.round(f.amount * 100), 0) : null;

  return {
    parts: fares.map((f) => (f ? money(f.amount, f.currency) : "?")),
    total: complete ? money(totalCents / 100, currency) : null,
    from: fares.some((f) => f?.dynamic),
    complete,
    cents: totalCents,
    currency: complete ? currency : null,
  };
}

/**
 * Orders journeys cheapest first: a journey with a total before one without,
 * totals compared in cents. Totals in different currencies are not compared
 * by value (no rate is applied here), only grouped, so the order stays a
 * consistent one. Returns 0 where price says nothing, for the caller's own
 * tie-break.
 */
export function compareJourneyFares(a, b) {
  const fa = journeyFare(a?.hops?.map((h) => h.best) ?? []);
  const fb = journeyFare(b?.hops?.map((h) => h.best) ?? []);
  const ca = fa?.cents ?? null;
  const cb = fb?.cents ?? null;
  if (ca == null || cb == null) return (ca == null) - (cb == null);
  if (fa.currency !== fb.currency) return fa.currency < fb.currency ? -1 : 1;
  return ca - cb;
}
