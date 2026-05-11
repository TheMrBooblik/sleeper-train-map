import Head from "next/head";
import Layout from "@components/Layout";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "Pingwi Sleeper Train Map",
  "description": "Interactive map of European sleeper train routes. Click any station to discover overnight train connections across 24+ countries.",
  "url": "https://pingwi.eu",
  "applicationCategory": "TravelApplication",
  "operatingSystem": "Web Browser",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "EUR"
  }
};

export default function Home() {
  return (
    <Layout>
      <Head>
        <title>Pingwi Sleeper Train Map - European Night Train Routes</title>
        <meta
          name="description"
          content="Interactive sleeper train map of Europe. Click any station to discover all night train routes and overnight connections across 24+ countries. Plan your spontaneous train travel."
        />
        <meta name="keywords" content="sleeper train map, night train Europe, European sleeper trains, overnight train routes, train travel Europe, night train map" />
        <link rel="canonical" href="https://pingwi.eu" />
        
        {/* Open Graph */}
        <meta property="og:title" content="Pingwi Sleeper Train Map - European Night Train Routes" />
        <meta property="og:description" content="Interactive map of all European sleeper train routes. Click any station to discover overnight connections across 24+ countries." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://pingwi.eu" />
        
        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pingwi Sleeper Train Map" />
        <meta name="twitter:description" content="Interactive map of all European sleeper train routes. Discover overnight connections across 24+ countries." />
        
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
        
        {/* JSON-LD Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </Head>
    </Layout>
  );
}
