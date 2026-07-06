import Head from "next/head";
import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import JsonLd from "@components/seo/JsonLd";

import {
  getAllCountryHubs,
  getStationHubsForCountry,
  getStationHub,
} from "../../../../lib/seo/aggregate";
import { toCardRoute } from "../../../../lib/seo/data";
import { getFlagEmoji } from "../../../../lib/countries";
import { OG_IMAGE, absoluteUrl } from "../../../../lib/seo/site";

export default function StationHub({ country, station, routes, operators }) {
  const canonical = absoluteUrl(`/night-trains/${country.slug}/from/${station.slug}`);
  const title = `Night Trains from ${station.name} (${country.name}) | Pingwi`;
  const operatorNames = operators.map((o) => o.name).join(", ");
  const description =
    `${routes.length} night and sleeper trains run from ${station.name}` +
    (operatorNames ? `, operated by ${operatorNames}.` : ".") +
    " Compare timetables, stops and overnight connections on an interactive map.";

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Night trains from ${station.name}`,
    numberOfItems: routes.length,
    itemListElement: routes.map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: absoluteUrl(`/trains/${r.slug}`),
      name: r.title,
    })),
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
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs
            items={[
              { name: "Home", href: "/" },
              { name: "Night trains", href: "/trains" },
              { name: country.name, href: `/night-trains/${country.slug}` },
              { name: station.name },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-balance">
              <span className="mr-2">{getFlagEmoji(country.code)}</span>
              Night Trains from {station.name}
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">{description}</p>
            <div className="mt-6">
              <Link
                href={`/night-trains/${country.slug}`}
                className="inline-flex items-center gap-2 text-primary-green hover:text-primary-green-light transition-colors text-sm"
              >
                See all night trains in {country.name}
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

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">
              {routes.length} trains serving {station.name}
            </h2>
            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {routes.map((r) => (
                <RouteCardLink key={r.routeId} route={r} />
              ))}
            </div>
          </section>
        </div>
      </SeoLayout>

      <JsonLd data={itemListLd} />
    </>
  );
}

export async function getStaticPaths() {
  const paths = [];
  for (const { country } of getAllCountryHubs()) {
    for (const st of getStationHubsForCountry(country.slug)) {
      paths.push({ params: { country: country.slug, station: st.slug } });
    }
  }
  return { paths, fallback: false };
}

export async function getStaticProps({ params }) {
  const hub = getStationHub(params.country, params.station);
  if (!hub) return { notFound: true };
  const routes = hub.routes.map(toCardRoute);
  return {
    props: {
      country: hub.country,
      station: hub.station,
      routes,
      operators: hub.operators,
    },
  };
}
