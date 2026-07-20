import { getAllRouteSummaries, getDataGeneratedAt } from "../lib/seo/data";
import {
  getAllCountryHubs,
  getAllOperatorHubs,
  getAllCityPairs,
  getStationHubsForCountry,
} from "../lib/seo/aggregate";

const SITE_URL = "https://sleeper-train-map.pingwi.com";

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
  const staticLastmod = new Date().toISOString();

  const entries = [];

  // Core pages — emitted unconditionally so the sitemap is always valid even if the
  // data layer can't load (e.g. the committed payload is missing from the lambda).
  entries.push(urlEntry(SITE_URL, staticLastmod, "weekly", "1.0"));
  entries.push(urlEntry(`${SITE_URL}/about`, staticLastmod, "monthly", "0.9"));
  entries.push(urlEntry(`${SITE_URL}/privacy`, staticLastmod, "yearly", "0.3"));

  // Data-derived pages. Wrapped so a read failure degrades to the core sitemap
  // (HTTP 200) instead of throwing a 500 and giving crawlers nothing at all.
  try {
    const lastmod = getDataGeneratedAt();

    entries.push(urlEntry(`${SITE_URL}/trains`, lastmod, "weekly", "0.9"));

    // Country hubs (replace the old /?country= deep-link entries)
    for (const { country } of getAllCountryHubs()) {
      entries.push(urlEntry(`${SITE_URL}/night-trains/${country.slug}`, lastmod, "weekly", "0.8"));
      // Per-station "/from" hubs nested under each country.
      for (const st of getStationHubsForCountry(country.slug)) {
        entries.push(
          urlEntry(`${SITE_URL}/night-trains/${country.slug}/from/${st.slug}`, lastmod, "weekly", "0.6"),
        );
      }
    }

    // Operator hubs
    for (const { operator } of getAllOperatorHubs()) {
      entries.push(urlEntry(`${SITE_URL}/operators/${operator.slug}`, lastmod, "weekly", "0.7"));
    }

    // Per-train pages
    for (const route of getAllRouteSummaries()) {
      entries.push(urlEntry(`${SITE_URL}/trains/${route.slug}`, lastmod, "weekly", "0.7"));
    }

    // City-pair connections
    for (const pair of getAllCityPairs()) {
      entries.push(urlEntry(`${SITE_URL}/connections/${pair.slug}`, lastmod, "weekly", "0.6"));
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
