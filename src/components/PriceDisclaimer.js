/**
 * The footer line that says what a price on this site is: information, not an
 * offer. One component so the SEO pages and the about page cannot drift into
 * two wordings of the same legal-ish sentence.
 */
export const PRICE_DISCLAIMER =
  "Prices on Pingwi are for information only and are not an offer. We refresh them from the operators' own sites and do our best to keep them current, but the fare you are charged may differ — the price the operator shows at checkout is the one that applies.";

export default function PriceDisclaimer({ className = "" }) {
  return (
    <p data-testid="price-disclaimer" className={`text-xs leading-relaxed text-white/40 ${className}`}>
      {PRICE_DISCLAIMER}
    </p>
  );
}
