import Head from "next/head";
import Link from "next/link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import JsonLd from "@components/seo/JsonLd";
import BookingGuide from "@components/BookingGuide";

import {
  getAllOperatorHubs,
  getOperatorHub,
  getConnectionsForOperator,
} from "../../lib/seo/aggregate";
import { toCardRoute } from "../../lib/seo/data";
import { getFlagEmoji } from "../../lib/countries";
import { getOperatorPricing, pricingAdvice } from "../../lib/operatorPricing";
import { hasLastMinuteDeals } from "../../lib/operatorBooking";
import { getBookingGuide, guideProps } from "../../lib/bookingGuide.mjs";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

export default function OperatorHub({
  operator,
  routes,
  countries,
  connections,
  advice,
  unpricedEuroNights = 0,
  bookingGuide = null,
}) {
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
        url: absoluteUrl(`/connections/${r.pairSlug}`),
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
              { name: "Connections", href: "/connections" },
              { name: operator.name },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
              {operator.name} Night Trains
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">{description}</p>
          </header>

          {advice && (
            <section className="mt-8 max-w-3xl rounded-lg border border-white/10 bg-white/[0.02] p-5">
              <h2 className="text-sm font-semibold text-white">
                {advice.headline} — how {operator.name} prices tickets
              </h2>
              <p className="mt-2 text-sm text-white/60 leading-relaxed text-pretty">
                {operator.name} sells {advice.detail}.
                {advice.caveat ? ` That said, ${advice.caveat}.` : ""}
                {unpricedEuroNights > 0
                  ? ` This does not describe ${
                      unpricedEuroNights === 1
                        ? "the international EuroNight below"
                        : `the ${unpricedEuroNights} international EuroNights below`
                    }, whose fares are set separately and are not shown here.`
                  : ""}
              </p>
            </section>
          )}

          {bookingGuide && <BookingGuide guide={bookingGuide} className="mt-8 max-w-3xl" />}

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

          {connections.length > 0 && (
            <section className="mt-12">
              <h2 className="text-lg font-semibold text-white">
                Connections served ({connections.length})
              </h2>
              <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {connections.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/connections/${c.slug}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-white/80 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    <span>
                      {c.cityA} <span className="text-white/40">&harr;</span> {c.cityB}
                    </span>
                    <span className="shrink-0 text-xs text-white/40">{c.routeCount}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
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
  const routes = hub.routes.map(toCardRoute);
  return {
    props: {
      operator: hub.operator,
      routes,
      countries: hub.countries,
      connections: getConnectionsForOperator(params.operator),
      // "Should I book this operator early?" is an operator-level question, so
      // the operator's own hub is where it belongs — and it was the one page
      // that said nothing about fares at all.
      advice:
        pricingAdvice(getOperatorPricing({ agency_id: hub.operator.id }), {
          hasLastMinuteDeals: hasLastMinuteDeals(hub.operator.id),
        }) ?? null,
      // The operator's fare model is its own trains' — PKP's "fixed tariff"
      // is its domestic one. The international EuroNights it runs are sold
      // at fares no source here publishes, and their rows say so with an
      // empty pricing record from nightjet.com (stampOfficialFares); the hub
      // must not state the domestic model above them as if it covered them.
      unpricedEuroNights: hub.routes.filter(
        (r) => r.pricing && r.pricing.type == null && r.pricing.source === "nightjet",
      ).length,
      bookingGuide: guideProps(getBookingGuide({ agencyId: hub.operator.id })),
    },
  };
}
