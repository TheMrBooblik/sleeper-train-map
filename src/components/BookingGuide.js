/**
 * How booking works on a train whose booking has quirks (src/lib/bookingGuide.mjs).
 *
 * Two shapes, because the two places it appears have different room:
 *
 *   - the connection page (`tone="dark"`) renders the whole guide as a section
 *     — the highlights, every heading with its points, and the sources — so the
 *     text is in the DOM for readers and crawlers alike;
 *   - the map panel (`tone="light"`, `compact`) renders the highlights inside a
 *     native <details> under the Book button, closed by default so a trip card
 *     does not grow a page of prose, with the full guide one click further.
 *
 * <details> rather than state: keyboard-operable and labelled for free, works
 * before hydration, and cannot be clipped by the panel's scroll container —
 * the same reasons PricingExplainer uses it.
 *
 * Sources are ordinary links (rel="noopener"), never sponsored: they are
 * citations, not places to buy. "Further reading" is a separate line because
 * it is a different claim — a traveller's own account we credit and send
 * readers to, not a page the guide's statements rest on.
 */

import { FiCheck, FiX } from "react-icons/fi";

const TONES = {
  dark: {
    wrap: "rounded-xl border border-white/10 bg-white/[0.02] p-5 sm:p-6",
    title: "text-lg font-semibold text-white",
    summary: "mt-2 text-sm leading-relaxed text-white/70 text-pretty",
    highlight: "text-sm text-white/90",
    heading: "text-sm font-semibold text-white",
    point: "text-sm leading-relaxed text-white/60",
    bullet: "bg-primary-green",
    sources: "text-xs text-white/40",
    link: "underline underline-offset-2 hover:text-white/70",
  },
  light: {
    wrap: "rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60",
    title: "text-xs font-semibold text-gray-900 dark:text-zinc-100",
    summary: "mt-1 text-xs leading-relaxed text-gray-700 dark:text-zinc-300",
    highlight: "text-xs text-gray-800 dark:text-zinc-200",
    heading: "text-xs font-semibold text-gray-900 dark:text-zinc-100",
    point: "text-xs leading-relaxed text-gray-600 dark:text-zinc-400",
    bullet: "bg-amber-500",
    sources: "text-[11px] text-gray-400 dark:text-zinc-500",
    link: "underline underline-offset-2 hover:text-gray-700 dark:hover:text-zinc-300",
  },
};

function Bullets({ items, textClass, bulletClass }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((item) => (
        <li key={item} className={`flex gap-2 ${textClass}`}>
          <span aria-hidden className={`mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full ${bulletClass}`} />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function LinkList({ links, t }) {
  return links.map((s, i) => (
    <span key={s.url}>
      {i > 0 && " · "}
      <a href={s.url} target="_blank" rel="noopener noreferrer" className={t.link}>
        {s.label}
      </a>
    </span>
  ));
}

function Sources({ sources, furtherReading, checkedAt, t }) {
  if (!sources?.length && !furtherReading?.length) return null;
  return (
    <div className={`mt-4 space-y-1 ${t.sources}`}>
      {sources?.length > 0 && (
        <p>
          Sources: <LinkList links={sources} t={t} />
          {checkedAt ? ` · Checked ${checkedAt.slice(0, 7)}` : ""}
        </p>
      )}
      {furtherReading?.length > 0 && (
        <p>
          Further reading: <LinkList links={furtherReading} t={t} />
        </p>
      )}
    </div>
  );
}

function Sections({ sections, t }) {
  return (
    <div className="mt-5 space-y-5">
      {sections.map((section) => (
        <div key={section.heading}>
          <h3 className={t.heading}>{section.heading}</h3>
          <Bullets items={section.points} textClass={t.point} bulletClass={t.bullet} />
        </div>
      ))}
    </div>
  );
}

const NOTICE_TONES = {
  dark: {
    wrap: "rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-5",
    heading: "text-sm font-semibold text-amber-200",
    item: "text-base text-white",
    hint: "text-sm text-white/50",
    yes: "text-emerald-400",
    no: "text-red-400",
    sources: "text-xs text-white/40",
    link: "underline underline-offset-2 hover:text-white/70",
  },
  light: {
    wrap: "rounded-md border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-800/60 dark:bg-amber-950/40",
    heading: "text-xs font-semibold text-amber-800 dark:text-amber-300",
    item: "text-sm text-gray-900 dark:text-zinc-100",
    hint: "text-xs text-gray-500 dark:text-zinc-400",
    yes: "text-emerald-600 dark:text-emerald-400",
    no: "text-red-600 dark:text-red-400",
  },
};

/**
 * A guide that is a warning rather than a how-to (`notice`): who may ride at
 * all, as a ✓/✗ checklist read at a glance — short enough to sit open at the
 * top of the page and of the panel's card, where a closed box would hide the
 * one thing it says.
 */
function Notice({ guide, tone, className }) {
  const t = NOTICE_TONES[tone] ?? NOTICE_TONES.dark;
  const { heading, items } = guide.notice;
  return (
    <aside className={`${t.wrap} ${className}`} aria-label={heading} data-testid="booking-notice">
      <p className={t.heading}>{heading}</p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item.text} className="flex gap-2">
            {item.ok ? (
              <FiCheck aria-label="Yes" className={`mt-[0.2em] h-4 w-4 shrink-0 ${t.yes}`} />
            ) : (
              <FiX aria-label="No" className={`mt-[0.2em] h-4 w-4 shrink-0 ${t.no}`} />
            )}
            <span className="min-w-0">
              <span className={`block ${t.item}`}>{item.text}</span>
              {item.hint && <span className={`block ${t.hint}`}>{item.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      {t.sources && (
        <Sources sources={guide.sources} furtherReading={guide.furtherReading} checkedAt={guide.checkedAt} t={t} />
      )}
    </aside>
  );
}

export default function BookingGuide({ guide, tone = "dark", compact = false, className = "" }) {
  if (!guide) return null;
  if (guide.notice) return <Notice guide={guide} tone={tone} className={className} />;
  const t = TONES[tone] ?? TONES.dark;

  if (compact) {
    return (
      <details className={`group ${t.wrap} ${className}`}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
          <span className={t.title}>Before you book: how tickets work on this train</span>
          <span aria-hidden className="text-gray-400 dark:text-zinc-500 transition-transform group-open:rotate-45">
            +
          </span>
        </summary>
        <div className="px-2.5 pb-2.5">
          <Bullets items={guide.highlights} textClass={t.highlight} bulletClass={t.bullet} />
          <details className="mt-2">
            <summary className={`cursor-pointer text-xs font-medium text-gray-700 dark:text-zinc-300 ${t.link}`}>
              The full guide
            </summary>
            <Sections sections={guide.sections} t={t} />
            <Sources
              sources={guide.sources}
              furtherReading={guide.furtherReading}
              checkedAt={guide.checkedAt}
              t={t}
            />
          </details>
        </div>
      </details>
    );
  }

  return (
    <section className={`${t.wrap} ${className}`} aria-labelledby={`booking-guide-${guide.id}`}>
      <h2 id={`booking-guide-${guide.id}`} className={t.title}>
        {guide.title}
      </h2>
      {guide.summary && <p className={t.summary}>{guide.summary}</p>}
      {guide.highlights?.length > 0 && (
        <Bullets items={guide.highlights} textClass={`${t.highlight} font-medium`} bulletClass={t.bullet} />
      )}
      <Sections sections={guide.sections} t={t} />
      <Sources
        sources={guide.sources}
        furtherReading={guide.furtherReading}
        checkedAt={guide.checkedAt}
        t={t}
      />
    </section>
  );
}
