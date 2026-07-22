import Head from "next/head";
import Layout from "@components/Layout";
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
    <Layout tourSeo={seo}>
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
    </Layout>
  );
}

// Operators shown on the homepage; the /trains directory lists the rest.
const HOME_OPERATOR_LIMIT = 12;
// Pin these three first in the tour's "By operator" chips.
const PINNED_OPERATOR_SLUGS = ["european-sleeper", "trenitalia", "regiojet"];

// Curated homepage connections (static; slugs are stable across rebuilds).
// Order: European Sleeper → Trenitalia → RegioJet → other EU → one CN + one CA.
const HOME_CONNECTIONS = [
  // European Sleeper corridors — single-train pages where no /connections hub exists
  {
    key: "es-bru-praha",
    label: "Brussels → Prague",
    href: "/trains/praha-hl-n-to-bruxelles-midi-brussel-zuid-452",
  },
  {
    key: "es-ber-par",
    label: "Berlin → Paris",
    href: "/trains/berlin-hbf-to-paris-gare-du-nord-474",
  },
  {
    key: "es-bru-mil",
    label: "Brussels → Milan",
    href: "/connections/brussels-to-milan",
  },
  // Trenitalia
  {
    key: "fs-rome-sir",
    label: "Rome → Siracusa",
    href: "/connections/rome-to-siracusa",
  },
  // RegioJet
  {
    key: "rj-prg-prz",
    label: "Prague → Przemyśl",
    href: "/connections/prague-to-przemysl-gl",
  },
  // Other European hubs
  {
    key: "ber-sto",
    label: "Berlin → Stockholm",
    href: "/connections/berlin-to-stockholm",
  },
  {
    key: "buc-bud",
    label: "Bucharest → Budapest",
    href: "/connections/bucharest-to-budapest",
  },
  {
    key: "grz-zur",
    label: "Graz → Zurich",
    href: "/connections/graz-to-zurich",
  },
  // One Chinese + one Canadian showcase
  {
    key: "cn-bei-sha",
    label: "Beijing → Shanghai",
    href: "/connections/beijing-to-shanghai",
  },
  {
    key: "ca-tor-van",
    label: "Toronto → Vancouver",
    href: "/trains/toronto-to-vancouver-vancouver-toronto",
  },
];

export async function getStaticProps() {
  // Dynamic imports keep the fs-reading SEO data layer out of the client
  // bundle (same pattern as about.js).
  const { getAllCountryHubs, getAllOperatorHubs } = await import(
    "../lib/seo/aggregate"
  );
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
        connections: HOME_CONNECTIONS,
        routeCount: getAllRouteSummaries().length,
        countryCount: countries.length,
      },
    },
  };
}
