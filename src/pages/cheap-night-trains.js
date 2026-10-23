import Head from "next/head";
import { useEffect, useMemo, useState } from "react";
import { FiZap } from "react-icons/fi";
import Link from "../components/Link";

import SeoLayout from "@components/seo/SeoLayout";
import Breadcrumbs from "@components/seo/Breadcrumbs";
import FaqSection from "@components/seo/FaqSection";
import JsonLd from "@components/seo/JsonLd";

import { getFareOverviewTrains } from "../lib/seo/data";
import {
  buildFareOverview,
  fareOverviewFaq,
} from "../lib/fareOverview.mjs";
import { toEur } from "../lib/fx.mjs";
import { DEAL_PROGRAMMES } from "../lib/lastMinuteDeals.mjs";
import { formatNight } from "../lib/fareCalendarView.mjs";
import { OG_IMAGE, absoluteUrl } from "../lib/seo/site";

const PATH = "/cheap-night-trains";
const TITLE = "Cheap Night Trains — Deals & Lowest Fares by Night | Pingwi";

/** "A, B and C" */
function listNames(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const SPONSORED = "sponsored nofollow noopener noreferrer";

function description(o) {
  const parts = [
    `Lowest berth fare for every night of the coming weeks on ${o.trainCount} night trains (${listNames(o.operatorNames)}).`,
  ];
  if (o.deals.length) parts.push(`${o.deals.length} deals from ${o.dealsFrom}.`);
  parts.push("Updated daily.");
  return parts.join(" ");
}

/** "Brussels → Prague" with the train under it. */
function TrainName({ row }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-white">
        {row.originCity} <span className="text-white/40">→</span> {row.destinationCity}
      </p>
      <p className="truncate text-xs text-white/50">
        {row.trainNumber} · {row.operatorName}
      </p>
    </div>
  );
}

function BookLink({ href, deal = false, children = "Book" }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel={SPONSORED}
      className={`inline-flex shrink-0 items-center rounded-full px-3.5 py-1.5 text-sm font-semibold text-black transition-colors ${
        deal ? "bg-amber-300 hover:bg-amber-200" : "bg-primary-green hover:bg-primary-green-light"
      }`}
    >
      {children}
    </a>
  );
}

function NightRow({ row, showCheapCount = false, hidden = false }) {
  return (
    <li className={`${hidden ? "hidden " : ""}flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row sm:items-center`}>
      <TrainName row={row} />
      <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
        <div className="min-w-0 sm:text-right">
          <p className="text-white">
            <span
              className={`text-lg font-semibold ${row.night.isDeal ? "text-amber-300" : "text-primary-green"}`}
            >
              {row.night.price}
            </span>{" "}
            <span className="text-sm text-white/60">{row.night.dateText}</span>
          </p>
          <p className="text-xs text-white/45">
            {row.night.classLabel}
            {showCheapCount && row.cheapNights > 1
              ? ` · ${row.cheapNights} nights within 10% of this`
              : ""}
            {showCheapCount && row.highPrice ? ` · up to ${row.highPrice}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={row.calendarHref}
            className="text-sm text-white/60 underline decoration-white/20 underline-offset-4 hover:text-white"
          >
            Every night
          </Link>
          <BookLink href={row.night.href} deal={row.night.isDeal}>
            {row.night.isDeal ? "Get this deal" : "Book"}
          </BookLink>
        </div>
      </div>
    </li>
  );
}

function DealCard({ deal, hidden = false }) {
  const programme = DEAL_PROGRAMMES[deal.operatorId]?.[deal.programme];
  return (
    <li className={`${hidden ? "hidden " : ""}flex flex-col gap-3 rounded-xl border border-amber-300/40 bg-amber-400/[0.07] p-4`}>
      <div className="flex items-start justify-between gap-3">
        <TrainName row={deal} />
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-black">
          <FiZap className="h-3 w-3" aria-hidden />
          {programme?.name ?? "Deal"}
        </span>
      </div>
      <div>
        <p className="text-white">
          <span className="text-xl font-semibold text-amber-300">{deal.price}</span>{" "}
          <span className="text-sm text-white/70">
            {deal.kind === "private" ? "whole compartment" : "a bed"} · {deal.dateText}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-white/55">
          {deal.perPerson ? `${deal.perPerson} each when full · ` : ""}
          {deal.regularPrice
            ? `Regular fare that night ${deal.regularPrice}${deal.savingsPct ? ` (−${deal.savingsPct}%)` : ""}`
            : "Not in the operator's own fare finder"}
          {deal.until ? ` · book by ${deal.until}` : ""}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <Link
          href={deal.calendarHref}
          className="text-sm text-white/60 underline decoration-white/20 underline-offset-4 hover:text-white"
        >
          Compare nights
        </Link>
        {deal.href && (
          <a
            href={deal.href}
            target="_blank"
            rel={SPONSORED}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-300 px-3.5 py-1.5 text-sm font-semibold text-black transition-colors hover:bg-amber-200"
          >
            <FiZap className="h-3.5 w-3.5" aria-hidden />
            Get this deal
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * The first `limit` items, and a button for the rest. The rest stay in the
 * HTML (hidden with CSS) so the page is complete without JavaScript.
 */
function Collapsible({ items, limit, render, className, more }) {
  const [open, setOpen] = useState(false);
  const extra = items.length - limit;
  return (
    <>
      <ul className={className}>
        {items.map((item, i) => render(item, !open && i >= limit))}
      </ul>
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-3 rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 transition-colors hover:border-white/30 hover:bg-white/5"
        >
          {open ? "Show fewer" : more(extra)}
        </button>
      )}
    </>
  );
}

function CityFilter({ cities, value, onChange }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-white/60">
      Show trains to or from
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 max-w-full rounded-lg border border-white/15 bg-zinc-900 px-3 py-1.5 text-white"
      >
        <option value="">Anywhere</option>
        {cities.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Where the cheap nights are, across every train whose fares we read nightly.
 * Built from the same calendars the connection pages render (see
 * src/lib/fareOverview.mjs), so a price and its Book link are the same here
 * and there.
 */
export default function CheapNightTrains({ overview, faq }) {
  const [city, setCity] = useState("");
  // The page is rebuilt nightly; a visitor reading it a day later should not
  // be offered a night that has already left. The build date renders first,
  // the visitor's own clock takes over after mount.
  const [today, setToday] = useState(overview.today);
  useEffect(() => {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (local > overview.today) setToday(local);
  }, [overview.today]);

  const cities = useMemo(() => {
    const set = new Set();
    for (const c of overview.cheapest) {
      set.add(c.originCity);
      set.add(c.destinationCity);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [overview.cheapest]);

  const keep = (row, date) =>
    date > today && (!city || row.originCity === city || row.destinationCity === city);
  const deals = overview.deals.filter((d) => keep(d, d.date));
  const cheapest = overview.cheapest.filter((r) => keep(r, r.night.date));
  const weekend = overview.weekend.filter((r) => keep(r, r.night.date));

  const desc = description(overview);
  const canonical = absoluteUrl(PATH);

  const faqLd = faq.length
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
        <title>{TITLE}</title>
        <meta name="description" content={desc} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={desc} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={desc} />
        <meta name="twitter:image" content={OG_IMAGE} />
      </Head>

      <SeoLayout>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-16">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Cheap night trains" }]} />

          <header className="mt-6 max-w-3xl">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight">
              Cheap night trains
            </h1>
            <p className="mt-4 text-white/60 leading-relaxed">
              Every night we check the price of a bed on every night of the coming weeks on{" "}
              {overview.trainCount} night trains run by {listNames(overview.operatorNames)} —{" "}
              {overview.pricedNightsText} priced nights in all. This page puts
              them side by side: the deals on sale, the cheapest night on each train, and the
              cheapest Friday or Saturday for a weekend away.
            </p>
            <p className="mt-2 text-xs text-white/40">
              Prices checked {formatNight(overview.today)}. One adult, one couchette or sleeper
              place, as the operator sells it; they change with demand.
            </p>
          </header>

          <div className="mt-8">
            <CityFilter cities={cities} value={city} onChange={setCity} />
          </div>

          {deals.length > 0 && (
            <section className="mt-10" aria-labelledby="deals">
              <h2 id="deals" className="flex items-center gap-2 text-xl font-semibold text-white">
                <FiZap className="h-5 w-5 text-amber-300" aria-hidden />
                Last-minute and flash deals
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-white/60">
                European Sleeper sells spare couchette beds at a flat promotional price from its own
                offer pages. {DEAL_PROGRAMMES.ES.note} Non-refundable, limited places.
              </p>
              <Collapsible
                items={deals}
                limit={6}
                className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                render={(d, hidden) => <DealCard key={`${d.id}-${d.date}`} deal={d} hidden={hidden} />}
                more={(n) => `Show ${n} more deal${n === 1 ? "" : "s"}`}
              />
            </section>
          )}

          <section className="mt-12" aria-labelledby="cheapest">
            <h2 id="cheapest" className="text-xl font-semibold text-white">
              The cheapest night on every train
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-white/60">
              Each train&apos;s lowest fare over the coming weeks, cheapest first. &ldquo;Every
              night&rdquo; opens its full price calendar.
            </p>
            {cheapest.length ? (
              <Collapsible
                items={cheapest}
                limit={12}
                className="mt-4 grid grid-cols-1 gap-2"
                render={(row, hidden) => <NightRow key={row.id} row={row} showCheapCount hidden={hidden} />}
                more={(n) => `Show ${n} more train${n === 1 ? "" : "s"}`}
              />
            ) : (
              <p className="mt-4 text-sm text-white/50">No priced night on a train to or from {city}.</p>
            )}
          </section>

          {weekend.length > 0 && (
            <section className="mt-12" aria-labelledby="weekend">
              <h2 id="weekend" className="text-xl font-semibold text-white">
                A weekend away: Friday and Saturday nights
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-white/60">
                The cheapest Friday or Saturday departure on each train over the next two weekends.
              </p>
              <Collapsible
                items={weekend}
                limit={8}
                className="mt-4 grid grid-cols-1 gap-2"
                render={(row, hidden) => <NightRow key={row.id} row={row} hidden={hidden} />}
                more={(n) => `Show ${n} more train${n === 1 ? "" : "s"}`}
              />
            </section>
          )}

          <FaqSection items={faq} />

          <p className="mt-10 text-sm text-white/50">
            Looking for a route rather than a price? Browse{" "}
            <Link href="/connections" className="underline underline-offset-4 hover:text-white">
              every night train connection
            </Link>{" "}
            or{" "}
            <Link href="/plan" className="underline underline-offset-4 hover:text-white">
              plan a trip night by night
            </Link>
            .
          </p>
        </div>
      </SeoLayout>
      {faqLd && <JsonLd data={faqLd} />}
    </>
  );
}

export async function getStaticProps() {
  const { today, trains } = getFareOverviewTrains();
  const overview = buildFareOverview(trains, { today, toEur });
  return {
    props: { overview, faq: fareOverviewFaq(overview) },
  };
}
