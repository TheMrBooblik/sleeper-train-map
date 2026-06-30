import Head from "next/head";
import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import JsonLd from "@components/seo/JsonLd";

import {
  getAllCountryHubs,
  getCountryHub,
  getStationHubsForCountry,
} from "../../lib/seo/aggregate";
import { getFlagEmoji } from "../../lib/countries";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

export default function CountryHub({ country, routes, operators, stations }) {
  const canonical = absoluteUrl(`/night-trains/${country.slug}`);
  const title = `Night Trains in ${country.name} — Routes & Sleeper Connections | Pingwi`;
  const operatorNames = operators.map((o) => o.name).join(", ");
  const description =
    `All ${routes.length} night and sleeper train routes serving ${country.name}` +
    (operatorNames ? `, operated by ${operatorNames}.` : ".") +
    " Timetables, stops and connections on an interactive map.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `Night Trains in ${country.name}`,
    description,
    url: canonical,
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
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={OG_IMAGE} />
      </Head>

      <SeoLayout>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs
            items={[
              { name: "Home", href: "/" },
              { name: "Night trains", href: "/trains" },
              { name: country.name },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
              <span className="mr-2">{getFlagEmoji(country.code)}</span>
              Night Trains in {country.name}
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">{description}</p>
            <div className="mt-6">
              <Link
                href={`/?country=${country.code}`}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-semibold text-sm transition-colors"
              >
                View {country.name} on the map
                <FaArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </header>

          {operators.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-white">Operators</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {operators.map((o) => (
                  <Link
                    key={o.id}
                    href={`/operators/${o.slug}`}
                    className="rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    {o.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {stations.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-white">Departure stations</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {stations.map((st) => (
                  <Link
                    key={st.slug}
                    href={`/night-trains/${country.slug}/from/${st.slug}`}
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    {st.name}
                    <span className="text-xs text-white/40">{st.routeCount}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">
              Routes ({routes.length})
            </h2>
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

export async function getStaticPaths() {
  return {
    paths: getAllCountryHubs().map((h) => ({ params: { country: h.country.slug } })),
    fallback: false,
  };
}

export async function getStaticProps({ params }) {
  const hub = getCountryHub(params.country);
  if (!hub) return { notFound: true };
  const routes = hub.routes.map((s) => ({
    routeId: s.routeId,
    slug: s.slug,
    title: s.title,
    trainNumbers: s.trainNumbers,
    operatorIds: s.operatorIds,
    operators: s.operators,
  }));
  return {
    props: {
      country: hub.country,
      routes,
      operators: hub.operators,
      stations: getStationHubsForCountry(params.country),
    },
  };
}
