import Head from "next/head";
import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import RouteTimetable from "@components/seo/RouteTimetable";
import RouteFactsGrid from "@components/seo/RouteFactsGrid";
import RouteMapIsland from "@components/seo/RouteMapIsland";
import BookingCta from "@components/seo/BookingCta";
import FaqSection from "@components/seo/FaqSection";
import BookingGuide from "@components/BookingGuide";
import JsonLd from "@components/seo/JsonLd";

import {
  getAllCityPairs,
  getCityPair,
  getRelatedConnections,
} from "../../lib/seo/aggregate";
import { getRouteDetail } from "../../lib/seo/data";
import { cityForStation } from "../../lib/seo/cities.mjs";
import { connectionSnippet, snippetVariantFor } from "../../lib/seo/snippet.mjs";
import { punctualityAnswer } from "../../lib/punctuality.mjs";
import {
  formatTrainNumber,
  joinTrainNumbers,
  splitAgencyIds,
} from "../../lib/operatorAgencies.mjs";
import { buildConnectionFaq } from "../../lib/seo/routeFaq.mjs";
import {
  getBookingGuide,
  guideProps,
  withBookingGuideFaq,
} from "../../lib/bookingGuide.mjs";
import { getFlagEmoji } from "../../lib/countries";
import { getOperatorPricing, pricingAdvice } from "../../lib/operatorPricing";
import { offerFromPricing, offerLd } from "../../lib/seo/offers.mjs";
import { OG_IMAGE, absoluteUrl } from "../../lib/seo/site";

/**
 * The canonical route page type. One page per UNDIRECTED city pair carrying every
 * train on the corridor in both directions — this absorbed the retired
 * /trains/[slug] pages, so it must show everything they did: facts, map,
 * per-train timetables and a booking CTA.
 */
export default function ConnectionPage({
  slug,
  cityA,
  cityB,
  trains,
  operators,
  countries,
  related,
  title,
  description,
  intro,
  faq,
  bookingGuide,
}) {
  const canonical = absoluteUrl(`/connections/${slug}`);
  const operatorNames = operators.map((o) => o.name).join(", ");

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Night trains between ${cityA} and ${cityB}`,
    numberOfItems: trains.length,
    itemListElement: trains.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "TrainTrip",
        name: t.title,
        ...(t.primaryTrainNumber ? { trainNumber: t.primaryTrainNumber } : {}),
        ...(t.operators[0]
          ? { provider: { "@type": "Organization", name: t.operators[0].name } }
          : {}),
        departureStation: { "@type": "TrainStation", name: t.origin },
        arrivalStation: { "@type": "TrainStation", name: t.destination },
        ...(t.offer ? { offers: offerLd(t.offer) } : {}),
      },
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
        <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs
            items={[
              { name: "Home", href: "/" },
              { name: "Connections", href: "/connections" },
              { name: `${cityA} ↔ ${cityB}` },
            ]}
          />

          <header className="mt-6 max-w-3xl">
            <p className="text-sm text-primary-green">{operatorNames}</p>
            <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-white tracking-tight text-balance">
              Night Trains from {cityA} to {cityB}
            </h1>
            {/* `intro` and not `description`: on a page that renders the
                FACTS snippet the meta description leads with the train and its
                clock, which is a snippet and not an opening sentence. `intro`
                is the prose the page has always opened with, and on every other
                page the two are the same string. See src/lib/seo/snippet.mjs. */}
            <p className="mt-4 text-white/70 leading-relaxed text-pretty">
              {intro} Trains run in both directions — {cityA} to {cityB} and{" "}
              {cityB} to {cityA}.
            </p>
          </header>

          {(countries.length > 0 || operators.length > 0) && (
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

          {/* Corridor geometry comes from the first train that has any. */}
          {trains.find((t) => t.map) && (
            <div className="mt-8">
              <RouteMapIsland
                map={trains.find((t) => t.map).map}
                agencyId={trains.find((t) => t.map).agencyId}
              />
            </div>
          )}

          <section className="mt-10 space-y-12">
            <h2 className="text-xl font-semibold text-white">
              {trains.length} {trains.length === 1 ? "train" : "trains"} on this route
            </h2>

            {trains.map((t) => (
              <div key={t.routeId} className="border-t border-white/10 pt-8 first:border-0 first:pt-0">
                <h3 className="text-lg font-semibold text-white">
                  {t.origin} <span className="text-white/40">→</span> {t.destination}
                  {t.trainNumbers.length > 0 && (
                    <span className="font-semibold text-white/50">
                      {" "}
                      ({joinTrainNumbers(t.trainNumbers)})
                    </span>
                  )}
                </h3>

                <div className="mt-5">
                  <RouteFactsGrid detail={t} />
                </div>

                {t.booking && (
                  <div className="mt-6">
                    <BookingCta
                      booking={t.booking}
                      origin={t.origin}
                      destination={t.destination}
                      advice={t.advice}
                    />
                  </div>
                )}

                <div className="mt-6 space-y-5">
                  {t.directions.map((dir, i) => (
                    <RouteTimetable
                      key={i}
                      direction={dir}
                      bookingHref={t.booking?.href ?? null}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>

          {/* How buying a ticket works, where the operator's booking has quirks
              the Book button cannot explain (the Sunrise's one-month, 10:00 JST
              sale and its "1 adult" twin rooms). */}
          {bookingGuide && <BookingGuide guide={bookingGuide} className="mt-12" />}

          <div className="mt-10">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-white/15 text-white/90 hover:bg-white/5 hover:border-white/30 font-semibold text-sm transition-colors"
            >
              Open the interactive map
              <FaArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <FaqSection items={faq} />

          {related.length > 0 && (
            <section className="mt-14 border-t border-white/10 pt-10">
              <h2 className="text-xl font-semibold text-white">Related connections</h2>
              <div className="mt-5 grid sm:grid-cols-2 gap-2">
                {related.map((r) => (
                  <Link
                    key={r.slug}
                    href={`/connections/${r.slug}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-white/80 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    <span>
                      {r.cityA} <span className="text-white/40">↔</span> {r.cityB}
                    </span>
                    <span className="text-xs text-white/40">
                      {r.routeCount} {r.routeCount === 1 ? "train" : "trains"}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </article>
      </SeoLayout>

      <JsonLd data={itemListLd} />
      {faqLd && <JsonLd data={faqLd} />}
    </>
  );
}

/** [lat, lon] for a resolved stop, or null when it carries no coordinate. */
function stopPosition(stop) {
  const lat = Number(stop?.lat);
  const lon = Number(stop?.lon);
  return stop?.lat != null && stop?.lon != null && Number.isFinite(lat) && Number.isFinite(lon)
    ? [lat, lon]
    : null;
}

/**
 * The route's cheapest known fare as { lowPrice, currency }, or null.
 * Route-level price first, operator default second — getOperatorPricing()'s own
 * precedence, the same seam RouteFactsGrid renders the "From" tile through.
 */
function numericOffer(detail) {
  return offerFromPricing(
    getOperatorPricing({ agency_id: detail.agencyId, pricing: detail.pricing }),
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

  // Full per-train detail (timetable, stops, booking, geometry) — the content
  // that used to live on /trains/[slug].
  const trains = pair.routes
    .map((r) => getRouteDetail(r.routeId))
    .filter(Boolean)
    .map((d) => ({
      routeId: d.routeId,
      title: d.title,
      origin: d.origin,
      destination: d.destination,
      // Already labelled by buildSummary.
      primaryTrainNumber: d.primaryTrainNumber,
      // The directions keep the RAW number, because that is what the timetable
      // lookup matched on; label it here, where it is only rendered.
      trainNumbers: d.directions
        .map((x) => formatTrainNumber(x.trainNumber, d.agencyId))
        .filter(Boolean),
      agencyId: d.agencyId,
      operators: d.operators,
      pricing: d.pricing,
      booking: d.booking,
      countries: d.countries,
      countryCodes: d.countryCodes,
      // Numeric floor for the TrainTrip offers, resolved through the same seam
      // RouteFactsGrid renders the "From" tile with, so the markup and the
      // visible price can never disagree.
      offer: numericOffer(d),
      // Buy now or later — resolved here so the CTA, the facts tile and the FAQ
      // on this page all read the same pricingAdvice() record. The deals link
      // the CTA renders is the evidence for the last-minute caveat, so it is
      // taken from the SAME booking record rather than looked up again: the
      // advice and the link cannot then disagree about whether one exists.
      advice: pricingAdvice(
        getOperatorPricing({ agency_id: d.agencyId, pricing: d.pricing }),
        { hasLastMinuteDeals: Boolean(d.booking?.dealsUrl) },
      ),
      directions: d.directions.map((x) => ({
        ...x,
        trainNumber: formatTrainNumber(x.trainNumber, d.agencyId),
      })),
      facts: d.facts,
      // Only the first train with geometry renders a map; drop the rest so the
      // page payload doesn't carry a polyline per train.
      map:
        d.map && (d.map.polyline0 || d.map.polyline1 || d.map.stops.length >= 2)
          ? d.map
          : null,
    }));

  // Fastest journey + cheapest known "from" price across the pair's trains.
  const timed = pair.routes.filter((r) => r.durationMinutes > 0);
  const fastest = timed.length
    ? timed.reduce((a, b) => (a.durationMinutes <= b.durationMinutes ? a : b))
    : null;
  const priced = pair.routes.filter((r) => r.pricing && r.pricing.fromPrice != null);
  const cheapest = priced.length
    ? priced.reduce((a, b) => (a.pricing.fromPrice <= b.pricing.fromPrice ? a : b))
    : null;

  // Whether booking early helps is an answer we can give on every page even
  // with no figure, and the two models say opposite things. Taken from the
  // trains themselves so a corridor with one operator answers about that one;
  // a mixed corridor answers only when its operators agree.
  const pricingTypes = new Set(
    trains
      .map((t) => getOperatorPricing({ agency_id: t.agencyId, pricing: t.pricing })?.type)
      .filter(Boolean),
  );

  // A guide belongs to the corridor when any of its trains' operators has one.
  const guide =
    trains.map((t) => getBookingGuide({ agencyId: t.agencyId })).find(Boolean) ?? null;

  const faq = withBookingGuideFaq(buildConnectionFaq({
    originCity: pair.cityA,
    destCity: pair.cityB,
    trainCount: pair.routes.length,
    operators: pair.operators.map((o) => o.name),
    fastestDurationText: fastest?.durationText || "",
    // The answer is prose with room for the euro figure; the meta description
    // (the snippet below) keeps the bare fare to stay inside a snippet.
    fromPrice: cheapest?.fromPrice
      ? `${cheapest.fromPrice}${cheapest.fromPriceEur ? ` (${cheapest.fromPriceEur})` : ""}`
      : "",
    pricingType: pricingTypes.size === 1 ? [...pricingTypes][0] : "",
    hasLastMinuteDeals: trains.some((t) => t.booking?.dealsUrl),
    punctualityText: punctualityAnswer(
      trains.flatMap((t) =>
        t.directions.map((d) => ({ origin: d.origin, destination: d.destination, punctuality: d.punctualityRecord })),
      ),
    ),
  }), guide);
  // The raw record served the answer above; the timetable prints the summary.
  for (const t of trains) for (const d of t.directions) delete d.punctualityRecord;

  // Drop the map from all but the first train that has one.
  let mapUsed = false;
  for (const t of trains) {
    if (t.map && !mapUsed) mapUsed = true;
    else t.map = null;
  }

  // Every direction of every train on the corridor, flattened, so the snippet
  // builder can pick the one it describes. Cities as well as stations, because
  // the sentence has to name the places the title names — a page headed
  // "Vienna to Zurich" whose description leaves "Wien Hbf" reads as a
  // different page, and it is the city the searcher typed.
  const snippetDirections = trains.flatMap((t) =>
    t.directions.map((d) => ({
      trainLabel: d.trainNumber,
      operator: t.operators[0]?.name || "",
      origin: d.origin,
      destination: d.destination,
      originCity: cityForStation(d.origin),
      destinationCity: cityForStation(d.destination),
      departure: d.departureTime,
      arrival: d.arrivalTime,
      serviceDays: d.serviceDays,
      stopCount: d.stops.length,
      // The ground the journey covers, so a stated time that could not have
      // covered it is withheld rather than printed. A stop with no coordinate
      // yields no position and the check simply does not fire.
      originPos: stopPosition(d.stops[0]),
      destinationPos: stopPosition(d.stops[d.stops.length - 1]),
      durationText: t.facts.durationText,
      classes: t.facts.classes,
    })),
  );

  // The fact-bearing snippet renders only on the corridors snippetVariantFor()
  // names (European Sleeper's, to start); every other page keeps its wording
  // byte for byte.
  const snippet = connectionSnippet({
    cityA: pair.cityA,
    cityB: pair.cityB,
    // `trains`, not `pair.routes`: a route whose detail cannot be built is
    // dropped above and never rendered, and the description has to count
    // what the page actually shows.
    trainCount: trains.length,
    operatorNames: pair.operators.map((o) => o.name).join(", "),
    // Already formatted ("from €39") by buildSummary; the FAQ answer above
    // uses the same figure, so the snippet and the page cannot quote
    // different prices. It is only ever a real sampled fare — no price, no
    // sentence.
    fromPrice: cheapest?.fromPrice || "",
    directions: snippetDirections,
    variant: snippetVariantFor(trains.flatMap((t) => splitAgencyIds(t.agencyId))),
    // The build date: a timetable that has not started yet (the December
    // preview rows) is not the one the snippet describes.
    today: new Date().toISOString().slice(0, 10),
  });

  return {
    props: {
      slug: pair.slug,
      cityA: pair.cityA,
      cityB: pair.cityB,
      trains,
      operators: pair.operators,
      countries: pair.countries,
      related: getRelatedConnections(pair.slug, 8),
      title: snippet.title,
      description: snippet.description,
      // The page's visible opening paragraph, which on a FACTS page is
      // deliberately not the meta description.
      intro: snippet.intro,
      faq,
      bookingGuide: guideProps(guide),
    },
  };
}
