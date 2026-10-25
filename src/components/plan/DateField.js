import { formatPlanMonth } from "../../lib/plan/format.mjs";
import { monthChoices } from "../../lib/plan/flexible.mjs";

/**
 * When do you want to leave?
 *
 * "Any time" is the default and the first choice, because the question most
 * people bring to a night train is what it costs, and the answer is a night
 * rather than a price: the planner tries every night and shows the cheapest.
 * A month narrows that to the nights of the month; a night is a plan for that
 * night. The chips matter more than the input — a bare <input type=date> asks
 * for a calendar interaction before the page can say anything at all.
 *
 * @param {{date: string|null, month: string|null, today: string,
 *          onChange: (when: {date: string|null, month: string|null}) => void}} props
 */
export default function DateField({ date, month, today, onChange }) {
  const anytime = !date && !month;
  const chip = (pressed) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      pressed
        ? "border-primary-green/50 bg-primary-green/15 text-primary-green"
        : "border-white/12 text-white/55 hover:border-white/25 hover:text-white"
    }`;

  return (
    // min-w-0 all the way down: a grid/flex item defaults to min-width:auto, so
    // it will not shrink below its content's intrinsic width — and iOS Safari
    // gives input[type=date] a wide intrinsic width from its native control.
    // Desktop Chromium's control is narrower, which is why this overflowed on a
    // phone and measured 0 px in a headless viewport of the same width.
    <div className="flex min-w-0 flex-col gap-2">
      <span id="plan-when-label" className="text-sm font-medium text-white/70">
        When
      </span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="plan-when-label">
        <button
          type="button"
          onClick={() => onChange({ date: null, month: null })}
          aria-pressed={anytime}
          className={chip(anytime)}
        >
          Any time
          <span className="ml-1.5 text-white/30">cheapest night</span>
        </button>
        <button
          type="button"
          onClick={() => onChange({ date: today, month: null })}
          aria-pressed={date === today}
          className={chip(date === today)}
        >
          Tonight
        </button>
        {monthChoices(today).map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => onChange({ date: null, month: choice })}
            aria-pressed={month === choice}
            className={chip(month === choice)}
          >
            {formatPlanMonth(choice, { short: true, today })}
          </button>
        ))}
      </div>
      <label htmlFor="plan-date" className="mt-1 text-xs text-white/45">
        Or a night
      </label>
      <input
        id="plan-date"
        type="date"
        min={today}
        value={date || ""}
        onChange={(event) =>
          onChange(event.target.value ? { date: event.target.value, month: null } : { date: null, month })
        }
        className="box-border w-full min-w-0 max-w-full appearance-none rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-left text-base text-white [color-scheme:dark] focus:border-primary-green/60 focus:outline-none focus:ring-1 focus:ring-primary-green/40"
      />
    </div>
  );
}
