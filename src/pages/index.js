import Head from "next/head";
import Layout from "@components/Layout";
import HomeSeoPanel from "@components/seo/HomeSeoPanel";
import { organizationLd, webSiteLd } from "../lib/seo/schema";
import { OG_IMAGE } from "../lib/seo/site";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Sleeper Train Map 2026 (interactive)",
  description:
    "Interactive map of European sleeper train routes. Click any station to discover overnight train connections across 24+ countries.",
  url: "https://sleeper-train-map.pingwi.com",
  applicationCategory: "TravelApplication",
  operatingSystem: "Web Browser",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "EUR",
  },
};

export default function Home({ seo }) {
  return (
    <Layout>
      <Head>
        <title>Sleeper Train Map 2026 (interactive)</title>
        <meta
          name="description"
          content="Interactive sleeper train map. Click any station to discover all night train routes and overnight connections across 24+ countries. Plan your spontaneous train travel."
        />
        <meta
          name="keywords"
          content="sleeper train map, night train Europe, European sleeper trains, overnight train routes, train travel Europe, night train map"
        />
        <link rel="canonical" href="https://sleeper-train-map.pingwi.com" />

        {/* Open Graph */}
        <meta
          property="og:title"
          content="Sleeper Train Map 2026 (interactive)"
        />
        <meta
          property="og:description"
          content="Interactive map of all European sleeper train routes. Click any station to discover overnight connections across 24+ countries."
        />
        <meta property="og:type" content="website" />
        <meta
          property="og:url"
          content="https://sleeper-train-map.pingwi.com"
        />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />

        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pingwi Sleeper Train Map" />
        <meta
          name="twitter:description"
          content="Interactive map of all European sleeper train routes. Discover overnight connections across 24+ countries."
        />
        <meta name="twitter:image" content={OG_IMAGE} />

        {/* JSON-LD Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd()) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteLd()) }}
        />
      </Head>

      <HomeSeoPanel
        countries={seo?.countries ?? []}
        operators={seo?.operators ?? []}
        connections={seo?.connections ?? []}
        routeCount={seo?.routeCount ?? 0}
        countryCount={seo?.countryCount ?? 0}
      />
    </Layout>
  );
}

// How many "popular connections" chips the homepage panel links to.
const HOME_CONNECTION_LIMIT = 10;
// Operators shown on the homepage; the /trains directory lists the rest.
const HOME_OPERATOR_LIMIT = 12;

export async function getStaticProps() {
  // Dynamic imports keep the fs-reading SEO data layer out of the client
  // bundle (same pattern as about.js).
  const { getAllCountryHubs, getAllOperatorHubs, getAllCityPairs } =
    await import("../lib/seo/aggregate");
  const { getAllRouteSummaries } = await import("../lib/seo/data");

  const countryHubs = getAllCountryHubs();
  const countries = countryHubs.map(({ country, routeCount }) => ({
    slug: country.slug,
    name: country.name,
    code: country.code,
    routeCount,
  }));

  const operators = getAllOperatorHubs()
    .sort((a, b) => b.routeCount - a.routeCount)
    .slice(0, HOME_OPERATOR_LIMIT)
    .map(({ operator, routeCount }) => ({
      slug: operator.slug,
      name: operator.name,
      routeCount,
    }));

  const connections = getAllCityPairs()
    .sort((a, b) => b.routeCount - a.routeCount || a.slug.localeCompare(b.slug))
    .slice(0, HOME_CONNECTION_LIMIT)
    .map((p) => ({ slug: p.slug, label: `${p.originCity} → ${p.destCity}` }));

  return {
    props: {
      seo: {
        countries,
        operators,
        connections,
        routeCount: getAllRouteSummaries().length,
        countryCount: countries.length,
      },
    },
  };
}
