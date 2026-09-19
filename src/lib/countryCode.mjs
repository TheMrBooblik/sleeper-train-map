/**
 * Raw country code → the canonical ISO-2 used across the app.
 *
 * Extracted from seo/countries.js so raw-node scripts can call it: that file
 * imports `../countries` extensionless and will not resolve outside webpack,
 * and the plan-index build needs this. Restating the rule in the script is how
 * two spellings of one country drift apart — the same trap resolvePricing.mjs
 * exists to close.
 *
 * @param {string} code
 * @returns {string} "" when there is nothing to normalise
 */
export function normalizeCountryCode(code) {
  if (!code) return "";
  const up = String(code).trim().toUpperCase();
  // Back-on-Track stops use "UK"; trips use "GB" — collapse both to "GB".
  if (up === "UK") return "GB";
  return up;
}
