/**
 * Reusable schema.org (JSON-LD) builders for site-wide entities, so the markup
 * stays consistent across pages. Per-page entities (TrainTrip, BreadcrumbList,
 * ItemList) are built next to the data they describe; these are the global ones.
 */
import { SITE_URL, OG_IMAGE } from "./site";

/** Brand/publisher name used across structured data. */
export const ORG_NAME = "Pingwi Sleeper Train Map";

/**
 * Organization (publisher) markup for the homepage.
 * `logo` points at the real brand image we already ship for Open Graph.
 * @returns {Record<string, unknown>}
 */
export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: ORG_NAME,
    url: SITE_URL,
    logo: OG_IMAGE,
  };
}

/**
 * WebSite markup for the homepage.
 *
 * NOTE: no `potentialAction`/SearchAction is emitted on purpose — the on-map
 * station search is a client-side autocomplete with no crawlable results URL
 * (e.g. `/search?q=`), so a SearchAction would point nowhere. Add one only if a
 * real query-string search endpoint is introduced.
 * @returns {Record<string, unknown>}
 */
export function webSiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORG_NAME,
    url: SITE_URL,
    publisher: { "@type": "Organization", name: ORG_NAME, logo: OG_IMAGE },
  };
}
