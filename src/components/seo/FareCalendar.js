import { useEffect, useMemo, useState } from "react";
import { FiExternalLink, FiZap } from "react-icons/fi";
import {
  calendarMonths,
  formatNight,
  WEEKDAYS,
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
 * berth prices, book that night. Cells show the cheapest berth without the
 * currency symbol (a 320 px phone gives a cell ~35 px); the selected night
 * below carries the exact prices with it.
 *
 * Server-rendered with the cheapest night selected, so the first paint and
 * the hydrated page agree. The visitor's clock is only consulted after
 * mount, to grey out nights that have passed since the page was built.
 *
 * @param {{ calendar: { currency: string, days: object[], cheapestDate: string,
 *           bookingTemplate: string|null }, trainNumber?: string,
 *           bookingHref?: string|null }} props
 */
export default function FareCalendar({ calendar, trainNumber, bookingHref }) {
  const { days, cheapestDate, bookingTemplate, currency, deals, lastMinute } =
    calendar;
  const [selected, setSelected] = useState(cheapestDate);
  const [today, setToday] = useState(null);

  useEffect(() => setToday(localToday()), []);

  const isPast = (date) => Boolean(today) && date <= today;
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const months = useMemo(() => calendarMonths(days), [days]);

  // A page built before the cheapest night passed: move to the cheapest one left.
  useEffect(() => {
    if (!today || !selected || selected > today) return;
    const next = days
      .filter((d) => d.state === "priced" && d.date > today)
      .sort((a, b) => a.amount - b.amount || (a.date < b.date ? -1 : 1))[0];
    setSelected(next?.date ?? null);
  }, [today, selected, days]);

  const night = selected ? byDate.get(selected) : null;
  const datedHref =
    night && bookingTemplate && night.bookingDate
      ? bookingTemplate.replace("{date}", night.bookingDate)
      : null;
  const href = datedHref || bookingHref || null;

  return (
    <div className="mt-4" data-testid="fare-calendar">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-xs uppercase tracking-wide text-white/40">
          Fares by night
        </div>
        <div className="text-xs text-white/40">
          Cheapest berth per night
          {currency === "EUR" ? ", in € (rounded)" : ` (${currency}, rounded)`}
        </div>
      </div>

      {deals && lastMinute && (
        <LastMinuteBanner
          deals={deals}
          programme={lastMinute}
          onShow={() => setSelected(deals.fromDate)}
          showing={selected === deals.fromDate}
          past={isPast(deals.fromDate)}
        />
      )}

      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {months.map((month) => (
          <div key={month.key} className="min-w-0">
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
                const label =
                  day.state === "priced"
                    ? `${formatNight(day.date)}, ${day.classes[0]?.label.toLowerCase()} ${day.classes[0]?.price}${isDeal ? ` (${day.deal.programme === "flashSale" ? "flash sale" : "last-minute deal"})` : ""}`
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
                    onClick={() => setSelected(day.date)}
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
        <span>— no berth on sale</span>
        <span>· not checked yet</span>
      </div>

      {night && (
        <div
          className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3"
          data-testid="fare-calendar-selected"
        >
          <div className="text-sm font-medium text-white">
            {formatNight(night.date)}
            {trainNumber ? (
              <span className="text-white/50"> · {trainNumber}</span>
            ) : null}
          </div>
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
              </li>
            ))}
          </ul>
          {night.checkedAt && (
            <p className="mt-2 text-xs text-white/40">
              Official fare, checked {formatNight(night.checkedAt)} — it changes
              as berths sell.
            </p>
          )}
          {href && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <a
                href={href}
                target="_blank"
                rel="sponsored nofollow noopener noreferrer"
                className={
                  night.deal
                    ? "inline-flex items-center gap-2 rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-white/80 transition-colors hover:border-white/40 hover:text-white"
                    : "inline-flex items-center gap-2 rounded-full bg-primary-green px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-primary-green-light"
                }
                data-testid="fare-calendar-book"
              >
                {night.deal ? "Book a regular fare" : `Book ${formatNight(night.date)}`}
                <FiExternalLink className="h-4 w-4" aria-hidden />
              </a>
              {!datedHref && (
                <span className="text-xs text-white/40">
                  Choose {formatNight(night.date)} on the operator&apos;s site.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
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
      {!past && !showing && (
        <button
          type="button"
          onClick={onShow}
          className="mt-2 cursor-pointer rounded-full border border-amber-300/50 px-3 py-1 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-400/15"
        >
          Show the cheapest deal
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
      {deal.href && (
        <a
          href={deal.href}
          target="_blank"
          rel="sponsored nofollow noopener noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-amber-300 px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-amber-200"
          data-testid="fare-calendar-deal-book"
        >
          Get this deal
          <FiExternalLink className="h-4 w-4" aria-hidden />
        </a>
      )}
      {deal.checkedAt && (
        <p className="mt-2 text-[11px] text-white/40">
          Deal seen on the operator&apos;s site {formatNight(deal.checkedAt)} — places are limited and go fast.
        </p>
      )}
    </div>
  );
}
