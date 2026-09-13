/**
 * Operator pricing model: whether an operator's night-train fares are a fixed
 * tariff or dynamic (yield-managed), with an optional "from" price.
 *
 * Data lives in data/overrides/operator-pricing.json (editable through the
 * admin panel). Operators we're unsure about are intentionally omitted so the
 * UI shows nothing rather than a guessed value. The "from" prices are null
 * until curated — the badge shows only the type until a value is filled in.
 */
import OPERATOR_PRICING from "../../data/overrides/operator-pricing.json";
import { pricingAdvice, formatCheckedAt } from "./pricingAdvice.mjs";

export { pricingAdvice, formatCheckedAt };

export { OPERATOR_PRICING };

const CURRENCY_SYMBOLS = {
  EUR: "€",
  GBP: "£",
  CHF: "CHF ",
  SEK: "kr ",
  CZK: "Kč ",
  PLN: "zł ",
  HUF: "Ft ",
  RON: "lei ",
  BGN: "лв ",
  UAH: "₴",
  TRY: "₺",
  CNY: "¥",
  GEL: "₾",
  AZN: "₼",
  AMD: "֏",
};

/**
 * Resolve pricing for a route/trip. A route-level `pricing` override wins;
 * otherwise the operator default keyed by agency_id. Returns null when unknown
 * so callers can render nothing instead of a guess.
 */
export function getOperatorPricing(routeOrTrip) {
  if (routeOrTrip?.pricing) return routeOrTrip.pricing;
  const agencyId = (routeOrTrip?.agency_id || "").trim();
  return OPERATOR_PRICING[agencyId] || null;
}

/**
 * Label for a pricing record, e.g. "Book early", "Fixed fare · from €39".
 * Returns null when not renderable.
 *
 * The headline is the traveller-facing ADVICE, not the name of the pricing
 * model: this label renders in the facts tile directly above the Book button
 * and in the map panel's trip badge, and "Dynamic pricing" in that position
 * told the reader nothing they could act on. See pricingAdvice.mjs.
 */
export function formatPricingLabel(pricing) {
  const advice = pricingAdvice(pricing);
  if (!advice) return null;

  if (pricing.fromPrice != null) {
    const symbol =
      CURRENCY_SYMBOLS[pricing.currency] ||
      (pricing.currency ? `${pricing.currency} ` : "");
    return `${advice.headline} · from ${symbol}${pricing.fromPrice}`;
  }
  return advice.headline;
}

/**
 * Just the "from <price>" part of a fixed fare (no type prefix), e.g.
 * "from €39". Returns null when there's no concrete price. Used near the
 * booking button where the pricing-model badge already shows the type.
 */
export function formatFromPrice(pricing) {
  if (!pricing || pricing.fromPrice == null) return null;
  const symbol =
    CURRENCY_SYMBOLS[pricing.currency] ||
    (pricing.currency ? `${pricing.currency} ` : "");
  return `from ${symbol}${pricing.fromPrice}`;
}

/**
 * Style (foreground/background) for the pricing badge.
 *
 * Intention: pricing type should have its own semantic color, independent of
 * route/operator color. This avoids confusing "pricing model" with "operator".
 */
export function getPricingBadgeStyle(pricing) {
  if (!pricing?.type) return null;

  // Chosen to be readable on white and lightly tinted backgrounds.
  // Keep these explicit (not Tailwind classes) so callers can use them in inline style.
  if (pricing.type === "dynamic") {
    return {
      color: "#6D28D9",
      backgroundColor: "rgba(109, 40, 217, 0.12)",
    };
  }

  if (pricing.type === "fixed") {
    return {
      color: "#1D4ED8",
      backgroundColor: "rgba(29, 78, 216, 0.12)",
    };
  }

  return null;
}
