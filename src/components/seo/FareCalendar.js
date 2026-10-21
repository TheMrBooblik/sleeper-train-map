import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiChevronLeft, FiChevronRight, FiExternalLink, FiZap } from "react-icons/fi";
import { FaBed } from "react-icons/fa";
import {
  calendarMonths,
  datedBookingHref,
  formatNight,
  monthWindowStart,
  VISIBLE_MONTHS,
  WEEKDAYS,
  fareCalendarAnchor,
} from "../../lib/fareCalendarView.mjs";

/** The visitor's own date, "YYYY-MM-DD" — read after mount only (see below). */
function localToday() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const TIER_CLASS = {
  low: "text-primary-green font-semibold",
  mid: "text-white/80",
  // Not amber: amber is the last-minute deal's colour, and a dear night
  // printed in it read as a deal on the first real calendar.
  high: "text-rose-300/80",
};

/**
 * One train's fare for each night, as month grids: pick a night, see its
 * berth prices, book that night. The months sit in a row that scrolls to the
 * right — swipe, trackpad, or the month buttons above it — with two on screen
 * from `sm` and one (the next one peeking in) on a phone, whose cells could
 * not hold a price at half the width. Cells show the cheapest couchette place
 * without the currency symbol (a 320 px phone gives a cell ~35 px); a night
 * selling no couchette shows its cheapest other berth under a bed mark, so a
 * sleeper price never passes for a couchette one. The selected night below
 * carries the exact prices with it, and the operator's product for each.
 *
 * Server-rendered with the cheapest night selected, so the first paint and
 * the hydrated page agree. The visitor's clock is only consulted after
 * mount, to grey out nights that have passed since the page was built.
 *
 * @param {{ calendar: { currency: string, days: object[], cheapestDate: string,
 *           bookingTemplate: string|null, cellBasis: string,
 *           otherBerthNights: number, noTrainNights: number },
 *           trainNumber?: string, bookingHref?: string|null,
 *           onPick?: (date: string) => void }} props  `onPick` hears a night
 *           the visitor chose (a cell, the deals banner), never the one the
 *           calendar opens on: the timetable around it retimes its stops to
 *           the chosen night (RouteTimetable).
 */
export default function FareCalendar({ calendar, trainNumber, bookingHref, onPick }) {
  const {
    days,
    cheapestDate,
    bookingTemplate,
    currency,
    deals,
    lastMinute,
    cellBasis,
    otherBerthNights,
    noTrainNights,
  } = calendar;
  const months = useMemo(() => calendarMonths(days), [days]);
  const [selected, setSelected] = useState(cheapestDate);
  const [today, setToday] = useState(null);
  const stripRef = useRef(null);
  // What the strip shows: the first month in view and how many fit. Before
  // mount this is the server's picture (the start of the row, two months);
  // after it, it is read off the strip, since only the browser knows its width.
  const [view, setView] = useState({
    first: 0,
    count: VISIBLE_MONTHS,
    atStart: true,
    atEnd: months.length <= VISIBLE_MONTHS,
  });

  useEffect(() => setToday(localToday()), []);

  const isPast = (date) => Boolean(today) && date <= today;
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);

  /** The strip's geometry: one month's pitch, which is in view, how many fit. */
  const geometry = useCallback(() => {
    const strip = stripRef.current;
    const [a, b] = strip?.children ?? [];
    if (!strip || !a) return null;
    const step = b ? b.offsetLeft - a.offsetLeft : a.offsetWidth;
    if (!step) return null;
    const gap = step - a.offsetWidth;
    return {
      strip,
      step,
      first: Math.round(strip.scrollLeft / step),
      count: Math.max(1, Math.floor((strip.clientWidth + gap) / step + 0.01)),
      atStart: strip.scrollLeft <= 1,
      atEnd: strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1,
    };
  }, []);

  const readView = useCallback(() => {
    const g = geometry();
    if (!g) return;
    setView((v) =>
      v.first === g.first &&
      v.count === g.count &&
      v.atStart === g.atStart &&
      v.atEnd === g.atEnd
        ? v
        : { first: g.first, count: g.count, atStart: g.atStart, atEnd: g.atEnd },
    );
  }, [geometry]);

  const scrollToMonth = useCallback(
    (index, behavior = "smooth") => {
      const g = geometry();
      if (g) g.strip.scrollTo({ left: Math.max(0, index) * g.step, behavior });
    },
    [geometry],
  );

  /** Bring a night's month into view, moving the strip as little as it must. */
  const reveal = useCallback(
    (date, behavior = "smooth") => {
      const g = geometry();
      if (!g) return;
      const target = monthWindowStart(months, date, g.first, g.count);
      if (target !== g.first) scrollToMonth(target, behavior);
    },
    [geometry, months, scrollToMonth],
  );

  // Open on the cheapest night's month (it is selected), then keep the
  // buttons in step with however the strip is scrolled.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    reveal(cheapestDate, "auto");
    readView();
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readView);
    };
    strip.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", onChange);
    return () => {
      cancelAnimationFrame(frame);
      strip.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, [cheapestDate, reveal, readView]);

  // Selecting a night from outside the grid (the deals banner) brings its
  // month into view.
  const select = (date) => {
    setSelected(date);
    reveal(date);
    onPick?.(date);
  };

  // A page built before the cheapest night passed: move to the cheapest one left.
  useEffect(() => {
    if (!today || !selected || selected > today) return;
    const next = days
      .filter((d) => d.state === "priced" && d.date > today)
      .sort((a, b) => a.amount - b.amount || (a.date < b.date ? -1 : 1))[0];
    setSelected(next?.date ?? null);
    if (next) reveal(next.date);
  }, [today, selected, days, reveal]);

  const inView = (date) => {
    const at = months.findIndex((m) => m.key === String(date ?? "").slice(0, 7));
    return at >= view.first && at < view.first + view.count;
  };
  const prevMonth = view.atStart ? null : (months[view.first - 1] ?? null);
  const nextMonth = view.atEnd ? null : (months[view.first + view.count] ?? null);
  // A deal off screen is worth a hint on the button that reaches it.
  const hasLiveDeal = (list) =>
    list.some((m) => m.weeks.some((w) => w.some((d) => d?.deal && !isPast(d.date))));

  const night = selected ? byDate.get(selected) : null;
  const datedHref = datedBookingHref(bookingTemplate, night);
  // The calendar's own direction first (data.js), then the route's CTA.
  const href = datedHref || calendar.bookingHref || bookingHref || null;

  return (
    // The map panel links here by this id; scroll-mt clears the fixed nav.
    <div
      id={fareCalendarAnchor(trainNumber) || undefined}
      className="mt-4 scroll-mt-20"
      data-testid="fare-calendar"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-xs uppercase tracking-wide text-white/40">
          Fares by night
        </div>
        {/* What a cell is, since it is not simply the night's cheapest
            place: a couchette wherever the night sells one. */}
        <div className="text-xs text-white/40">
          {cellBasis === "couchette"
            ? "Cheapest couchette per night"
            : "Cheapest berth per night"}
          {currency === "EUR" ? ", in € (rounded)" : ` (${currency}, rounded)`}
        </div>
      </div>

      {deals && lastMinute && (
        <LastMinuteBanner
          deals={deals}
          programme={lastMinute}
          onShow={() => select(deals.fromDate)}
          // Selected but scrolled out of view still needs the way back.
          showing={selected === deals.fromDate && inView(deals.fromDate)}
          past={isPast(deals.fromDate)}
        />
      )}

      {/* Nothing to scroll to (every month fits): no buttons. */}
      {!(view.atStart && view.atEnd) && (
        <div
          className="mt-3 flex items-center justify-between gap-2"
          data-testid="fare-calendar-nav"
        >
          <MonthButton
            direction="prev"
            month={prevMonth}
            deal={!view.atStart && hasLiveDeal(months.slice(0, view.first))}
            onClick={() => scrollToMonth(view.first - 1)}
          />
          <MonthButton
            direction="next"
            month={nextMonth}
            deal={!view.atEnd && hasLiveDeal(months.slice(view.first + view.count))}
            onClick={() => scrollToMonth(view.first + 1)}
          />
        </div>
      )}

      {/* gap-4 is 1rem: two months at 50% − 0.5rem fill the row exactly, and
          a phone's month leaves 1rem of the next one showing, which says
          "swipe" better than any arrow. */}
      <div
        ref={stripRef}
        className="mt-2 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="fare-calendar-months"
      >
        {months.map((month) => (
          <div
            key={month.key}
            className="w-[calc(100%-2rem)] shrink-0 snap-start sm:w-[calc(50%-0.5rem)]"
          >
            <div className="mb-1 text-sm font-medium text-white/80">
              {month.title}
            </div>
            <div
              className="grid grid-cols-7 gap-0.5 text-center"
              role="group"
              aria-label={month.title}
            >
              {WEEKDAYS.map((w) => (
                <div
                  key={w}
                  className="pb-1 text-[10px] uppercase text-white/35"
                  aria-hidden
                >
                  {w.slice(0, 2)}
                </div>
              ))}
              {month.weeks.flat().map((day, i) => {
                if (!day) return <div key={`pad-${i}`} aria-hidden />;
                const dayNum = Number(day.date.slice(8));
                const past = isPast(day.date);
                const selectable = day.state === "priced" && !past;
                const isSelected = selectable && day.date === selected;
                const isDeal = Boolean(day.deal) && selectable;
                // A night with no couchette prints another berth's price:
                // marked in the cell, named in its label.
                const otherBerth = day.state === "priced" && Boolean(day.otherBerth);
                const noTrain = day.state === "none" && day.reason === "noJourney";
                const shown =
                  day.classes.find((c) => c.key === day.cellClass) ?? day.classes[0];
                const label =
                  day.state === "priced"
                    ? `${formatNight(day.date)}, ${shown?.label.toLowerCase()} ${shown?.price}${otherBerth ? " (no couchette on sale)" : ""}${isDeal ? ` (${day.deal.programme === "flashSale" ? "flash sale" : "last-minute deal"})` : ""}`
                    : noTrain
                      ? `${formatNight(day.date)}, no train that night`
                      : day.state === "none"
                        ? `${formatNight(day.date)}, no berth on sale`
                        : `${formatNight(day.date)}, not checked yet`;
                return (
                  <button
                    key={day.date}
                    type="button"
                    disabled={!selectable}
                    aria-pressed={isSelected}
                    aria-label={label}
                    title={label}
                    onClick={() => {
                      setSelected(day.date);
                      onPick?.(day.date);
                    }}
                    className={`relative flex min-h-[2.75rem] min-w-0 flex-col items-center justify-center rounded-md px-0.5 py-1 leading-tight transition-colors ${
                      // Tailwind 4 no longer gives a button the pointer.
                      selectable ? "cursor-pointer" : "cursor-default"
                    } ${
                      isSelected
                        ? isDeal
                          ? "bg-amber-400/20 ring-2 ring-amber-300"
                          : "bg-primary-green/15 ring-2 ring-primary-green"
                        : isDeal
                          ? "bg-amber-400/15 ring-1 ring-amber-300/50 hover:bg-amber-400/25"
                          : selectable
                            ? day.tier === "low"
                              ? "bg-primary-green/10 hover:bg-primary-green/20"
                              : "bg-white/[0.04] hover:bg-white/[0.08]"
                            : ""
                    } ${past ? "opacity-30" : ""}`}
                  >
                    {isDeal && (
                      <FiZap
                        className="absolute right-0.5 top-0.5 h-2.5 w-2.5 text-amber-300"
                        aria-hidden
                      />
                    )}
                    {otherBerth && (
                      <FaBed
                        className={`absolute left-0.5 top-0.5 h-2.5 w-2.5 ${selectable ? "text-sky-300/80" : "text-white/25"}`}
                        aria-hidden
                      />
                    )}
                    <span
                      className={`text-xs ${selectable ? "text-white/70" : "text-white/30"}`}
                    >
                      {dayNum}
                    </span>
                    <span
                      className={`text-[10px] tabular-nums tracking-tight ${
                        isDeal
                          ? "font-semibold text-amber-300"
                          : day.state === "priced"
                            ? (TIER_CLASS[day.tier] ?? TIER_CLASS.mid)
                            : "text-white/25"
                      }`}
                    >
                      {day.state === "priced"
                        ? day.cellPrice
                        : noTrain
                          ? "×"
                          : day.state === "none"
                            ? "—"
                            : "·"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/40">
        <span>
          <span className="text-primary-green font-semibold">green</span>{" "}
          cheapest nights
        </span>
        {deals && (
          <span className="inline-flex items-center gap-1">
            <FiZap className="h-3 w-3 text-amber-300" aria-hidden />
            <span className="font-semibold text-amber-300">amber</span>{" "}
            {deals.programmes?.includes("flashSale")
              ? deals.programmes.includes("lastMinute")
                ? "last-minute or flash-sale deal"
                : "flash-sale deal"
              : "last-minute deal"}
          </span>
        )}
        {otherBerthNights > 0 && (
          <span className="inline-flex items-center gap-1">
            <FaBed className="h-3 w-3 text-sky-300/80" aria-hidden />
            no couchette that night: cheapest other berth
          </span>
        )}
        <span>— no berth on sale</span>
        {noTrainNights > 0 && <span>× no train that night</span>}
        <span>· not checked yet</span>
      </div>

      {night && (
        <NightActionBar
          night={night}
          deal={night.deal && !isPast(night.date) ? night.deal : null}
          href={href}
          dated={Boolean(datedHref)}
          trainNumber={trainNumber}
        />
      )}

      {night && (
        <div
          className="rounded-lg border border-white/10 bg-white/[0.03] p-3 pt-1"
          data-testid="fare-calendar-selected"
        >
          {night.deal && !isPast(night.date) && (
            <DealDetail
              deal={night.deal}
              programme={lastMinute?.[night.deal.programme] ?? lastMinute?.lastMinute}
              compartmentSize={lastMinute?.compartmentSize}
              trainNumber={trainNumber}
            />
          )}
          {night.deal && (
            <div className="mt-3 text-xs uppercase tracking-wide text-white/40">
              Regular fares this night
            </div>
          )}
          <ul className="mt-2 flex flex-wrap gap-2">
            {night.classes.filter((c) => !c.deal).length === 0 && (
              <li className="text-sm text-white/50">
                No regular berth on sale.
              </li>
            )}
            {night.classes.filter((c) => !c.deal).map((c) => (
              <li
                key={c.key}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white/70"
              >
                {c.label}{" "}
                <span className="font-medium text-white">{c.price}</span>
                {/* The operator's product, so the same fare can be found in
                    its shop ("Sparschiene" is not "Komfortticket"). */}
                {c.offer && <span className="text-white/45"> · {c.offer}</span>}
              </li>
            ))}
          </ul>
          {night.checkedAt && (
            <p className="mt-2 text-xs text-white/40">
              Official fare, checked {formatNight(night.checkedAt)} — it changes
              as berths sell.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The selected night's heading and buttons, in a bar that stays on screen for
 * as long as the calendar does: pick a night, press Book. The buttons used to
 * sit at the foot of the night's card, below the grid and — on a deal night —
 * below the deal's terms, so choosing a night meant scrolling to find what to
 * press.
 *
 * It sits between the grid and the night's details and is sticky at both
 * ends: below the grid it holds to the bottom of the screen while the months
 * fill it, and over the details it holds to the top (under the fixed nav,
 * h-16) while the deal's terms are read. Sticky never leaves its containing
 * block, so past the calendar it scrolls away with it.
 */
function NightActionBar({ night, deal, href, dated, trainNumber }) {
  // The class the night's cell prints, so the bar and the grid quote the same
  // figure; the cheapest regular class when the cell is a deal.
  const regular =
    night.classes.find((c) => !c.deal && c.key === night.cellClass) ??
    night.classes.find((c) => !c.deal);
  return (
    // The wrapper's padding is transparent: it must not swallow taps on the
    // nights underneath it, only the bar inside may.
    <div
      className="pointer-events-none sticky top-[4.5rem] bottom-0 z-10 mt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      data-testid="fare-calendar-actions"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/15 bg-zinc-900/95 px-3 py-2.5 shadow-[0_-8px_24px_rgba(0,0,0,0.6)] backdrop-blur">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-medium text-white">
            {formatNight(night.date)}
            {trainNumber ? (
              <span className="text-white/50"> · {trainNumber}</span>
            ) : null}
            {/* The night's own clock, where the source recorded one: a
                Nightjet leaves at another time on a works night. */}
            {night.dep && night.arr ? (
              <span className="whitespace-nowrap font-mono text-white/50" data-testid="fare-calendar-clock">
                {" "}
                · {night.dep} → {night.arr}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-white/60">
            {deal ? (
              <span className="inline-flex items-center gap-1 font-semibold text-amber-200">
                <FiZap className="h-3 w-3" aria-hidden />
                {deal.price}{" "}
                {deal.kind === "private" ? "private compartment" : "couchette bed"}
              </span>
            ) : regular ? (
              <>
                {regular.label}{" "}
                <span className="font-medium text-white">{regular.price}</span>
              </>
            ) : (
              "No regular berth on sale"
            )}
            {href && !dated ? " · pick the night on the operator's site" : ""}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {deal?.href && (
            <a
              href={deal.href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-amber-200"
              data-testid="fare-calendar-deal-book"
            >
              Get this deal
              <FiExternalLink className="h-4 w-4" aria-hidden />
            </a>
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              className={
                deal
                  ? "inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:border-white/40 hover:text-white"
                  : "inline-flex items-center gap-2 rounded-full bg-primary-green px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-primary-green-light"
              }
              data-testid="fare-calendar-book"
            >
              {deal ? "Regular fare" : "Book"}
              <FiExternalLink className="h-4 w-4" aria-hidden />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "‹ September 2026" / "January 2027 ›": names the month it scrolls in, so
 * paging is not a guess. Disabled at either end rather than hidden, so the
 * other button does not jump across the row. A ⚡ marks a side holding a deal.
 */
function MonthButton({ direction, month, deal, onClick }) {
  const prev = direction === "prev";
  const Chevron = prev ? FiChevronLeft : FiChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!month}
      aria-label={
        month
          ? `Show ${month.title}${deal ? " (has deals)" : ""}`
          : prev
            ? "No earlier nights"
            : "No later nights"
      }
      className={`inline-flex h-8 min-w-0 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors ${
        month
          ? "cursor-pointer border-white/20 text-white/80 hover:border-white/40 hover:text-white"
          : "cursor-default border-white/10 text-white/25"
      }`}
    >
      {prev && <Chevron className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {month && <span className="truncate">{month.title}</span>}
      {deal && <FiZap className="h-3 w-3 shrink-0 text-amber-300" aria-hidden />}
      {!prev && <Chevron className="h-3.5 w-3.5 shrink-0" aria-hidden />}
    </button>
  );
}

/** "Last-minute deals" / "Flash-sale deals" / both, for the banner. */
function dealsTitle(programmes = []) {
  const lm = programmes.includes("lastMinute");
  const fs = programmes.includes("flashSale");
  if (lm && fs) return "Last-minute and flash-sale deals";
  return fs ? "Flash-sale deals" : "Last-minute deals";
}

/**
 * The calendar's last-minute deals in one card above the grids: how many
 * nights, from how much, how far under the regular fare — and a button that
 * jumps to the cheapest. The point is that these prices are not in the
 * operator's own fare finder, so a visitor comparing there would miss them.
 */
function LastMinuteBanner({ deals, programme, onShow, showing, past }) {
  return (
    <div
      className="mt-3 rounded-lg border border-amber-300/40 bg-amber-400/[0.08] p-3"
      data-testid="fare-calendar-deals"
    >
      <div className="flex items-start gap-2">
        <FiZap className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
        <div className="min-w-0 text-sm text-white/80">
          <span className="font-semibold text-white">
            {dealsTitle(deals.programmes)} from {deals.from}
          </span>{" "}
          on {deals.count} {deals.count === 1 ? "night" : "nights"}
          {Number.isFinite(deals.maxSavingsPct) && deals.maxSavingsPct > 0
            ? ` — up to ${deals.maxSavingsPct}% below the regular fare for the same place`
            : ""}
          .{" "}
          <span className="text-white/50">{programme.note}</span>
        </div>
      </div>
      {/* Always in the layout, only its label changes. It sits above the
          month buttons, so a button that appeared once the deal's month
          scrolled out of view pushed them down under the pointer that had
          just clicked one. */}
      {!past && (
        <button
          type="button"
          onClick={onShow}
          disabled={showing}
          className={`mt-2 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
            showing
              ? "cursor-default border-amber-300/20 text-amber-200/50"
              : "cursor-pointer border-amber-300/50 text-amber-200 hover:bg-amber-400/15"
          }`}
        >
          {showing ? "Cheapest deal selected below" : "Show the cheapest deal"}
        </button>
      )}
    </div>
  );
}

/** One night's deal: the price, what it saves, the catch, and where to buy it. */
function DealDetail({ deal, programme, compartmentSize, trainNumber }) {
  const what =
    deal.kind === "private" ? "Private compartment" : "Couchette bed";
  return (
    <div
      className="mt-3 rounded-lg border border-amber-300/50 bg-amber-400/10 p-3"
      data-testid="fare-calendar-deal"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wide text-amber-300">
        <FiZap className="h-3.5 w-3.5" aria-hidden />
        {programme?.name ??
          (deal.programme === "flashSale" ? "Flash sale" : "Last-minute deal")}
        {deal.best && (
          <span className="rounded-full bg-amber-300 px-2 py-0.5 text-[10px] text-black">
            Cheapest fare this night
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-white/70">{what}</span>
        <span className="text-2xl font-semibold text-white">{deal.price}</span>
        {deal.regularPrice && deal.savings && (
          <span className="text-sm text-white/40 line-through">
            {deal.regularPrice}
          </span>
        )}
        {deal.savings && (
          <span className="rounded-full bg-primary-green/15 px-2 py-0.5 text-xs font-semibold text-primary-green">
            Save {deal.savings}
            {Number.isFinite(deal.savingsPct) ? ` (${deal.savingsPct}%)` : ""}
          </span>
        )}
      </div>
      {deal.regularPrice && deal.savings && (
        <p className="mt-1 text-xs text-white/50">
          against the cheapest regular{" "}
          {deal.kind === "private" ? "private compartment" : "couchette"} on{" "}
          {trainNumber ? `${trainNumber} ` : ""}that night
        </p>
      )}
      {deal.perPerson && (
        <p className="mt-1 text-xs text-white/60">
          One price for the whole compartment, up to{" "}
          {compartmentSize ?? 5} people — {deal.perPerson} each when
          it is full.
        </p>
      )}
      {deal.until && (
        <p className="mt-1 text-xs font-medium text-amber-200">
          Sale ends {formatNight(deal.until)} — book by then.
        </p>
      )}
      {programme?.terms?.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-white/60">
          {programme.terms.map((t) => (
            <li key={t}>· {t}</li>
          ))}
        </ul>
      )}
      {deal.checkedAt && (
        <p className="mt-2 text-[11px] text-white/40">
          Deal seen on the operator&apos;s site {formatNight(deal.checkedAt)} — places are limited and go fast.
        </p>
      )}
    </div>
  );
}
