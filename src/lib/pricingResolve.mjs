/**
 * Route → pricing record, as one function both sides can call.
 *
 * getOperatorPricing() is the definition, but it lives in a .js that imports
 * its JSON without an import attribute, so raw node cannot load it — and the
 * plan-index build runs in raw node. Rather than restate the precedence there
 * (a route's own pricing first, then its operator's), the rule lives here,
 * dependency-free, with the table passed in.
 *
 * Two copies of "which price wins" is exactly the kind of drift this repo keeps
 * paying for; verify-plan asserts the two agree.
 */

/**
 * @param {{agency_id?: string, pricing?: object}} routeOrTrip
 * @param {Record<string, object>} table - operator-pricing.json
 * @returns {object|null}
 */
export function resolvePricing(routeOrTrip, table) {
  if (routeOrTrip?.pricing) return routeOrTrip.pricing;
  const agencyId = String(routeOrTrip?.agency_id || "").trim();
  return table?.[agencyId] || null;
}
