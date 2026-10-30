import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Link from "../../components/Link";
import { useRouter } from "next/router";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import CheapestNights from "@components/plan/CheapestNights";
import CityCombobox from "@components/plan/CityCombobox";
import DateField from "@components/plan/DateField";
import JourneyOptions, { FareSum } from "@components/plan/JourneyOptions";
import PlanItinerary from "@components/plan/PlanItinerary";
import RideCard from "@components/plan/RideCard";
import SharePlan from "@components/plan/SharePlan";

import { usePlanIndex } from "../../hooks/requests/usePlanIndex";
import {
  departuresFrom,
  directDestinations,
  findJourneys,
  nextServedNight,
  resolvePlan,
  spliceJourney,
  titleFromSlug,
} from "../../lib/plan/search.mjs";
import {
  buildPlanHref,
  decodeStays,
  isPlanDate,
  isPlanMonth,
  monthOf,
  parsePlanPath,
  planPartsFromPath,
} from "../../lib/plan/url.mjs";
import { formatPlanDate, formatPlanMonth } from "../../lib/plan/format.mjs";
import {
  cheapestDestinationsFirst,
  cheapestOnNight,
  departuresAnyNight,
  flexibleNights,
  summarizeNights,
} from "../../lib/plan/flexible.mjs";
import { byStartCityScore, prominenceLookup } from "../../lib/plan/prominence.mjs";
import {
  DEFAULT_REGION,
  REGIONS,
  START_CITY_LIMIT,
  topStartCitiesByRegion,
} from "../../lib/plan/regions.mjs";
import CITY_PROMINENCE from "../../../data/overrides/city-prominence.json";
import { absoluteUrl, OG_IMAGE } from "../../lib/seo/site";
import { getFlagEmoji } from "../../lib/countries";

// Only a weight scoped "always" survives into a region tab — a continent does
// not need damping once it has a tab of its own. See city-prominence.json.
const START_CITY_ORDER = byStartCityScore(prominenceLookup(CITY_PROMINENCE, "always"));

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

  // Which part of the world the "start from" chips offer. The dataset is three
  // products in one table — European sleepers, China Railway, Amtrak/VIA — and
  // ranked together neither wins: Beijing has more night trains than Vienna and
  // nobody shopping for one is shopping for the other.
  const [region, setRegion] = useState(DEFAULT_REGION);
  // seoCities already carries every region's top, so a tab switched before the
  // index lands is a full list rather than an empty one.
  const startCitiesByRegion = useMemo(
    () =>
      topStartCitiesByRegion(planner?.cities ?? seoCities, {
        limit: START_CITY_LIMIT,
        compare: START_CITY_ORDER,
      }),
    [planner, seoCities],
  );
  const regionTabs = useMemo(
    () => REGIONS.filter((r) => (startCitiesByRegion.get(r.id) ?? []).length > 0),
    [startCitiesByRegion],
  );
  const startCities = startCitiesByRegion.get(region) ?? [];

  // Arrow keys move between tabs, which is what makes a tablist a tablist.
  const onRegionKeyDown = useCallback(
    (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const at = regionTabs.findIndex((r) => r.id === region);
      const next = regionTabs[(at + step + regionTabs.length) % regionTabs.length];
      if (!next) return;
      setRegion(next.id);
      document.getElementById(`region-tab-${next.id}`)?.focus();
    },
    [region, regionTabs],
  );

  // The plan starts empty, exactly as the static HTML was rendered: every
  // /plan/* URL is the one prebuilt /plan page served through a rewrite, so the
  // server never knows which plan was asked for. Reading the URL during the
  // first client render would produce a different tree than the server sent
  // and React would throw the whole subtree away. After mount the URL is the
  // source of truth, which is what makes shallow navigation and the browser
  // Back button work.
  const [parsed, setParsed] = useState(initialPlan);
  const [stays, setStays] = useState(initialPlan.stays);

  useEffect(() => {
    if (!router.isReady) return;
    const { slug, stay } = planPartsFromPath(router.asPath);
    const next = parsePlanPath(slug, knownSlugs);
    setParsed({ cities: next.cities, date: next.date, month: next.month });
    setStays(decodeStays(stay));
  }, [router.isReady, router.asPath, knownSlugs]);

  const cities = parsed.cities;
  // No night in the URL is "any time": the planner tries every night and shows
  // the cheapest. A month narrows that to its nights.
  const date = isPlanDate(parsed.date) ? parsed.date : null;
  const month = !date && isPlanMonth(parsed.month) ? parsed.month : null;
  const hasDate = Boolean(date);

  /** Every navigation goes through here, so the URL is always the whole plan. */
  const go = useCallback(
    (next, { replace = false } = {}) => {
      // A night and a month are one choice: setting either replaces both.
      const when = "date" in next || "month" in next;
      const href = buildPlanHref({
        cities: next.cities ?? cities,
        date: when ? next.date ?? null : parsed.date,
        month: when ? next.month ?? null : parsed.month,
        stays: next.stays ?? stays,
      });
      const method = replace ? router.replace : router.push;
      method.call(router, href, undefined, { shallow: true, scroll: false });
    },
    [router, cities, parsed.date, parsed.month, stays],
  );

  // Where to bring the reader after a change they made. On a phone the form
  // and the heading fill the first screen, so a result rendered below them is a
  // result nobody sees: picking a destination used to leave the screen looking
  // exactly as it did before the tap, and read as the choice being reset. Set
  // by the handler, consumed by the effect below once the result has rendered.
  const scrollTarget = useRef(null);
  // A plan of two or more cities shows the trip as a one-line summary rather
  // than the whole form, so the result sits right under it.
  const [editing, setEditing] = useState(false);
  const [addingCity, setAddingCity] = useState(false);

  /** A change made in the form: show its result, not the form again. */
  const commit = useCallback(
    (next, options) => {
      setEditing(false);
      setAddingCity(false);
      scrollTarget.current = "plan-results";
      go(next, options);
    },
    [go],
  );

  const plan = useMemo(() => {
    if (!planner || cities.length < 2 || !hasDate) return null;
    return resolvePlan(planner, { cities, date, stays });
  }, [planner, cities, date, stays, hasDate]);

  // The nights an undated trip is tried on: the next three months, or a month.
  const flexNights = useMemo(
    () => (hasDate || !today ? [] : flexibleNights({ today, month })),
    [hasDate, today, month],
  );

  const explore = useMemo(() => {
    if (!planner || cities.length !== 1) return null;
    // Cheapest first, on a night or any time: a traveller who has not picked
    // a destination is often picking by what it costs.
    if (hasDate) {
      const found = departuresFrom(planner, { from: cities[0], date });
      return { ...found, destinations: cheapestDestinationsFirst(found.destinations) };
    }
    if (!flexNights.length) return null;
    return {
      destinations: cheapestDestinationsFirst(
        departuresAnyNight(planner, { from: cities[0], nights: flexNights }),
      ),
    };
  }, [planner, cities, date, hasDate, flexNights]);

  // A trip with no night: every night tried, a few at a time so a phone stays
  // responsive while three months of journeys are searched.
  const flexible = useCheapestNights(planner, cities, stays, flexNights);
  const flexibleSummary = useMemo(() => summarizeNights(flexible.results), [flexible.results]);

  // Mode 2: two cities. With no direct train that night the honest answer is a
  // change somewhere on the way, so offer those rather than an empty result —
  // and when nothing at all connects on the chosen night, the ones that leave
  // in the following week. With a direct train, only a change that gets there
  // sooner is worth a mention, and the search already drops the rest.
  const journeys = useMemo(() => {
    const none = { list: [], later: false };
    if (!planner || !plan || cities.length !== 2 || !hasDate) return none;
    const query = { from: cities[0], to: cities[1], date, maxLegs: 3, limit: 6 };
    const tonight = findJourneys(planner, query).filter(
      (j) => !plan.complete || j.hops.length > 1,
    );
    if (tonight.length || plan.complete) return { list: tonight, later: false };
    return { list: findJourneys(planner, { ...query, flexNights: 6 }), later: true };
  }, [planner, plan, cities, date, hasDate]);

  // Mode 3: a longer plan with a hop no train serves. The same search fills
  // the gap, starting after the train you arrive on.
  const hopJourneys = useMemo(() => {
    if (!planner || !plan || cities.length < 3) return [];
    return plan.hops.map((hop) => {
      if (hop.served) return [];
      const query = {
        from: hop.from.slug,
        to: hop.to.slug,
        date: hop.date,
        after: hop.after,
        maxLegs: 3,
        limit: 3,
      };
      const found = findJourneys(planner, query).filter((j) => j.hops.length > 1);
      return found.length ? found : findJourneys(planner, { ...query, flexNights: 6 });
    });
  }, [planner, plan, cities]);

  // The way out of "not this night", per hop: the next night a train runs —
  // and leaves after the previous one gets in.
  const nextNights = useMemo(() => {
    if (!planner || !plan) return [];
    return plan.hops.map((hop) =>
      !hop.served && hop.rides.length > 0
        ? nextServedNight(planner, {
            from: hop.from.slug,
            to: hop.to.slug,
            date: hop.date,
            after: hop.after,
          })
        : null,
    );
  }, [planner, plan]);

  // No train runs straight through at all, but a change does: the answer is
  // the change, so the plan shows only that. An empty "no night train" hop
  // above it was the loudest thing on the page and said the opposite.
  const changeOnly =
    cities.length === 2 && Boolean(plan) && !plan.hops[0]?.best && journeys.list.length > 0;

  /** The plan with a found journey in place of one of its hops. */
  const hrefForJourney = useCallback(
    (hop, journey) =>
      buildPlanHref(spliceJourney({ cities, date, stays }, hop.index, journey, hop.date)),
    [cities, date, stays],
  );
  const bringToPlan = useCallback(() => {
    scrollTarget.current = "plan-results";
  }, []);

  useEffect(() => {
    const id = scrollTarget.current;
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    scrollTarget.current = null;
    // Only when it is not already where the eye is — a desktop that shows the
    // result beside the form should not jump.
    const { top } = target.getBoundingClientRect();
    if (top < 80 || top > window.innerHeight * 0.6) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [plan, explore, flexible.done]);

  const originCity = planner?.cityBySlug.get(cities[0]) || null;
  const lastCity = cities.length ? cities[cities.length - 1] : "";
  const lastCityRecord = planner?.cityBySlug.get(lastCity) || null;

  // Where a train goes straight from the city a hop leaves: those come first
  // in "To" and say "direct"; the rest say nothing, since reaching them takes
  // a change. A train count beside a destination answered a question about
  // the destination rather than about getting there.
  const toOrigin = cities.length >= 2 ? cities[cities.length - 2] : cities[0];
  const directFromToOrigin = useMemo(
    () => directDestinations(planner, toOrigin),
    [planner, toOrigin],
  );
  const directFromLast = useMemo(
    () => directDestinations(planner, lastCity),
    [planner, lastCity],
  );
  const describeFrom = useCallback(
    (direct) => (city) => (direct.has(city.slug) ? "direct" : ""),
    [],
  );
  const isPlan = cities.length >= 2;
  const canonicalPath = buildPlanHref({ cities, date, month, stays });
  // /plan is a landing page worth indexing. Every parameterised plan under it is
  // one of an unbounded number of URLs that differ only by a date, which is a
  // crawl trap, and its content already lives on the /connections pages it
  // links to. So exactly one URL in this space is indexable.
  const isLanding = cities.length === 0 && !parsed.date && !parsed.month;
  const heading = headingFor(planner, cities, { date, month, today });

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
          <h1 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-5xl">
            {heading.rich}
          </h1>
          {/* Once there is something to show, the screen belongs to it: on a
              phone this paragraph alone is a third of the first screen. */}
          {cities.length === 0 ? (
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-white/60">
              Pick where you are and where you want to go. We&apos;ll find the night train —
              or, if you don&apos;t know yet, every city a sleeper could reach that night.
            </p>
          ) : (
            !isPlan && (
              <p className="mt-4 hidden max-w-2xl text-lg leading-relaxed text-white/60 sm:block">
                Pick a destination, or leave it empty to see every city a sleeper could reach
                that night.
              </p>
            )
          )}
        </header>

        {isPlan && !editing ? (
          <TripSummary
            names={cities.map((slug) => cityLabel(planner, slug))}
            when={
              date
                ? formatPlanDate(date)
                : month
                  ? formatPlanMonth(month, { today })
                  : "Any time"
            }
            onEdit={() => setEditing(true)}
          />
        ) : (
          <section
            aria-label="Trip"
            className="mt-8 grid gap-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:grid-cols-2"
          >
            <CityCombobox
              label="From"
              value={originCity || (cities[0] ? { name: titleFromSlug(cities[0]) } : null)}
              // Not the city the first train goes to: a trip from Vienna to
              // Vienna is not one, and offering it reads as the picker not
              // knowing what was already chosen.
              cities={(planner?.cities ?? []).filter((c) => c.slug !== cities[1])}
              disabled={isLoading}
              onSelect={(city) => {
                if (!city) return go({ cities: [] });
                const next = [city.slug, ...cities.slice(1)];
                return next.length >= 2 ? commit({ cities: next }) : go({ cities: next });
              }}
            />
            {cities.length >= 1 && (
              <CityCombobox
                // With one city this APPENDS the destination. With two or more
                // it shows — and replaces — the LAST city, which is what "To"
                // means; the stops in between are edited in the itinerary. An
                // earlier version bound it to cities[1] while labelling it with
                // the last city, so on a four-city plan it said "after Vienna"
                // and edited Berlin; and before this one it was always empty,
                // so the city just picked vanished from the field and the plan
                // looked reset.
                label={isPlan ? "To" : "To (optional)"}
                value={
                  isPlan
                    ? lastCityRecord || { name: titleFromSlug(lastCity) }
                    : null
                }
                // Not the city this hop leaves from — "From" when there are two.
                // Picking it used to be silently ignored, so the list offered a
                // choice that did nothing.
                cities={(planner?.cities ?? []).filter((c) => c.slug !== toOrigin)}
                preferred={directFromToOrigin}
                describe={describeFrom(directFromToOrigin)}
                disabled={isLoading}
                placeholder={isPlan ? "City or station" : "Leave empty to see everywhere you could go"}
                onSelect={(city) => {
                  if (!city) {
                    // Clearing "To" drops the final city, never the start.
                    return isPlan ? go({ cities: cities.slice(0, -1) }) : undefined;
                  }
                  const base = isPlan ? cities.slice(0, -1) : cities;
                  if (base[base.length - 1] === city.slug) return undefined;
                  return commit({ cities: [...base, city.slug] });
                }}
              />
            )}
            <div className={`min-w-0 ${cities.length >= 1 ? "sm:col-span-2" : ""}`}>
              {today && (
                <DateField
                  date={date}
                  month={month}
                  today={today}
                  onChange={(when) =>
                    isPlan ? commit(when, { replace: true }) : go(when, { replace: true })
                  }
                />
              )}
            </div>
            {isPlan && (
              <div className="flex justify-end sm:col-span-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-full border border-white/15 px-4 py-1.5 text-sm text-white/70 transition-colors hover:border-white/30 hover:text-white"
                >
                  Done
                </button>
              </div>
            )}
            {/* One city, no destination: the list is below the fold on a phone,
                and nothing on the first screen says it is there. */}
            {explore && explore.destinations.length > 0 && (
              <a
                href="#explore-results"
                className="text-sm text-primary-green underline-offset-4 hover:underline sm:hidden"
              >
                See {explore.destinations.length} places you could wake up in ↓
              </a>
            )}
          </section>
        )}

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

            {regionTabs.length > 1 && (
              <div
                role="tablist"
                aria-label="Part of the world"
                onKeyDown={onRegionKeyDown}
                className="mt-4 inline-flex flex-wrap gap-1 rounded-full border border-white/10 bg-white/[0.02] p-1"
              >
                {regionTabs.map((tab) => {
                  const selected = tab.id === region;
                  return (
                    <button
                      key={tab.id}
                      id={`region-tab-${tab.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="start-city-chips"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setRegion(tab.id)}
                      className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                        selected
                          ? "bg-primary-green/15 text-white"
                          : "text-white/50 hover:text-white"
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            )}

            <ul
              id="start-city-chips"
              role="tabpanel"
              aria-labelledby={`region-tab-${region}`}
              className="mt-5 flex flex-wrap gap-2"
            >
              {/* Same list, same order as getTopStartCities, which renders this
                  before the index has loaded — sorting it differently here
                  would make the chips visibly reshuffle on hydration. */}
              {startCities.map((city) => (
                <li key={city.slug}>
                  <Link
                    href={buildPlanHref({ cities: [city.slug] })}
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm text-white/70 transition-colors hover:border-primary-green/50 hover:text-white"
                  >
                    <span aria-hidden="true">{getFlagEmoji(city.country) || "🚂"}</span>
                    {city.name}
                    {/* Night TRAINS serving the city, which is what the heading
                        promises AND what the list is sorted by — ranking on one
                        number while printing another is what made this read as
                        alphabetical. */}
                    <span className="text-xs text-white/35">{city.routeCount}</span>
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
          <section
            id="explore-results"
            className="mt-12 scroll-mt-24"
            aria-labelledby="explore-title"
            aria-live="polite"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="explore-title" className="text-xl font-semibold text-white">
                {explore.destinations.length > 0
                  ? `${explore.destinations.length} places you could wake up in`
                  : "No night trains we know of"}
              </h2>
              <p className="text-sm text-white/40">
                {date ? formatPlanDate(date) : month ? formatPlanMonth(month, { today }) : "Any night, next 3 months"}
                {explore.destinations.length > 1 && " · cheapest first"}
              </p>
            </div>

            {explore.destinations.length === 0 ? (
              <EmptyExplore city={cityLabel(planner, cities[0])} date={date} month={month} today={today} />
            ) : (
              // grid-cols-1, not a bare `grid`: an implicit column is sized
              // `auto`, which floors the track at the item's min-content, and a
              // grid item defaults to min-width:auto and so cannot shrink below
              // it. The ride cards measured 440px wide inside a 288px container
              // — the date field's fault one level up. Tailwind's grid-cols-1 is
              // `repeat(1, minmax(0, 1fr))`, and that minmax(0, …) is the fix.
              <div className="mt-5 grid grid-cols-1 gap-3">
                {explore.destinations.map(({ city, best, rides, date: night }) => (
                  <RideCard
                    key={city.slug}
                    ride={best}
                    // Any time: the card shows the destination's cheapest
                    // night (or its first, with no price per night), so it
                    // says which night that is.
                    nightLabel={
                      night
                        ? `${best.pricing?.travelDate === night ? "Cheapest" : "Next"}: ${formatPlanDate(night)}`
                        : ""
                    }
                    action={
                      <Link
                        // The same "when" as here: any time stays any time,
                        // and the trip page then finds its cheapest night.
                        href={buildPlanHref({ cities: [...cities, city.slug], date, month, stays })}
                        // The link is far down the list; the plan it opens
                        // renders at the top. Bring the reader to it.
                        onClick={() => {
                          scrollTarget.current = "plan-results";
                        }}
                        className="rounded-full bg-primary-green px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-primary-green-light"
                      >
                        {rides?.length > 1 ? `Go here (${rides.length} trains)` : "Go here"}
                      </Link>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── A trip with no night: its cheapest nights ───────────────── */}
        {isPlan && !hasDate && planner && today && (
          <section
            id="plan-results"
            className="mt-8 scroll-mt-24"
            aria-labelledby="plan-title"
            aria-live="polite"
          >
            <CheapestNights
              results={flexible.results}
              summary={flexibleSummary}
              month={month}
              today={today}
              pending={!flexible.done}
              onPickMonth={(m) => commit({ date: null, month: m }, { replace: true })}
              onChoose={bringToPlan}
            />
            <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6">
              <SharePlan href={canonicalPath} />
            </div>
          </section>
        )}

        {/* ── Modes 2 & 3: a plan with two or more cities ─────────────── */}
        {plan && (
          <section
            id="plan-results"
            className="mt-8 scroll-mt-24"
            aria-labelledby="plan-title"
            aria-live="polite"
          >
            {changeOnly ? (
              <div>
                <h2 id="plan-title" className="text-xl font-semibold text-white">
                  With a change of train
                </h2>
                <p className="mt-1 text-sm text-white/45">
                  {journeys.later
                    ? `No sleeper runs straight through, and nothing connects on ${formatPlanDate(date)}. These are the first ways after it.`
                    : "No sleeper runs straight through. Pick a route — each change is checked against both trains' times."}
                </p>
                <div className="mt-4">
                  <JourneyOptions
                    journeys={journeys.list}
                    hrefFor={(journey) => hrefForJourney(plan.hops[0], journey)}
                    onChoose={bringToPlan}
                  />
                </div>
              </div>
            ) : (
            <>
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
            <button
              type="button"
              onClick={() => commit({ date: null, month: monthOf(date) }, { replace: true })}
              className="mt-1 text-sm text-primary-green underline-offset-4 hover:underline"
            >
              Cheapest nights in {formatPlanMonth(monthOf(date), { today })} →
            </button>
            {/* What the whole trip costs, when it has more than one train —
                the same sum the change options showed before it was picked. */}
            {plan.hops.length > 1 && (
              <FareSum rides={plan.hops.map((hop) => hop.best)} className="mt-2" />
            )}

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
                nextNights={nextNights}
                onTryNight={(hop, next) => {
                  if (hop.index === 0) return go({ date: next.date }, { replace: true });
                  const nextStays = [...stays];
                  while (nextStays.length < hop.index) nextStays.push(0);
                  nextStays[hop.index - 1] = (nextStays[hop.index - 1] || 0) + next.nightsLater;
                  return go({ stays: nextStays }, { replace: true });
                }}
                hopJourneys={cities.length === 2 ? [journeys.list] : hopJourneys}
                hrefForHopJourney={hrefForJourney}
                onChooseJourney={bringToPlan}
                inlineJourneys={cities.length > 2}
              />
            </div>
            </>
            )}

            {/* A two-city plan with no direct train and no chain either. Saying
                nothing reads as a page that failed to load; the search really
                did run and really did come back empty. */}
            {cities.length === 2 && !plan.complete && journeys.list.length === 0 && !isLoading && (
              <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                <p className="text-white/70">
                  We couldn&apos;t find a way from {cityLabel(planner, cities[0])} to{" "}
                  {cityLabel(planner, cities[1])} by night train with up to two changes, even
                  leaving up to a week later.
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

            {cities.length === 2 && journeys.list.length > 0 && !changeOnly && (
              <div className="mt-10" id="plan-changes">
                <h3 className="text-lg font-semibold text-white">
                  {plan.complete ? "Or with a change" : "Ways to get there with a change"}
                </h3>
                <p className="mt-1 text-sm text-white/45">
                  {plan.complete
                    ? "These get in sooner than the direct train."
                    : journeys.later
                      ? `Nothing connects if you leave on ${formatPlanDate(date)}. These are the first ways through after it.`
                      : "No single night train covers this on your night. These connect — each change is checked against both trains' times, and a wait of a night or two is included where the onward train does not run every day."}
                </p>
                <div className="mt-4">
                  <JourneyOptions
                    journeys={journeys.list}
                    hrefFor={(journey) => hrefForJourney(plan.hops[0], journey)}
                    onChoose={bringToPlan}
                  />
                </div>
              </div>
            )}

            {/* Extending the trip comes AFTER the trip, not before it: the
                first thing someone who picked two cities wants to see is the
                train between them — or the change that replaces it. */}
            <div className="mt-8">
              {addingCity ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                  <CityCombobox
                    label={`Then on to (after ${cityLabel(planner, lastCity)})`}
                    value={null}
                    // Not the city the trip already ends in, which the
                    // unfiltered list offers first whenever it is a big hub.
                    cities={(planner?.cities ?? []).filter((c) => c.slug !== lastCity)}
                    preferred={directFromLast}
                    describe={describeFrom(directFromLast)}
                    disabled={isLoading}
                    autoFocus
                    placeholder="Add another night"
                    onSelect={(city) => {
                      if (!city || city.slug === lastCity) return;
                      setAddingCity(false);
                      go({ cities: [...cities, city.slug] });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setAddingCity(false)}
                    className="mt-3 text-sm text-white/45 underline-offset-4 hover:text-white hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingCity(true)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 px-4 py-3 text-sm text-white/65 transition-colors hover:border-primary-green/50 hover:text-white"
                >
                  <span aria-hidden="true" className="text-primary-green">+</span>
                  Add another city after {cityLabel(planner, lastCity)}
                </button>
              )}
            </div>

            <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6">
              <SharePlan href={canonicalPath} />
              <Link
                href={buildPlanHref({ cities: [lastCity], date: plan.endDate })}
                onClick={() => {
                  scrollTarget.current = "explore-results";
                }}
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

/**
 * The cheapest way to make a trip on each of `nights`, worked out a few nights
 * at a time: three months of journeys with changes is about a third of a
 * second on a laptop and several times that on a phone, which is too long to
 * hold the page still for.
 *
 * @returns {{results: {date: string, option: object|null}[], done: boolean}}
 */
function useCheapestNights(planner, cities, stays, nights) {
  const key =
    planner && cities.length >= 2 && nights.length
      ? `${cities.join(">")}|${stays.join(",")}|${nights[0]}|${nights.length}`
      : "";
  const [state, setState] = useState({ key: "", results: [], done: true });
  const inputs = useRef({ planner, cities, stays, nights });
  inputs.current = { planner, cities, stays, nights };

  useEffect(() => {
    if (!key) return undefined;
    const { planner: p, cities: c, stays: st, nights: n } = inputs.current;
    const results = [];
    let i = 0;
    let timer = null;
    const step = () => {
      const end = Math.min(n.length, i + 8);
      for (; i < end; i++) {
        results.push({ date: n[i], option: cheapestOnNight(p, { cities: c, stays: st, date: n[i] }) });
      }
      if (i < n.length) timer = setTimeout(step, 0);
      else setState({ key, results, done: true });
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [key]);

  if (!key) return { results: [], done: true };
  return state.key === key ? state : { results: [], done: false };
}

/**
 * The trip, collapsed to one line once there is a trip to show.
 *
 * The full form is three fields and a row of date chips — on a phone, the whole
 * first screen. With two cities chosen the reader has answered it; what they
 * want next is the train, so the form folds away and "Change" brings it back.
 */
function TripSummary({ names, when, onEdit }) {
  return (
    <section
      aria-label="Trip"
      className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3"
    >
      {/* The cities are the heading right above, so this line is the one
          thing the heading does not say: when. */}
      <p className="min-w-0 truncate text-sm text-white/55">
        Departing <span className="font-medium text-white">{when}</span>
        <span className="sr-only"> · {names.join(" → ")}</span>
      </p>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-full border border-white/15 px-4 py-1.5 text-sm text-white/75 transition-colors hover:border-primary-green/50 hover:text-white"
      >
        Change
      </button>
    </section>
  );
}

/** The heading, which has to work before the index has loaded. */
function headingFor(planner, cities, { date = null, month = null, today = "" } = {}) {
  if (cities.length === 0) return { plain: "Where could you go tonight?", rich: "Where could you go tonight?" };
  const names = cities.map((slug) => cityLabel(planner, slug));
  if (cities.length === 1) {
    const when = date
      ? ` on ${formatPlanDate(date)}`
      : month
        ? ` in ${formatPlanMonth(month, { today })}`
        : "";
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

function EmptyExplore({ city, date, month, today }) {
  const when = date
    ? `on ${formatPlanDate(date)}`
    : month
      ? `in ${formatPlanMonth(month, { today })}`
      : "in the next three months";
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6">
      <p className="text-white/70">
        We have no sleeper leaving {city} {when}.
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
          <strong className="font-medium text-white/70">Changes</strong> are checked against
          both trains&apos; times, with at least 30 minutes between them. Where a stop&apos;s time
          is not published we say so instead of promising the trains meet, and we only change
          trains in cities where night trains start or end.
        </li>
        <li>
          We only suggest rides of <strong className="font-medium text-white/70">four hours
          or more</strong> — a night train calls at places 30 minutes down the line, and
          those are day-train journeys. A corridor you ask for by name is always shown,
          however short.
        </li>
        <li>
          We don't carry live seat availability. <strong className="font-medium text-white/70">Book
          </strong> opens the operator's own shop — with your stations, and your night where the
          operator's site takes one — and each train links to its connection page for the full
          timetable and fares.
        </li>
      </ul>
    </section>
  );
}

/**
 * One static page, built once per deployment, serves every plan.
 *
 * /plan/{cities}/{date} is an unbounded URL space — every city pair × every
 * date — and it used to be an ISR route (a blocking fallback plus revalidation),
 * which rendered and wrote a cache entry for each distinct URL a visitor or a
 * crawler asked for. That is the one Vercel Hobby quota this site could
 * exhaust (ISR Writes, 200 000/month), and exceeding it pauses the project.
 * next.config.js now rewrites /plan/:path+ onto this page and marks those URLs
 * noindex by header; the plan itself is read off the URL after mount and
 * rendered from the static plan index, which is where its content always came
 * from anyway. No serverless hop, no cache write, whatever the URL.
 */
export async function getStaticProps() {
  const { getTopStartCities } = await import("../../lib/plan/published.mjs");
  return {
    props: {
      seoCities: getTopStartCities(),
      initialPlan: { cities: [], date: null, month: null, stays: [] },
    },
  };
}
