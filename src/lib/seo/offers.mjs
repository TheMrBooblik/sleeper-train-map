/**
 * The price a route page publishes, as structured data.
 *
 * Kept apart from the page (and as .mjs) for the same reason as slugify.mjs and
 * operatorNames.mjs: it is pure, and a raw-node test can import it. It takes an
 * ALREADY-RESOLVED pricing record rather than a route, so the route → price
 * precedence stays in getOperatorPricing() where the map panel and the facts
 * tile also read it, and there is only ever one answer to "what does this route
 * cost" on a page.
 */

/**
 * schema.org AggregateOffer fields for a pricing record, or null.
 *
 * AggregateOffer rather than Offer on purpose: what the probe samples is the
 * cheapest fare it saw on one date, a floor under a yield-managed range, and
 * `lowPrice` is the property that says that. Publishing it as an Offer's `price`
 * would claim a fixed fare we do not have.
 *
 * Returns null unless a concrete number is present — an operator record that
 * only says "dynamic pricing" carries no figure, and a missing price must stay
 * missing rather than become a zero.
 *
 * @param {{fromPrice?: number|null, currency?: string|null}|null} pricing
 * @returns {{lowPrice: number, currency: string}|null}
 */
export function offerFromPricing(pricing) {
  const value = pricing?.fromPrice;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return { lowPrice: value, currency: pricing.currency || "EUR" };
}

/**
 * The AggregateOffer node itself, or null. Deliberately carries no `url`: the
 * page's booking link is an affiliate redirect marked rel="sponsored nofollow",
 * and an affiliate URL does not belong in structured data.
 *
 * @param {{lowPrice: number, currency: string}|null} offer
 */
export function offerLd(offer) {
  if (!offer) return null;
  return {
    "@type": "AggregateOffer",
    lowPrice: offer.lowPrice,
    priceCurrency: offer.currency,
  };
}
