import { useCallback, useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import CityCombobox from "@components/plan/CityCombobox";
import DateField from "@components/plan/DateField";
import PlanItinerary from "@components/plan/PlanItinerary";
import RideCard from "@components/plan/RideCard";
import SharePlan from "@components/plan/SharePlan";

import { usePlanIndex } from "../../hooks/requests/usePlanIndex";
import {
  departuresFrom,
  findJourneys,
  resolvePlan,
  titleFromSlug,
} from "../../lib/plan/search.mjs";
import {
  buildPlanHref,
  decodeStays,
  isPlanDate,
  parsePlanPath,
} from "../../lib/plan/url.mjs";
import { formatPlanDate } from "../../lib/plan/format.mjs";
import { absoluteUrl, OG_IMAGE } from "../../lib/seo/site";
import { getFlagEmoji } from "../../lib/countries";

const TITLE = "Plan a Night Train Trip | Pingwi";
const DESCRIPTION =
  "Build a sleeper train journey across Europe night by night. Start from any city, see where a night train could take you, and share the plan as a link.";

/** Today as a calendar date in the viewer's own zone. */
function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

function cityLabel(planner, slug) {
  return planner?.cityBySlug.get(slug)?.name || titleFromSlug(slug);
}

export default function PlanPage({ seoCities, initialPlan }) {
  const router = useRouter();
  const { planner, error, isLoading } = usePlanIndex();

  // The date is the one piece of plan state that cannot come from the server:
  // "tonight" is a fact about the viewer's clock, and rendering it during SSR
  // would bake the build machine's date into the HTML.
  const [today, setToday] = useState("");
  useEffect(() => setToday(todayLocal()), []);

  const knownSlugs = useMemo(
    () => (planner ? new Set(planner.cities.map((c) => c.slug)) : undefined),
    [planner],
  );

  // The plan starts as whatever getStaticProps read off the path, NOT as
  // whatever router.query holds: on the first client render the router has not
  // populated its params yet, so reading it here renders a different tree than
  // the server sent and React throws the whole subtree away and re-renders it.
  // After mount the router is the source of truth, which is what makes shallow
  // navigation and the browser Back button work.
  const [parsed, setParsed] = useState(initialPlan);
  const [stays, setStays] = useState(initialPlan.stays);

  useEffect(() => {
    if (!router.isReady) return;
    const next = parsePlanPath(router.query.slug, knownSlugs);
    setParsed({ cities: next.cities, date: next.date });
    setStays(decodeStays(router.query.stay));
  }, [router.isReady, router.asPath, router.query.slug, router.query.stay, knownSlugs]);

  const cities = parsed.cities;
  const date = isPlanDate(parsed.date) ? parsed.date : today;
  const hasDate = Boolean(date);

  /** Every navigation goes through here, so the URL is always the whole plan. */
  const go = useCallback(
    (next, { replace = false } = {}) => {
      const href = buildPlanHref({
        cities: next.cities ?? cities,
        date: next.date ?? parsed.date ?? (today || null),
        stays: next.stays ?? stays,
      });
      const method = replace ? router.replace : router.push;
      method.call(router, href, undefined, { shallow: true, scroll: false });
    },
    [router, cities, parsed.date, stays, today],
  );

  const plan = useMemo(() => {
    if (!planner || cities.length < 2 || !hasDate) return null;
    return resolvePlan(planner, { cities, date, stays });
  }, [planner, cities, date, stays, hasDate]);

  const explore = useMemo(() => {
    if (!planner || cities.length !== 1 || !hasDate) return null;
    return departuresFrom(planner, { from: cities[0], date });
  }, [planner, cities, date, hasDate]);

  // Mode 2 with no direct train: the honest answer is a chain of nights, so
  // offer the chains rather than an empty result.
  const journeys = useMemo(() => {
    if (!planner || !plan || cities.length !== 2 || plan.complete || !hasDate) return [];
    return findJourneys(planner, { from: cities[0], to: cities[1], date, maxLegs: 3, limit: 6 });
  }, [planner, plan, cities, date, hasDate]);

  const originCity = planner?.cityBySlug.get(cities[0]) || null;
  const lastCity = cities.length ? cities[cities.length - 1] : "";
  const canonicalPath = buildPlanHref({ cities, date: parsed.date, stays });
  // /plan is a landing page worth indexing. Every parameterised plan under it is
  // one of an unbounded number of URLs that differ only by a date, which is a
  // crawl trap, and its content already lives on the /connections pages it
  // links to. So exactly one URL in this space is indexable.
  const isLanding = cities.length === 0 && !parsed.date;
  const heading = headingFor(planner, cities, parsed.date);

  return (
    <SeoLayout>
      <Head>
        <title>{isLanding ? TITLE : `${heading.plain} | Pingwi`}</title>
        <meta name="description" content={DESCRIPTION} />
        {isLanding ? (
          <link rel="canonical" href={absoluteUrl("/plan")} />
        ) : (
          <>
            <meta name="robots" content="noindex, follow" />
            <link rel="canonical" href={absoluteUrl("/plan")} />
          </>
        )}
        <meta property="og:title" content={isLanding ? TITLE : heading.plain} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:url" content={absoluteUrl(canonicalPath)} />
        <meta name="twitter:card" content="summary_large_image" />
      </Head>

      <div className="mx-auto max-w-4xl px-4 pb-24 pt-24 sm:px-6 lg:px-8">
        <Breadcrumbs
          items={[
            { name: "Home", href: "/" },
            { name: "Plan a trip", href: "/plan" },
          ]}
        />

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-green">
            Night train planner
          </p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight text-white sm:text-5xl">
            {heading.rich}
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-white/60">
            {cities.length === 0
              ? "Pick where you are. We'll show you every city a sleeper could reach that night — then keep going, one night at a time."
              : "Add a city to extend the trip. The link in your address bar is the whole plan: copy it to keep it or send it to someone."}
          </p>
        </header>

        <section
          aria-label="Trip"
          className="mt-8 grid gap-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:grid-cols-2"
        >
          <CityCombobox
            label="From"
            value={originCity || (cities[0] ? { name: titleFromSlug(cities[0]) } : null)}
            cities={planner?.cities ?? []}
            disabled={isLoading}
            onSelect={(city) => go({ cities: city ? [city.slug, ...cities.slice(1)] : [] })}
          />
          {cities.length >= 1 && (
            <CityCombobox
              // Always empty and always APPENDING. An earlier version bound this
              // to cities[1] while labelling it with the last city of the chain,
              // so on a four-city plan it said "after Vienna" and edited Berlin.
              // Cities already in the plan are removed from the itinerary below,
              // which is where they are visible.
              label={cities.length === 1 ? "To (optional)" : `Then on to (after ${cityLabel(planner, lastCity)})`}
              value={null}
              cities={planner?.cities ?? []}
              disabled={isLoading}
              placeholder={
                cities.length === 1
                  ? "Leave empty to see everywhere you could go"
                  : "Add another night"
              }
              onSelect={(city) => city && go({ cities: [...cities, city.slug] })}
            />
          )}
          <div className={cities.length >= 1 ? "sm:col-span-2" : ""}>
            {today && (
              <DateField
                value={date}
                today={today}
                onChange={(value) => go({ date: value }, { replace: true })}
              />
            )}
          </div>
        </section>

        {error && (
          <p className="mt-8 rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-rose-200">
            {error}
          </p>
        )}

        {isLoading && cities.length > 0 && (
          <p className="mt-10 text-white/45" role="status">
            Loading the night train network…
          </p>
        )}

        {/* ── Landing: nothing chosen yet ─────────────────────────────── */}
        {cities.length === 0 && (
          <section className="mt-12" aria-labelledby="popular-starts">
            <h2 id="popular-starts" className="text-xl font-semibold text-white">
              Start from a city with the most night trains
            </h2>
            <ul className="mt-5 flex flex-wrap gap-2">
              {(planner?.cities ?? seoCities)
                .filter((c) => (c.terminusCount ?? 0) > 0)
                .slice()
                .sort((a, b) => (b.legCount ?? 0) - (a.legCount ?? 0))
                .slice(0, 24)
                .map((city) => (
                  <li key={city.slug}>
                    <Link
                      href={buildPlanHref({ cities: [city.slug] })}
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 transition-colors hover:border-primary-green/50 hover:text-white"
                    >
                      <span aria-hidden="true">{getFlagEmoji(city.country) || "🚂"}</span>
                      {city.name}
                      <span className="text-xs text-white/35">{city.legCount}</span>
                    </Link>
                  </li>
                ))}
            </ul>
            <p className="mt-8 text-sm text-white/40">
              Prefer to browse?{" "}
              <Link href="/connections" className="underline underline-offset-4 hover:text-white">
                Every night train connection
              </Link>{" "}
              ·{" "}
              <Link href="/" className="underline underline-offset-4 hover:text-white">
                See them on the map
              </Link>
            </p>
          </section>
        )}

        {/* ── Mode 1: where could I go from here ──────────────────────── */}
        {explore && (
          <section className="mt-12" aria-labelledby="explore-title" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="explore-title" className="text-xl font-semibold text-white">
                {explore.destinations.length > 0
                  ? `${explore.destinations.length} places you could wake up in`
                  : "No night trains we know of"}
              </h2>
              <p className="text-sm text-white/40">{formatPlanDate(date)}</p>
            </div>

            {explore.destinations.length === 0 ? (
              <EmptyExplore city={cityLabel(planner, cities[0])} date={date} />
            ) : (
              <div className="mt-5 grid gap-3">
                {explore.destinations.map(({ city, best, rides }) => (
                  <RideCard
                    key={city.slug}
                    ride={best}
                    action={
                      <Link
                        href={buildPlanHref({ cities: [...cities, city.slug], date: parsed.date, stays })}
                        className="rounded-full bg-primary-green px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-primary-green-light"
                      >
                        {rides.length > 1 ? `Go here (${rides.length} trains)` : "Go here"}
                      </Link>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── Modes 2 & 3: a plan with two or more cities ─────────────── */}
        {plan && (
          <section className="mt-12" aria-labelledby="plan-title" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="plan-title" className="text-xl font-semibold text-white">
                Your trip · {plan.nights} {plan.nights === 1 ? "night" : "nights"}
                {plan.sleeperNights < plan.hops.length && (
                  <span className="ml-2 text-sm font-normal text-white/40">
                    {plan.sleeperNights} on a sleeper
                  </span>
                )}
              </h2>
              <p className="text-sm text-white/40">
                {formatPlanDate(date)} → {formatPlanDate(plan.endDate)}
              </p>
            </div>

            <div className="mt-6">
              <PlanItinerary
                plan={plan}
                stays={stays}
                onStayChange={(hopIndex, nights) => {
                  const next = [...stays];
                  while (next.length <= hopIndex) next.push(0);
                  next[hopIndex] = nights;
                  go({ stays: next }, { replace: true });
                }}
                onRemoveCity={(cityIndex) =>
                  go({ cities: cities.filter((_, i) => i !== cityIndex) })
                }
              />
            </div>

            {/* A two-city plan with no direct train and no chain either. Saying
                nothing reads as a page that failed to load; the search really
                did run and really did come back empty. */}
            {cities.length === 2 && !plan.complete && journeys.length === 0 && !isLoading && (
              <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                <p className="text-white/70">
                  We couldn&apos;t chain night trains from {cityLabel(planner, cities[0])} to{" "}
                  {cityLabel(planner, cities[1])} within three nights either.
                </p>
                <p className="mt-2 text-sm text-white/45">
                  Sleeper networks don&apos;t cover every corridor — a day train for part of
                  the way is often the answer. Try a nearer destination, or{" "}
                  <Link
                    href={buildPlanHref({ cities: [cities[0]], date: parsed.date })}
                    className="underline underline-offset-4 hover:text-white"
                  >
                    see where {cityLabel(planner, cities[0])}&apos;s night trains do reach
                  </Link>
                  .
                </p>
              </div>
            )}

            {journeys.length > 0 && (
              <div className="mt-10">
                <h3 className="text-lg font-semibold text-white">
                  Ways to get there by sleeper
                </h3>
                <p className="mt-1 text-sm text-white/45">
                  No single night train covers this. These chains do — each hop is one
                  night on a train.
                </p>
                <ul className="mt-4 grid gap-3">
                  {journeys.map((journey) => (
                    <li key={journey.cities.join(">")}>
                      <Link
                        href={buildPlanHref({ cities: journey.cities, date: parsed.date })}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-primary-green/40"
                      >
                        <span className="text-white">
                          {journey.cities.map((slug) => cityLabel(planner, slug)).join(" → ")}
                        </span>
                        <span className="text-sm text-white/45">
                          {journey.nights} {journey.nights === 1 ? "night" : "nights"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6">
              <SharePlan href={canonicalPath} />
              <Link
                href={buildPlanHref({ cities: [lastCity], date: plan.endDate })}
                className="text-sm text-primary-green underline-offset-4 hover:underline"
              >
                Where could you go from {cityLabel(planner, lastCity)} next? →
              </Link>
            </div>
          </section>
        )}

        <DataHonesty />
      </div>
    </SeoLayout>
  );
}

/** The heading, which has to work before the index has loaded. */
function headingFor(planner, cities, date) {
  if (cities.length === 0) return { plain: "Where could you go tonight?", rich: "Where could you go tonight?" };
  const names = cities.map((slug) => cityLabel(planner, slug));
  if (cities.length === 1) {
    const when = date ? ` on ${formatPlanDate(date)}` : " tonight";
    return {
      plain: `Night trains from ${names[0]}`,
      rich: (
        <>
          Where could you go from <span className="text-primary-green">{names[0]}</span>
          {when}?
        </>
      ),
    };
  }
  return {
    plain: `${names.join(" → ")} by night train`,
    rich: (
      <>
        {names.slice(0, -1).map((name) => (
          <span key={name}>
            {name} <span className="text-white/25">→</span>{" "}
          </span>
        ))}
        <span className="text-primary-green">{names[names.length - 1]}</span>
      </>
    ),
  };
}

function EmptyExplore({ city, date }) {
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6">
      <p className="text-white/70">
        We have no sleeper leaving {city} on {formatPlanDate(date)}.
      </p>
      <p className="mt-2 text-sm text-white/45">
        Try another night — many routes run only two or three times a week — or{" "}
        <Link href="/connections" className="underline underline-offset-4 hover:text-white">
          browse every connection
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * What the planner knows, said on the page rather than only in the code.
 *
 * A third of the legs in the dataset carry no operating days, so a traveller
 * will meet "days unconfirmed" and deserves to know what it means before they
 * book a flight around it.
 */
function DataHonesty() {
  return (
    <section className="mt-16 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <h2 className="text-base font-semibold text-white">What these results are based on</h2>
      <ul className="mt-3 flex flex-col gap-2 text-sm leading-relaxed text-white/50">
        <li>
          <strong className="font-medium text-primary-green">Runs this night</strong> — the
          operator publishes the weekdays this train runs, and your date is one of them.
        </li>
        <li>
          <strong className="font-medium text-amber-300">Days unconfirmed</strong> — we have the
          route but not its operating days, or the operator states only a frequency such as
          “every 2nd day”. Check with them before you commit.
        </li>
        <li>
          Times come from operator feeds where we have them and from the route's endpoints
          otherwise, so an intermediate stop may show no time at all rather than a guessed one.
        </li>
        <li>
          We don't yet carry live availability or fares. Each train links to its connection page
          for timetables and where to book.
        </li>
      </ul>
    </section>
  );
}

/**
 * Only the landing page is pre-rendered with data. Every plan under it is
 * client-rendered from the static index, which is what keeps an unbounded URL
 * space (every city pair × every date) from becoming an unbounded number of
 * cached server renders.
 */
export async function getStaticPaths() {
  return { paths: [{ params: { slug: [] } }], fallback: "blocking" };
}

export async function getStaticProps({ params }) {
  const { getPlanIndex, getTopStartCities } = await import("../../lib/plan/published.mjs");
  const index = getPlanIndex();
  const knownSlugs = index ? new Set(index.cities.map((c) => c.slug)) : undefined;
  const { cities, date } = parsePlanPath(params?.slug, knownSlugs);

  return {
    props: {
      seoCities: getTopStartCities(24),
      // Parsed with the same function the client uses, so the two can never
      // read one URL as two different plans.
      initialPlan: { cities, date, stays: [] },
    },
    revalidate: 86400,
  };
}
