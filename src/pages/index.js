import Head from "next/head";
import Layout from "@components/Layout";
import HomeSeoPanel from "@components/seo/HomeSeoPanel";
import { organizationLd, webSiteLd } from "../lib/seo/schema";

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

        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pingwi Sleeper Train Map" />
        <meta
          name="twitter:description"
          content="Interactive map of all European sleeper train routes. Discover overnight connections across 24+ countries."
        />

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
