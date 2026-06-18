/**
 * URL slug helpers for the SEO pages (trains, countries, connections, operators).
 *
 * Slugs must be deterministic and stable across nightly rebuilds, so the logic
 * here is intentionally simple and side-effect free. We never parse a slug back
 * into an id — callers resolve slugs through the inverse maps built in data.js.
 */

/**
 * Turn an arbitrary string into a lowercase, dash-separated, ASCII slug.
 * Diacritics are stripped (NFD) so "Wörgl Hbf" → "worgl-hbf", "Przemyśl" → "przemysl".
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/ł/g, "l") // ł
    .replace(/Ł/g, "l") // Ł
    .replace(/đ/g, "d") // đ
    .replace(/Đ/g, "d") // Đ
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the keyword-rich base slug for a train route page:
 * "{origin}-to-{dest}-{trainno}" (e.g. "amsterdam-centraal-to-innsbruck-hbf-nj-421").
 * This form is collision-free across the current dataset; the slug-map builder in
 * data.js appends a deterministic "-2"/"-3" suffix on the rare event of a clash and
 * keeps the route_id ↔ slug mapping, so slugs are never parsed back into ids.
 * @param {{ origin: string, destination: string, trainNumber: string }} route
 * @returns {string}
 */
export function buildTrainSlug({ origin, destination, trainNumber }) {
  const parts = [
    slugify(origin),
    "to",
    slugify(destination),
    slugify(trainNumber),
  ].filter(Boolean);
  return parts.join("-");
}

/**
 * Directed city-pair slug, e.g. "paris-to-vienna".
 * @param {string} originCity - already display-normalized city name
 * @param {string} destCity - already display-normalized city name
 * @returns {string}
 */
export function buildPairSlug(originCity, destCity) {
  return `${slugify(originCity)}-to-${slugify(destCity)}`;
}
