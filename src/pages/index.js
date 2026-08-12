import Head from "next/head";
import Layout from "@components/Layout";
import { organizationLd, webSiteLd } from "../lib/seo/schema";
import { OG_IMAGE, SITE_URL } from "../lib/seo/site";

const TITLE =
  "Sleeper Train Map - Night Trains Across Europe & Beyond | Pingwi";
const DESCRIPTION =
  "Interactive sleeper train map: night and overnight train routes across Europe and beyond. Click any station to see timetables, stops and where to book each connection.";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Sleeper Train Map 2026 (interactive)",
  description:
    "Interactive map of sleeper and night train routes across Europe and beyond. Click any station to discover overnight train connections and timetables.",
  url: SITE_URL,
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
    <Layout tourSeo={seo}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta
          name="keywords"
          content="sleeper train map, night train map, night trains Europe, European sleeper trains, overnight train routes, sleeper train routes"
        />
        <link rel="canonical" href={SITE_URL} />

        {/* Open Graph */}
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />

        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
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
    </Layout>
  );
}

// Operators shown on the homepage; the /connections directory lists the rest.
const HOME_OPERATOR_LIMIT = 12;
// Connections linked directly from the homepage. Under crawl starvation the
// homepage is the strongest internal signal the site has, so it points at the
// busiest corridors rather than a hand-picked handful.
const HOME_CONNECTION_LIMIT = 50;
// Pin these three first in the tour's "By operator" chips.
const PINNED_OPERATOR_SLUGS = ["european-sleeper", "trenitalia", "regiojet"];

export async function getStaticProps() {
  // Dynamic imports keep the fs-reading SEO data layer out of the client
  // bundle (same pattern as about.js).
  const { getAllCountryHubs, getAllOperatorHubs, getTopCityPairs } =
    await import("../lib/seo/aggregate");
  const { getAllRouteSummaries } = await import("../lib/seo/data");

  const countryHubs = getAllCountryHubs();
  const countries = countryHubs.map(({ country, routeCount }) => ({
    slug: country.slug,
    name: country.name,
    code: country.code,
    routeCount,
  }));

  // European Sleeper, Trenitalia, RegioJet first; then everyone else by count.
  const hubs = getAllOperatorHubs();
  const bySlug = new Map(hubs.map((h) => [h.operator.slug, h]));
  const pinned = PINNED_OPERATOR_SLUGS.map((s) => bySlug.get(s)).filter(
    Boolean,
  );
  const pinnedSet = new Set(PINNED_OPERATOR_SLUGS);
  const rest = hubs
    .filter((h) => !pinnedSet.has(h.operator.slug))
    .sort((a, b) => b.routeCount - a.routeCount);
  const operators = [...pinned, ...rest]
    .slice(0, HOME_OPERATOR_LIMIT)
    .map(({ operator, routeCount }) => ({
      slug: operator.slug,
      name: operator.name,
      routeCount,
    }));

  return {
    props: {
      seo: {
        countries,
        operators,
        connections: getTopCityPairs(HOME_CONNECTION_LIMIT).map((p) => ({
          slug: p.slug,
          label: `${p.cityA} → ${p.cityB}`,
        })),
        routeCount: getAllRouteSummaries().length,
        countryCount: countries.length,
      },
    },
  };
}
