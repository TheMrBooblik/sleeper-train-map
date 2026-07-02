import Head from "next/head";
import Link from "next/link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import JsonLd from "@components/seo/JsonLd";

import { getAllRouteSummaries, toCardRoute } from "../../lib/seo/data";
import {
  getAllCountryHubs,
  getAllOperatorHubs,
  getAllCityPairs,
} from "../../lib/seo/aggregate";
import { getFlagEmoji } from "../../lib/countries";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

const TITLE = "All European Night Train Routes — Sleeper Train Directory | Pingwi";
const DESCRIPTION =
  "Browse every European night and sleeper train route on the map: search by country, operator or city connection, with timetables, stops and prices for each train.";

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

export default function TrainsIndex({ routes, countries, operators, cityPairs }) {
  const canonical = absoluteUrl("/trains");
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "European Night Train Routes",
    description: DESCRIPTION,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: "Pingwi Sleeper Train Map", url: SITE_URL },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: routes.length,
      itemListElement: routes.map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: absoluteUrl(`/trains/${r.slug}`),
        name: r.title,
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
          <Breadcrumbs
            items={[{ name: "Home", href: "/" }, { name: "Night trains" }]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight">
              European Night Train Routes
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">
              {routes.length} sleeper and overnight train routes across {countries.length}{" "}
              countries. Explore them by country, operator or popular city connection — each
              with a full timetable, stops and onward booking links.
            </p>
          </header>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">Night trains by country</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {countries.map(({ country, routeCount }) => (
                <ChipLink key={country.code} href={`/night-trains/${country.slug}`} count={routeCount}>
                  <span>{getFlagEmoji(country.code)}</span>
                  {country.name}
                </ChipLink>
              ))}
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">Night trains by operator</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {operators.map(({ operator, routeCount }) => (
                <ChipLink key={operator.id} href={`/operators/${operator.slug}`} count={routeCount}>
                  {operator.name}
                </ChipLink>
              ))}
            </div>
          </section>

          {cityPairs.length > 0 && (
            <section className="mt-12">
              <h2 className="text-xl font-semibold text-white">Popular connections</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {cityPairs.map((p) => (
                  <ChipLink key={p.slug} href={`/connections/${p.slug}`} count={p.routeCount}>
                    {p.originCity} → {p.destCity}
                  </ChipLink>
                ))}
              </div>
            </section>
          )}

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white">All routes</h2>
            <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {routes.map((r) => (
                <RouteCardLink key={r.routeId} route={r} />
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
  // Trim summaries to just what the cards/JSON need (keep props lean).
  const routes = getAllRouteSummaries().map(toCardRoute);
  return {
    props: {
      routes,
      countries: getAllCountryHubs(),
      operators: getAllOperatorHubs(),
      cityPairs: getAllCityPairs(),
    },
  };
}
