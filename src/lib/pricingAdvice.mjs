/**
 * What an operator's pricing model means for the person buying the ticket.
 *
 * The records in data/overrides/operator-pricing.json say "dynamic" or "fixed",
 * and until now the UI printed those words: "Dynamic pricing" sat in the facts
 * tile directly above the Book button and in the map panel's trip badge, where
 * it told a traveller nothing. The useful fact is the one it implies, and the
 * two models imply OPPOSITE things:
 *
 *   dynamic → the price moves, and only upward as the train fills, so booking
 *             early is what makes it cheap
 *   fixed   → the price does not move, so booking early buys you nothing on
 *             price — but sleeper berths are finite and do sell out, which is
 *             why "fixed" must never be phrased as "book whenever"
 *
 * Pure, dependency-free and .mjs so raw-node tests can import it, and so the
 * map panel can read it without reaching into the SEO layer. It is the single
 * source of this wording: the badge, the tile, the booking caption and both FAQ
 * builders all resolve through it, or two surfaces would eventually give a
 * traveller contradictory advice about the same train.
 */

/**
 * @typedef {object} PricingAdvice
 * @property {"book-early"|"price-is-fixed"} action  machine-readable, for styling/tests
 * @property {string} headline  badge-sized, e.g. "Book early"
 * @property {string} short     one clause, for a caption next to the CTA
 * @property {string} detail    full sentence body, for FAQ prose
 */

/**
 * Advice for a pricing record, or null when the operator has no record or one
 * whose type we do not recognise — the UI then shows nothing rather than a
 * guess, which is the same contract getOperatorPricing() follows.
 *
 * @param {{type?: string}|null} pricing
 * @returns {PricingAdvice|null}
 */
export function pricingAdvice(pricing) {
  switch (pricing?.type) {
    case "dynamic":
      return {
        action: "book-early",
        headline: "Book early",
        short: "fares rise as the train fills",
        detail:
          "at yield-managed fares: the price depends on the date, the comfort class " +
          "and how far ahead you book, and it rises as the train fills. Booking as " +
          "early as possible is what makes it cheap",
      };
    case "fixed":
      return {
        action: "price-is-fixed",
        headline: "Fixed fare",
        short: "the price won't rise, but berths sell out",
        detail:
          "on a fixed tariff: the fare is set by distance and comfort class, so it " +
          "does not rise as the departure approaches and booking early does not make " +
          "it cheaper — though sleeper berths do sell out",
      };
    default:
      return null;
  }
}
