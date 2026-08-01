import Head from "next/head";
import Link from "next/link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteCardLink from "@components/seo/RouteCardLink";
import FaqSection from "@components/seo/FaqSection";
import JsonLd from "@components/seo/JsonLd";

import { getAllCityPairs, getCityPair } from "../../lib/seo/aggregate";
import { toCardRoute } from "../../lib/seo/data";
import { buildConnectionFaq } from "../../lib/seo/routeFaq.mjs";
import { getFlagEmoji } from "../../lib/countries";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

export default function ConnectionPage({ slug, originCity, destCity, routes, operators, countries, faq }) {
  const canonical = absoluteUrl(`/connections/${slug}`);
  const title = `Night Train ${originCity} to ${destCity} — Sleeper Connections | Pingwi`;
  const operatorNames = operators.map((o) => o.name).join(", ");
  const description =
    `${routes.length} night trains connect ${originCity} and ${destCity}` +
    (operatorNames ? `, run by ${operatorNames}.` : ".") +
    " Compare timetables, stops and operators for the overnight journey.";

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Night trains from ${originCity} to ${destCity}`,
    numberOfItems: routes.length,
    itemListElement: routes.map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: absoluteUrl(`/trains/${r.slug}`),
      name: r.title,
    })),
  };

  const faqLd =
    faq && faq.length
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faq.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }
      : null;

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
              { name: `${originCity} → ${destCity}` },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight text-balance">
              Night Trains from {originCity} to {destCity}
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">{description}</p>
          </header>

          {(operators.length > 0 || countries.length > 0) && (
            <div className="mt-6 flex flex-wrap gap-2">
              {countries.map((c) => (
                <Link
                  key={c.code}
                  href={`/night-trains/${c.slug}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                >
                  <span>{getFlagEmoji(c.code)}</span>
                  {c.name}
                </Link>
              ))}
              {operators.map((o) => (
                <Link
                  key={o.id}
                  href={`/operators/${o.slug}`}
                  className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                >
                  {o.name}
                </Link>
              ))}
            </div>
          )}

          <section className="mt-10">
            <h2 className="text-lg font-semibold text-white">
              {routes.length} trains on this route
            </h2>
            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {routes.map((r) => (
                <RouteCardLink key={r.routeId} route={r} />
              ))}
            </div>
          </section>

          <FaqSection items={faq} />
        </div>
      </SeoLayout>

      <JsonLd data={itemListLd} />
      {faqLd && <JsonLd data={faqLd} />}
    </>
  );
}

export async function getStaticPaths() {
  return {
    paths: getAllCityPairs().map((p) => ({ params: { pair: p.slug } })),
    fallback: false,
  };
}

export async function getStaticProps({ params }) {
  const pair = getCityPair(params.pair);
  if (!pair) return { notFound: true };
  const routes = pair.routes.map(toCardRoute);

  // Fastest journey + cheapest known "from" price across the pair's trains.
  const timed = pair.routes.filter((r) => r.durationMinutes > 0);
  const fastest = timed.length
    ? timed.reduce((a, b) => (a.durationMinutes <= b.durationMinutes ? a : b))
    : null;
  const priced = pair.routes.filter((r) => r.pricing && r.pricing.fromPrice != null);
  const cheapest = priced.length
    ? priced.reduce((a, b) => (a.pricing.fromPrice <= b.pricing.fromPrice ? a : b))
    : null;

  const faq = buildConnectionFaq({
    originCity: pair.originCity,
    destCity: pair.destCity,
    trainCount: pair.routes.length,
    operators: pair.operators.map((o) => o.name),
    fastestDurationText: fastest?.durationText || "",
    fromPrice: cheapest?.fromPrice || "",
  });

  return {
    props: {
      slug: pair.slug,
      originCity: pair.originCity,
      destCity: pair.destCity,
      routes,
      operators: pair.operators,
      countries: pair.countries,
      faq,
    },
  };
}
