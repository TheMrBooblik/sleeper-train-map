import { getDataGeneratedAt } from "../lib/seo/data";
import {
  getAllCountryHubs,
  getAllOperatorHubs,
  getAllCityPairs,
  getStationHubsForCountry,
} from "../lib/seo/aggregate";
import { SITE_URL } from "../lib/seo/site";
import { lastmodFor } from "../lib/seo/lastmod.mjs";
import { FACTS, snippetVariantFor } from "../lib/seo/snippet.mjs";

/**
 * Staged indexation. At ~25 crawls/month Google samples and rations, so shipping
 * every URL at once just spreads a thin crawl budget across the whole site.
 *
 *   1 → homepage, /connections, /about, all country + operator hubs, and the
 *       BATCH_1_CONNECTIONS busiest connections (~145 URLs).
 *   2 → everything: the remaining connections plus the per-station hubs.
 *
 * Flip to 2 once Search Console shows batch 1 indexing. That is the whole
 * migration step — one line.
 */
const SITEMAP_BATCH = 1;
const BATCH_1_CONNECTIONS = 80;

function urlEntry(loc, lastmod, changefreq, priority) {
  return `
  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function generateSiteMap() {
  const entries = [];

  // Core pages — emitted unconditionally so the sitemap is always valid even if the
  // data layer can't load (e.g. the committed payload is missing from the lambda).
  // lastmod tracks the data, not the request: stamping "now" on every fetch told
  // crawlers the homepage had just changed, every single time.
  let lastmod;
  try {
    lastmod = getDataGeneratedAt();
  } catch {
    lastmod = new Date().toISOString();
  }

  entries.push(urlEntry(SITE_URL, lastmod, "weekly", "1.0"));
  entries.push(urlEntry(`${SITE_URL}/about`, lastmod, "monthly", "0.9"));
  // Only the planner's landing page. Everything under it (/plan/{cities}/{date})
  // is one of an unbounded number of URLs differing by a date, which is a crawl
  // trap, and carries noindex for the same reason.
  entries.push(urlEntry(`${SITE_URL}/plan`, lastmod, "monthly", "0.8"));
  entries.push(urlEntry(`${SITE_URL}/privacy`, lastmod, "yearly", "0.3"));

  // Data-derived pages. Wrapped so a read failure degrades to the core sitemap
  // (HTTP 200) instead of throwing a 500 and giving crawlers nothing at all.
  //
  // Only canonical, indexable, 200-returning URLs belong here — nothing that
  // redirects. The retired /trains/* pages are therefore absent: they 301 into
  // their /connections/ parent (see next.config.js).
  try {
    entries.push(urlEntry(`${SITE_URL}/connections`, lastmod, "weekly", "0.9"));

    for (const hub of getAllCountryHubs()) {
      entries.push(
        urlEntry(
          `${SITE_URL}/night-trains/${hub.country.slug}`,
          lastmodFor(hub.lastChanged, lastmod),
          "weekly",
          "0.8",
        ),
      );
      if (SITEMAP_BATCH >= 2) {
        for (const st of getStationHubsForCountry(hub.country.slug)) {
          entries.push(
            urlEntry(
              `${SITE_URL}/night-trains/${hub.country.slug}/from/${st.slug}`,
              lastmodFor(st.lastChanged, lastmod),
              "weekly",
              "0.5",
            ),
          );
        }
      }
    }

    for (const hub of getAllOperatorHubs()) {
      entries.push(
        urlEntry(
          `${SITE_URL}/operators/${hub.operator.slug}`,
          lastmodFor(hub.lastChanged, lastmod),
          "weekly",
          "0.7",
        ),
      );
    }

    // Connections are the money pages, so they outrank the station hubs. In
    // batch 1 only the busiest corridors ship.
    const pairs = [...getAllCityPairs()].sort(
      (a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug),
    );
    // …plus every page in the snippet rollout (src/lib/seo/snippet.mjs), so a
    // page being measured is never one Google has to stumble on. European
    // Sleeper's Brussels–Prague, its main line, ranked 88th by the alphabetical
    // tie-break among one-train corridors and was in no sitemap at all.
    const inRollout = (pair) => snippetVariantFor(pair.operatorIds || []) === FACTS;
    const shipped =
      SITEMAP_BATCH >= 2
        ? pairs
        : pairs.filter((pair, i) => i < BATCH_1_CONNECTIONS || inRollout(pair));
    for (const pair of shipped) {
      entries.push(
        urlEntry(
          `${SITE_URL}/connections/${pair.slug}`,
          lastmodFor(pair.lastChanged, lastmod),
          "weekly",
          "0.8",
        ),
      );
    }
  } catch (err) {
    console.error("[sitemap] failed to build data-derived URLs:", err);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}
</urlset>`;
}

function SiteMap() {
  // getServerSideProps will do the heavy lifting
}

export async function getServerSideProps({ res }) {
  const sitemap = generateSiteMap();

  res.setHeader("Content-Type", "text/xml");
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate");
  res.write(sitemap);
  res.end();

  return {
    props: {},
  };
}

export default SiteMap;
