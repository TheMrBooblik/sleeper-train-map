import { useEffect, useState } from "react";
import Link from "next/link";
import { FaChevronDown, FaTimes } from "react-icons/fa";
import { getFlagEmoji } from "../../lib/countries";
import JsonLd from "./JsonLd";

// localStorage flag: once a user closes the panel we never show it again.
const DISMISS_KEY = "train-map:homeSeoDismissed";

/**
 * Homepage SEO content block.
 *
 * The homepage itself is a full-screen, client-only Leaflet map, so before this
 * component it had NO server-rendered <h1>, body copy, or internal links — the
 * most authoritative URL on the site was nearly empty to crawlers.
 *
 * This renders a real, collapsed-by-default <details> disclosure: the content
 * ships in the static HTML (fully crawlable while closed) but stays out of the
 * way visually until a user opens it. It is fixed-positioned so it never resizes
 * the map underneath. It also feeds the homepage its internal links so link
 * equity flows from "/" into the country / operator / connection hubs.
 *
 * @param {{
 *   countries: { slug: string, name: string, code: string, routeCount: number }[],
 *   operators: { slug: string, name: string, routeCount: number }[],
 *   connections: { slug: string, label: string }[],
 *   routeCount: number,
 *   countryCount: number,
 * }} props
 */
export default function HomeSeoPanel({
  countries = [],
  operators = [],
  connections = [],
  routeCount = 0,
  countryCount = 0,
}) {
  // Start visible so the server-rendered HTML always contains the SEO content
  // (crawlers read that). On the client we hide it if the user closed it before
  // — checked after mount to avoid a hydration mismatch.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === "true") setDismissed(true);
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
  }, []);

  const handleClose = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
  };

  if (dismissed) return null;
  // A short, plain-language FAQ. Mirrored into FAQPage JSON-LD below so the same
  // text is eligible for FAQ rich results — keep the two in sync.
  const faq = [
    {
      q: "What is the Sleeper Train Map?",
      a: `It is a free interactive map of European night and sleeper trains. It currently covers ${routeCount} routes across ${countryCount} countries — click any station to see the overnight connections that call there.`,
    },
    {
      q: "Which night trains does it show?",
      a: "Routes from operators such as Nightjet, European Sleeper, ČD, PKP Intercity and more, plus curated long-distance services. Use the country and operator pages to browse them all.",
    },
    {
      q: "Is it free to use?",
      a: "Yes. The map and every route page are free. Booking links point to the operators' own official sites.",
    },
  ];

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      {/* Fixed disclosure, bottom-left, above the map. Collapsed by default so
          the map stays the focus; content is still in the DOM for crawlers. */}
      <details className="group fixed bottom-4 left-4 z-[1000] w-[min(92vw,26rem)] rounded-xl border border-white/10 bg-black/85 backdrop-blur-md text-white shadow-xl">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium">
          <FaChevronDown className="h-3 w-3 shrink-0 text-white/50 transition-transform group-open:rotate-180" />
          <span>About this map &amp; browse routes</span>
          {/* Close button: dismiss for good. preventDefault stops the click from
              toggling the <details> open/closed. */}
          <button
            type="button"
            aria-label="Close and don't show again"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleClose();
            }}
            className="ml-auto text-white/50 hover:text-white transition-colors"
          >
            <FaTimes className="h-3.5 w-3.5" />
          </button>
        </summary>

        <div className="max-h-[60vh] overflow-y-auto px-4 pb-4">
          <h1 className="text-lg font-bold tracking-tight">
            Sleeper Train Map — European Night Train Routes
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-white/70">
            An interactive map of {routeCount} European night and sleeper train
            routes across {countryCount} countries. Click any station to discover
            the overnight connections passing through, with timetables, stops and
            booking links.
          </p>

          <div className="mt-4">
            <Link
              href="/trains"
              className="text-sm font-semibold text-primary-green hover:text-primary-green-light"
            >
              Browse all night train routes →
            </Link>
          </div>

          {countries.length > 0 && (
            <section className="mt-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
                Night trains by country
              </h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {countries.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/night-trains/${c.slug}`}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    <span className="mr-1">{getFlagEmoji(c.code)}</span>
                    {c.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {operators.length > 0 && (
            <section className="mt-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
                By operator
              </h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {operators.map((o) => (
                  <Link
                    key={o.slug}
                    href={`/operators/${o.slug}`}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    {o.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {connections.length > 0 && (
            <section className="mt-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
                Popular connections
              </h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {connections.map((p) => (
                  <Link
                    key={p.slug}
                    href={`/connections/${p.slug}`}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
                  >
                    {p.label}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="mt-5 border-t border-white/10 pt-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
              Frequently asked questions
            </h2>
            <dl className="mt-2 space-y-3">
              {faq.map((f) => (
                <div key={f.q}>
                  <dt className="text-sm font-medium text-white/90">{f.q}</dt>
                  <dd className="mt-1 text-xs leading-relaxed text-white/60">
                    {f.a}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </details>

      <JsonLd data={faqLd} />
    </>
  );
}
