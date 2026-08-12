/**
 * URL slug helpers for the SEO pages (connections, countries, operators).
 *
 * Slugs must be deterministic and stable across nightly rebuilds, so the logic
 * here is intentionally simple and side-effect free. We never parse a slug back
 * into an id — callers resolve slugs through the inverse maps built in data.js.
 *
 * .mjs so raw-node scripts (scripts/build-seo-redirects.mjs) and the Next build
 * compute identical slugs; a divergence would emit redirects to URLs that don't exist.
 */

/**
 * Turn an arbitrary string into a lowercase, dash-separated, ASCII slug.
 * Diacritics are stripped (NFD) so "Wörgl Hbf" → "worgl-hbf", "Przemyśl" → "przemysl".
 * Letters that have no NFD decomposition are transliterated explicitly — without
 * them NFD leaves the character intact and the [^a-z0-9] pass deletes it outright,
 * which is how "Bodø" used to slug as "bod".
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/ß/g, "ss")
    .replace(/[’'`]/g, "") // "Xi'an" → "xian", not "xi-an"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the keyword-rich base slug for a train route page:
 * "{origin}-to-{dest}-{trainno}" (e.g. "amsterdam-centraal-to-innsbruck-hbf-nj-421").
 *
 * Retired as a live URL — /trains/[slug] now 301s into its /connections/ parent —
 * but still needed to regenerate the redirect map's source paths.
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
 * Canonical ordering for an undirected city pair.
 *
 * Night trains run both ways, so "Paris → Vienna" and "Vienna → Paris" are the
 * same corridor and belong on one page. Ordering by slug (not display name) keeps
 * the URL and the page heading in agreement, and is stable across rebuilds.
 * @param {string} cityA
 * @param {string} cityB
 * @returns {[string, string]} the pair in canonical order
 */
export function orderCityPair(cityA, cityB) {
  return slugify(cityA) <= slugify(cityB) ? [cityA, cityB] : [cityB, cityA];
}

/**
 * Undirected city-pair slug, e.g. "paris-to-vienna" for both directions.
 * @param {string} cityA - display-normalized city name (see seo/cities.mjs)
 * @param {string} cityB - display-normalized city name
 * @returns {string}
 */
export function buildPairSlug(cityA, cityB) {
  const [first, second] = orderCityPair(cityA, cityB);
  return `${slugify(first)}-to-${slugify(second)}`;
}
