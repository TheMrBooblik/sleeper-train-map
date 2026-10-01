/**
 * An approximate euro figure beside a fare quoted in another currency:
 * "from ¥16,040 (≈ €87)".
 *
 * A yen or yuan price means little to most of this site's readers, so where a
 * surface has the room it adds the euro equivalent in parentheses. The rates
 * are the European Central Bank's daily reference rates, fetched by the nightly
 * scrape (registry id `ecb-fx`, scripts/adapters/ecb-fx.mjs) into
 * public/data/scraped/fx-rates.json and imported here at build time — so the
 * server-rendered page and the hydrated one read the same number, and no
 * request is made from the browser.
 *
 * It is an orientation figure, not a price anyone charges: always "≈", whole
 * euros, never for a fare already in euros, and nothing at all when the rate
 * is missing (a blank beats a guess).
 */

import FX_FILE from "../../public/data/scraped/fx-rates.json" with { type: "json" };

/** { date, source, rates: { JPY: 184.09, … } } — units of each currency per euro. */
export const EUR_RATES = FX_FILE?.data ?? FX_FILE ?? null;

/** The euro value of an amount, or null when there is no rate (or it is already euros). */
export function toEur(amount, currency, table = EUR_RATES) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || !currency || currency === "EUR") return null;
  const rate = Number(table?.rates?.[currency]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return value / rate;
}

function groupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "≈ €87", or "" when no euro figure can be given. Whole euros from €10 up,
 * one decimal below that; grouped with a fixed comma rather than Intl, since
 * this string is server-rendered and hydrated.
 */
export function formatEurApprox(amount, currency, table = EUR_RATES) {
  const eur = toEur(amount, currency, table);
  if (eur == null) return "";
  const rounded = eur >= 10 ? Math.round(eur) : Math.round(eur * 10) / 10;
  return `≈ €${groupThousands(rounded)}`;
}

/** The euro hint for a pricing or fare record ({ fromPrice, currency }). */
export function eurHintFor(pricing, table = EUR_RATES) {
  return formatEurApprox(pricing?.fromPrice, pricing?.currency, table);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "ECB reference rate of 25 Sep 2026" — for a tooltip on the euro figure. */
export function eurRateNote(table = EUR_RATES) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(table?.date ?? ""));
  if (!m) return "Approximate, at the ECB reference rate";
  return `Approximate, at the ECB reference rate of ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
