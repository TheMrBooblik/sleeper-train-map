import { useEffect, useMemo, useState } from "react";
import { FiExternalLink } from "react-icons/fi";
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
  high: "text-amber-300/90",
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
  const { days, cheapestDate, bookingTemplate, currency } = calendar;
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
          {currency === "EUR" ? ", in €" : ` (${currency})`}
        </div>
      </div>

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
                const label =
                  day.state === "priced"
                    ? `${formatNight(day.date)}, ${day.classes[0]?.label.toLowerCase()} ${day.classes[0]?.price}`
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
                    className={`flex min-h-[2.75rem] min-w-0 flex-col items-center justify-center rounded-md px-0.5 py-1 leading-tight transition-colors ${
                      isSelected
                        ? "bg-primary-green/15 ring-2 ring-primary-green"
                        : selectable
                          ? day.tier === "low"
                            ? "bg-primary-green/10 hover:bg-primary-green/20"
                            : "bg-white/[0.04] hover:bg-white/[0.08]"
                          : ""
                    } ${past ? "opacity-30" : ""}`}
                  >
                    <span
                      className={`text-xs ${selectable ? "text-white/70" : "text-white/30"}`}
                    >
                      {dayNum}
                    </span>
                    <span
                      className={`text-[10px] tabular-nums tracking-tight ${
                        day.state === "priced"
                          ? (TIER_CLASS[day.tier] ?? TIER_CLASS.mid)
                          : "text-white/25"
                      }`}
                    >
                      {day.state === "priced"
                        ? day.price.replace(/^[^\d]+/, "")
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
          <ul className="mt-2 flex flex-wrap gap-2">
            {night.classes.map((c) => (
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
                className="inline-flex items-center gap-2 rounded-full bg-primary-green px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-primary-green-light"
                data-testid="fare-calendar-book"
              >
                Book {formatNight(night.date)}
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
