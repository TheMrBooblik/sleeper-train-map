import Link from "../Link";

import { formatMoney } from "../../lib/fareClasses.mjs";
import { formatPlanDate, formatPlanMonth } from "../../lib/plan/format.mjs";
import { monthGrid } from "../../lib/plan/flexible.mjs";
import { buildPlanHref } from "../../lib/plan/url.mjs";
import { rideArrivalDate } from "../../lib/plan/search.mjs";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "from €109.90" in full, for a row. */
function FullPrice({ fare }) {
  if (!fare?.total) return <span className="text-sm text-white/40">fare not published</span>;
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      {fare.from && <span className="text-xs text-white/45">from</span>}
      <span className="text-xl font-semibold tabular-nums text-primary-green">{fare.total}</span>
    </span>
  );
}

/** Whole units for a grid cell, which has room for "€110" and not "€109.90". */
function shortPrice(option) {
  if (!option?.rank) return "";
  return formatMoney(Math.round(option.rank.cents / 100), option.rank.currency);
}

function routeLine(option) {
  const first = option.hops[0]?.best;
  const last = option.hops.at(-1)?.best;
  const times =
    first?.departure && last?.arrival
      ? `${first.departure} → ${formatPlanDate(rideArrivalDate(last))} ${last.arrival}`
      : "";
  const how =
    option.hops.length === 1
      ? first?.train || "Direct"
      : `via ${option.hops
          .slice(1)
          .map((h) => h.from.name)
          .join(", ")}`;
  return [how, times].filter(Boolean).join(" · ");
}

/** One night: the date and what it costs, as one tap target. */
function NightRow({ result, onChoose, highlight }) {
  const { option } = result;
  return (
    <li>
      <Link
        href={buildPlanHref(option)}
        onClick={onChoose}
        className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors hover:border-primary-green/40 ${
          highlight ? "border-primary-green/30 bg-primary-green/[0.06]" : "border-white/10 bg-white/[0.02]"
        }`}
      >
        <span className="min-w-0">
          <span className="block font-medium text-white">
            {formatPlanDate(result.date)}
            {/* Sold only from the operator's deal page, which is where the
                plan's button goes. */}
            {option.hops.some((h) => h.best?.deal) && (
              <span className="ml-1.5 text-xs font-normal text-amber-300">⚡ deal</span>
            )}
          </span>
          <span className="block truncate text-xs text-white/45">{routeLine(option)}</span>
        </span>
        <FullPrice fare={option.fare} />
      </Link>
    </li>
  );
}

function MonthGrid({ month, results, onChoose }) {
  const cells = monthGrid(month, results);
  const priced = results.filter((r) => r.option?.rank);
  const best = priced.length
    ? Math.min(...priced.map((r) => r.option.rank.cents))
    : null;
  return (
    <div className="mt-4">
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-white/35">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <span key={`blank-${i}`} />;
          const day = Number(cell.date.slice(8));
          if (!cell.option) {
            return (
              <span
                key={cell.date}
                className="flex aspect-square flex-col items-center justify-center rounded-lg text-xs text-white/20"
                title={cell.tried ? "No train that night" : undefined}
              >
                {day}
              </span>
            );
          }
          const cheapest = cell.option.rank && cell.option.rank.cents === best;
          return (
            <Link
              key={cell.date}
              href={buildPlanHref(cell.option)}
              onClick={onChoose}
              title={`${formatPlanDate(cell.date)}${cell.option.fare?.total ? ` · ${cell.option.fare.total}` : ""}`}
              className={`flex aspect-square min-w-0 flex-col items-center justify-center rounded-lg border text-xs transition-colors hover:border-primary-green/50 ${
                cheapest
                  ? "border-primary-green/50 bg-primary-green/15 text-white"
                  : "border-white/10 bg-white/[0.03] text-white/75"
              }`}
            >
              <span>{day}</span>
              <span
                className={`max-w-full truncate text-[10px] tabular-nums sm:text-[11px] ${
                  cheapest ? "font-semibold text-primary-green" : "text-white/50"
                }`}
              >
                {shortPrice(cell.option) || "·"}
              </span>
            </Link>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-white/35">
        A dot is a night a train runs without a price for that night.
      </p>
    </div>
  );
}

/**
 * The cheapest nights for a trip with no night chosen: "any time", or a month.
 *
 * @param {{results: {date: string, option: object|null}[], summary: object,
 *          month: string|null, today: string, pending: boolean,
 *          onPickMonth: (month: string) => void, onChoose: () => void}} props
 */
export default function CheapestNights({ results, summary, month, today, pending, onPickMonth, onChoose }) {
  const where = month ? ` in ${formatPlanMonth(month, { today })}` : "";
  const months = [...summary.byMonth.entries()];

  return (
    <div>
      <h2 id="plan-title" className="text-xl font-semibold text-white">
        {pending || (summary.priced > 0 && summary.varies) ? `Cheapest nights${where}` : `When it runs${where}`}
      </h2>
      <p className="mt-1 text-sm text-white/45">
        {pending
          ? "Checking every night…"
          : summary.running === 0
            ? `No night train we know of makes this trip${where || " in the next three months"}.`
            : summary.priced > 0 && summary.varies
              ? "Priced night by night from the operators' own fare calendars, where they publish one."
              : summary.priced > 0
                ? "These trains publish one lowest fare for every night here, so no night is cheaper than another."
                : "No fare is published for these nights. These are the first nights a train runs."}
      </p>

      {month && summary.running > 0 && <MonthGrid month={month} results={results} onChoose={onChoose} />}

      {(summary.cheapest.length > 0 || summary.firstNights.length > 0) && (
        <ol className="mt-4 flex flex-col gap-2">
          {/* Without a price per night the cheapest are ties, and in date order
              they are simply the first nights a train runs. */}
          {(summary.priced ? summary.cheapest : summary.firstNights).slice(0, month ? 3 : 5).map(
            (result, i) => (
              <NightRow
                key={result.date}
                result={result}
                onChoose={onChoose}
                highlight={summary.varies && i === 0}
              />
            ),
          )}
        </ol>
      )}


      {!month && months.length > 1 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-white/70">By month</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {months.map(([m, result]) => (
              <li key={m}>
                <button
                  type="button"
                  onClick={() => onPickMonth(m)}
                  className="rounded-full border border-white/12 px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-primary-green/50 hover:text-white"
                >
                  {formatPlanMonth(m, { short: true, today })}
                  {result.option.rank && (
                    <span className="ml-1.5 tabular-nums text-primary-green">
                      {result.option.fare.from ? "from " : ""}
                      {result.option.fare.total}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
