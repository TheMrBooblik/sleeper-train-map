import {
  setPublishedPayload,
  getAllRouteSummaries,
  getDataGeneratedAt,
} from "../lib/seo/data";
import {
  getAllCountryHubs,
  getAllOperatorHubs,
  getAllCityPairs,
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

function wrap(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}
</urlset>`;
}

// Always-available core pages (no data dependency).
function coreEntries(lastmod) {
  return [
    urlEntry(SITE_URL, lastmod, "weekly", "1.0"),
    urlEntry(`${SITE_URL}/about`, lastmod, "monthly", "0.9"),
    urlEntry(`${SITE_URL}/trains`, lastmod, "weekly", "0.9"),
  ];
}

// Full sitemap — requires the published payload to have been injected.
function fullSitemap() {
  const lastmod = getDataGeneratedAt();
  const entries = [...coreEntries(new Date().toISOString())];

  // Country hubs (replace the old /?country= deep-link entries)
  for (const { country } of getAllCountryHubs()) {
    entries.push(urlEntry(`${SITE_URL}/night-trains/${country.slug}`, lastmod, "weekly", "0.8"));
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
  return wrap(entries);
}

/**
 * Load the published payload the same runtime-safe way the app does. On Vercel the
 * `public/` files are not on the lambda filesystem, so the SEO data layer cannot
 * fs-read them at request time. The /api/initial-data endpoint already resolves the
 * gated payload (published file → daily-scrape store → GitHub), so we reuse it.
 */
async function loadPayload(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers.host;
  if (!host) throw new Error("missing host header");
  const resp = await fetch(`${proto}://${host}/api/initial-data`, {
    headers: { "user-agent": "pingwi-sitemap" },
  });
  if (!resp.ok) throw new Error(`initial-data responded ${resp.status}`);
  const data = await resp.json();
  if (!data || !data.viewMap) throw new Error("initial-data payload missing viewMap");
  return data;
}

export async function getServerSideProps({ req, res }) {
  let xml;
  try {
    setPublishedPayload(await loadPayload(req));
    xml = fullSitemap();
  } catch (err) {
    // Never 500: fall back to the core pages so the sitemap is always valid.
    console.error("[sitemap] full build failed, serving core pages:", err?.message || err);
    xml = wrap(coreEntries(new Date().toISOString()));
  }

  res.setHeader("Content-Type", "text/xml");
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate");
  res.write(xml);
  res.end();
  return { props: {} };
}

export default function SiteMap() {
  return null;
}
