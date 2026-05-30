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
 * Human-readable label for a pricing record, e.g. "Dynamic pricing",
 * "Fixed fare", or "Fixed fare · from €39". Returns null when not renderable.
 */
export function formatPricingLabel(pricing) {
  if (!pricing) return null;
  const typeLabel =
    pricing.type === "dynamic"
      ? "Dynamic pricing"
      : pricing.type === "fixed"
        ? "Fixed fare"
        : null;
  if (!typeLabel) return null;

  if (pricing.fromPrice != null) {
    const symbol =
      CURRENCY_SYMBOLS[pricing.currency] ||
      (pricing.currency ? `${pricing.currency} ` : "");
    return `${typeLabel} · from ${symbol}${pricing.fromPrice}`;
  }
  return typeLabel;
}
