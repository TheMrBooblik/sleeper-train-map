import Head from "next/head";
import Link from "next/link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import JsonLd from "@components/seo/JsonLd";

import {
  getAllCountryHubs,
  getAllOperatorHubs,
  getAllCityPairs,
} from "../../lib/seo/aggregate";
import { getAllRouteSummaries } from "../../lib/seo/data";
import { getFlagEmoji } from "../../lib/countries";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

const TITLE = "Night Train Connections — Every Sleeper Route | Pingwi";
const DESCRIPTION =
  "Every night and sleeper train connection on the map, city pair by city pair — across Europe and beyond. Timetables, stops, journey times and where to book each one.";

function ChipLink({ href, children, count }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
    >
      {children}
      {typeof count === "number" && <span className="text-xs text-white/40">{count}</span>}
    </Link>
  );
}

/**
 * The hub-of-hubs. Replaced /trains, which listed one card per train; connections
 * are now the only route page type, so this lists every city pair. It is the
 * single page that links to all of them — the main crawl path into the long tail.
 */
export default function ConnectionsIndex({ countries, operators, cityPairs, routeCount }) {
  const canonical = absoluteUrl("/connections");
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Night Train Connections",
    description: DESCRIPTION,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: "Pingwi Sleeper Train Map", url: SITE_URL },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: cityPairs.length,
      itemListElement: cityPairs.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: absoluteUrl(`/connections/${p.slug}`),
        name: `${p.cityA} to ${p.cityB}`,
      })),
    },
  };

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE} />
      </Head>

      <SeoLayout>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Connections" }]} />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight">
              Night Train Connections
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">
              {cityPairs.length} city connections served by {routeCount} sleeper and overnight
              trains across {countries.length} countries. Browse by country, operator, or jump
              straight to a route — each page has the full timetable, every stop and onward
              booking links.
            </p>
          </header>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">Night trains by country</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {countries.map(({ country, routeCount: n }) => (
                <ChipLink key={country.code} href={`/night-trains/${country.slug}`} count={n}>
                  <span>{getFlagEmoji(country.code)}</span>
                  {country.name}
                </ChipLink>
              ))}
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">Night trains by operator</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {operators.map(({ operator, routeCount: n }) => (
                <ChipLink key={operator.id} href={`/operators/${operator.slug}`} count={n}>
                  {operator.name}
                </ChipLink>
              ))}
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">All connections</h2>
            <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {cityPairs.map((p) => (
                <Link
                  key={p.slug}
                  href={`/connections/${p.slug}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-white/80 hover:text-white hover:border-primary-green/50 transition-colors"
                >
                  <span>
                    {p.cityA} <span className="text-white/40">↔</span> {p.cityB}
                  </span>
                  <span className="text-xs text-white/40">{p.routeCount}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </SeoLayout>

      <JsonLd data={collectionLd} />
    </>
  );
}

export async function getStaticProps() {
  return {
    props: {
      countries: getAllCountryHubs(),
      operators: getAllOperatorHubs(),
      cityPairs: getAllCityPairs(),
      routeCount: getAllRouteSummaries().length,
    },
  };
}
