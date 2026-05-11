import { COUNTRIES } from "../lib/countries";

const SITE_URL = "https://sleeper-train-map.pingwi.com";

function generateSiteMap() {
  const now = new Date().toISOString();
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/about</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  ${COUNTRIES.map(
    (country) => `
  <url>
    <loc>${SITE_URL}/?country=${country.code}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`
  ).join("")}
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
