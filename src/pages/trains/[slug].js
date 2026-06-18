import Head from "next/head";
import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteTimetable from "@components/seo/RouteTimetable";
import RouteFactsGrid from "@components/seo/RouteFactsGrid";
import RouteCardLink from "@components/seo/RouteCardLink";
import RouteMapIsland from "@components/seo/RouteMapIsland";
import JsonLd from "@components/seo/JsonLd";

import {
  getRouteSlugMap,
  getRouteDetail,
  getAllRouteSummaries,
} from "../../lib/seo/data";
import {
  getRelatedRoutes,
  getCityPairSlugForRoute,
} from "../../lib/seo/aggregate";
import { SITE_URL, OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

function buildIntro(detail) {
  const operators = detail.operators.map((o) => o.name).join(" and ");
  const trains = detail.directions.map((d) => d.trainNumber).filter(Boolean);
  const trainLabel = trains.length ? `the ${trains.join(" / ")} ` : "";
  const stopCount = detail.directions[0]?.stops?.length || 0;
  const parts = [];
  parts.push(
    `${trainLabel}night train${operators ? ` operated by ${operators}` : ""} connects ${detail.origin} and ${detail.destination}`,
  );
  if (stopCount > 2) parts.push(`calling at ${stopCount} stations`);
  let intro = parts.join(", ") + ".";
  if (detail.facts.durationText) {
    intro += ` The journey takes about ${detail.facts.durationText}`;
    intro += detail.facts.distanceText ? ` over ${detail.facts.distanceText}.` : ".";
  }
  return intro;
}

function buildDescription(detail) {
  const trains = detail.directions.map((d) => d.trainNumber).filter(Boolean);
  const trainLabel = trains.length ? `${trains.join("/")} ` : "";
  const bits = [
    `Timetable, stops and tickets for the ${trainLabel}night train from ${detail.origin} to ${detail.destination}.`,
  ];
  if (detail.facts.durationText) bits.push(`Journey time ${detail.facts.durationText}.`);
  const dep = detail.directions[0]?.departureTime;
  if (dep) bits.push(`Departs ${dep}.`);
  if (detail.operators.length) bits.push(`Operated by ${detail.operators.map((o) => o.name).join(", ")}.`);
  return bits.join(" ").slice(0, 320);
}

export default function TrainPage({ detail, related, cityPair }) {
  const canonical = absoluteUrl(`/trains/${detail.slug}`);
  const title = `Night Train ${detail.origin} to ${detail.destination}${
    detail.primaryTrainNumber ? ` (${detail.primaryTrainNumber})` : ""
  } — Times & Stops | Pingwi`;
  const description = buildDescription(detail);
  const primary = detail.directions[0];
  const trainNumbers = detail.directions.map((d) => d.trainNumber).filter(Boolean);

  const trainTripLd = {
    "@context": "https://schema.org",
    "@type": "TrainTrip",
    name: detail.title,
    ...(primary?.trainNumber ? { trainNumber: primary.trainNumber } : {}),
    ...(detail.operators[0]
      ? { provider: { "@type": "Organization", name: detail.operators[0].name } }
      : {}),
    departureStation: { "@type": "TrainStation", name: detail.origin },
    arrivalStation: { "@type": "TrainStation", name: detail.destination },
    ...(primary?.departureTime ? { departureTime: primary.departureTime } : {}),
    ...(primary?.arrivalTime ? { arrivalTime: primary.arrivalTime } : {}),
    url: canonical,
  };

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={OG_IMAGE} />
      </Head>

      <SeoLayout>
        <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs
            items={[
              { name: "Home", href: "/" },
              { name: "Night trains", href: "/trains" },
              { name: detail.title },
            ]}
          />

          <header className="mt-6">
            <p className="text-sm text-primary-green">
              {detail.operators.map((o) => o.name).join(" · ")}
            </p>
            <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-white tracking-tight text-balance">
              {detail.origin} <span className="text-white/40">→</span> {detail.destination}
              {trainNumbers.length > 0 && (
                <span className="font-semibold text-white/50">
                  {" "}
                  ({trainNumbers.join(" / ")})
                </span>
              )}
            </h1>
            <p className="mt-4 text-white/70 leading-relaxed text-pretty">
              {buildIntro(detail)}
            </p>
          </header>

          <div className="mt-8">
            <RouteFactsGrid detail={detail} />
          </div>

          <div className="mt-8">
            <RouteMapIsland map={detail.map} agencyId={detail.agencyId} />
          </div>

          <div className="mt-10 space-y-6">
            <h2 className="text-xl font-semibold text-white">Timetable</h2>
            {detail.directions.map((dir, i) => (
              <RouteTimetable key={i} direction={dir} />
            ))}
          </div>

          {cityPair && (
            <div className="mt-10">
              <Link
                href={`/connections/${cityPair.slug}`}
                className="inline-flex items-center gap-2 text-primary-green hover:text-primary-green-light transition-colors"
              >
                Compare all night trains from {cityPair.originCity} to {cityPair.destCity}
                <FaArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          )}

          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-semibold text-sm transition-colors"
            >
              Open the interactive map
              <FaArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {related.length > 0 && (
            <section className="mt-14 border-t border-white/10 pt-10">
              <h2 className="text-xl font-semibold text-white">
                More {detail.operators[0]?.name || "night"} routes
              </h2>
              <div className="mt-5 grid sm:grid-cols-2 gap-3">
                {related.map((r) => (
                  <RouteCardLink key={r.routeId} route={r} />
                ))}
              </div>
            </section>
          )}
        </article>
      </SeoLayout>

      <JsonLd data={trainTripLd} />
    </>
  );
}

export async function getStaticPaths() {
  const { bySlug } = getRouteSlugMap();
  return {
    paths: [...bySlug.keys()].map((slug) => ({ params: { slug } })),
    fallback: false,
  };
}

export async function getStaticProps({ params }) {
  const { bySlug } = getRouteSlugMap();
  const routeId = bySlug.get(params.slug);
  if (!routeId) return { notFound: true };

  const detail = getRouteDetail(routeId);
  if (!detail) return { notFound: true };

  const summary = getAllRouteSummaries().find((s) => s.routeId === routeId);
  const related = summary ? getRelatedRoutes(summary, 6) : [];
  const pairSlug = summary ? getCityPairSlugForRoute(summary) : null;
  const cityPair = pairSlug
    ? { slug: pairSlug, originCity: summary.originCity, destCity: summary.destinationCity }
    : null;

  return { props: { detail, related, cityPair } };
}
