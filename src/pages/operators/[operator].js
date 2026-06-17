import Head from "next/head";
import Link from "next/link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import JsonLd from "@components/seo/JsonLd";

import { getAllOperatorHubs, getOperatorHub } from "../../lib/seo/aggregate";
import { getFlagEmoji } from "../../lib/countries";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

export default function OperatorHub({ operator, routes, countries }) {
  const canonical = absoluteUrl(`/operators/${operator.slug}`);
  const title = `${operator.name} Night Train Routes & Destinations | Pingwi`;
  const countryNames = countries.map((c) => c.name).join(", ");
  const description =
    `Every ${operator.name} night and sleeper train route — ${routes.length} connections` +
    (countryNames ? ` across ${countryNames}.` : ".") +
    " Timetables, stops and destinations on an interactive map.";

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${operator.name} Night Train Routes`,
    description,
    url: canonical,
    about: { "@type": "Organization", name: operator.name },
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
              { name: operator.name },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
              {operator.name} Night Trains
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">{description}</p>
          </header>

          {countries.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-white">Countries served</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {countries.map((c) => (
                  <Link
                    key={c.code}
                    href={`/night-trains/${c.slug}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    <span>{getFlagEmoji(c.code)}</span>
                    {c.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">Routes ({routes.length})</h2>
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
    paths: getAllOperatorHubs().map((h) => ({ params: { operator: h.operator.slug } })),
    fallback: false,
  };
}

export async function getStaticProps({ params }) {
  const hub = getOperatorHub(params.operator);
  if (!hub) return { notFound: true };
  const routes = hub.routes.map((s) => ({
    routeId: s.routeId,
    slug: s.slug,
    title: s.title,
    trainNumbers: s.trainNumbers,
    operatorIds: s.operatorIds,
    operators: s.operators,
  }));
  return { props: { operator: hub.operator, routes, countries: hub.countries } };
}
