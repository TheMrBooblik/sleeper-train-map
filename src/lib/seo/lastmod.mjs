/**
 * What a sitemap URL's <lastmod> should say.
 *
 * The sitemap used to stamp the published payload's generation timestamp on
 * every URL, so each nightly scrape told crawlers all 241 pages had changed —
 * on a site Google samples at roughly 25 crawls a month, that spends the whole
 * budget re-reading routes that have not moved since June. route-history.json
 * already dates every route's last real change (any fingerprint difference,
 * stop-sequence drift included); this turns it into a per-URL answer.
 *
 * Pure, and .mjs so a raw-node test can import it.
 */

/**
 * Floor under every URL's lastmod, as "YYYY-MM-DD".
 *
 * A route's own change date is the honest answer for a DATA change, but it is
 * not the only thing that changes a page: a material edit to the page template
 * changes all of them at once, and stamping June on a page rewritten today would
 * tell crawlers not to bother looking.
 *
 * So bump this when the connection/hub templates change in a way worth
 * re-crawling for, and leave it alone for a styling tweak. It is deliberately
 * NOT the deploy date — that would put "changed today" on every URL again,
 * which is exactly the flat signal this replaced.
 */
export const CONTENT_VERSION_DATE = "2026-09-10";

/** A "YYYY-MM-DD" date string, or "" for anything else. */
function asDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

/**
 * A URL's lastmod: when its own content last changed, never older than the
 * template floor, and never the payload's nightly generation date unless
 * nothing at all is known about the URL.
 *
 * ISO dates compare correctly as strings, which is why the floor is stored as
 * one rather than as a Date.
 *
 * @param {string} routeLastChanged  "YYYY-MM-DD" from route-history.json, or ""
 * @param {string} fallback          used only when the URL has no history at all
 * @param {string} [floor]           override for tests
 * @returns {string}
 */
export function lastmodFor(routeLastChanged, fallback, floor = CONTENT_VERSION_DATE) {
  const own = asDate(routeLastChanged);
  if (!own) return fallback;
  return own > floor ? own : floor;
}
