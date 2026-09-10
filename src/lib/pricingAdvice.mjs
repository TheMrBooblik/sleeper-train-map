/**
 * What an operator's pricing model means for the person buying the ticket.
 *
 * The records in data/overrides/operator-pricing.json say "dynamic" or "fixed",
 * and the UI used to print those words: "Dynamic pricing" sat in the facts tile
 * directly above the Book button and in the map panel's trip badge, where it
 * told a traveller nothing. The useful fact is the one it implies, and the two
 * models imply OPPOSITE things:
 *
 *   dynamic → the cheap fares are a limited quota that sells out, so booking
 *             early is the RELIABLE way to pay less
 *   fixed   → the price does not move at all, so booking early buys nothing on
 *             price — but sleeper berths are finite and do sell out, which is
 *             why "fixed" must never be phrased as "book whenever"
 *
 * "Yield-managed" is NOT the same as "the price only ever rises", and the first
 * draft of this file said it was ("fares rise as the train fills"). Operators
 * discount unsold berths close to departure, and European Sleeper publishes a
 * last-minute deals page that BookingCta already links — so that wording put a
 * flat contradiction three lines above the operator's own link. Hence two
 * changes: the dynamic wording now describes the mechanism that is true either
 * way (the cheap quota goes first), and `caveat` names the late-discount case
 * where we have first-party evidence for it.
 *
 * That evidence is `dealsUrl` in data/overrides/operator-booking.json — the
 * operator's own deals page. Its absence means we do not KNOW of a programme,
 * never that late fares are always worse, which is exactly why the base wording
 * has to survive without the caveat.
 *
 * `headline` names the fare model and `guidance` says what to do about it,
 * because they belong in different places. A badge that reads "Book early" is
 * an instruction with its reasoning missing, and next to a fare it is not even
 * obviously about the fare; "Dynamic fare" states the fact, and the advice sits
 * one click away behind the explainer (src/components/PricingExplainer.js)
 * where there is room for the reason and the caveat.
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
 * @property {string} headline  what the fare IS, badge-sized, e.g. "Dynamic fare"
 * @property {string} guidance  what to DO about it, e.g. "Book early"
 * @property {string} short     one clause of reason, for a caption next to the CTA
 * @property {string} detail    full sentence body, for FAQ prose
 * @property {string} caveat    the case that cuts the other way, or ""
 */

/**
 * Advice for a pricing record, or null when the operator has no record or one
 * whose type we do not recognise — the UI then shows nothing rather than a
 * guess, which is the same contract getOperatorPricing() follows.
 *
 * @param {{type?: string}|null} pricing
 * @param {object} [opts]
 * @param {boolean} [opts.hasLastMinuteDeals] the operator publishes a deals page
 * @returns {PricingAdvice|null}
 */
export function pricingAdvice(pricing, { hasLastMinuteDeals = false } = {}) {
  switch (pricing?.type) {
    case "dynamic":
      return {
        action: "book-early",
        headline: "Dynamic fare",
        guidance: "Book early",
        short: "the cheapest fares are limited and go first",
        detail:
          "at yield-managed fares: the price depends on the date, the comfort class " +
          "and how far ahead you book. The cheapest fares are a limited quota and go " +
          "first, so booking early is the reliable way to pay less",
        // Real, but not a plan: it is a bet on the train not selling out.
        caveat: hasLastMinuteDeals
          ? "unsold berths are sometimes discounted close to departure, so a " +
            "last-minute deal can beat an advance fare — if you can risk the train " +
            "being full"
          : "",
      };
    case "fixed":
      return {
        action: "price-is-fixed",
        headline: "Fixed fare",
        guidance: "Book any time",
        short: "the price won't rise, but berths sell out",
        detail:
          "on a fixed tariff: the fare is set by distance and comfort class, so it " +
          "does not rise as the departure approaches and booking early does not make " +
          "it cheaper — though sleeper berths do sell out",
        caveat: "",
      };
    default:
      return null;
  }
}
