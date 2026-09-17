import { formatPlanDate } from "../../lib/plan/format.mjs";
import { addDays } from "../../lib/plan/url.mjs";

/**
 * When do you want to leave?
 *
 * The quick picks matter more than the input: the whole premise of "where could
 * you go tonight" is that the answer is one tap away, and a bare <input
 * type=date> asks for a calendar interaction before the page can say anything
 * at all.
 */
export default function DateField({ value, today, onChange }) {
  const picks = [
    { label: "Tonight", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "This weekend", date: nextFriday(today) },
  ];

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="plan-date" className="text-sm font-medium text-white/70">
        Departing
      </label>
      <input
        id="plan-date"
        type="date"
        min={today}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-base text-white [color-scheme:dark] focus:border-primary-green/60 focus:outline-none focus:ring-1 focus:ring-primary-green/40"
      />
      <div className="flex flex-wrap gap-2">
        {picks.map((pick) => (
          <button
            key={pick.label}
            type="button"
            onClick={() => onChange(pick.date)}
            aria-pressed={value === pick.date}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              value === pick.date
                ? "border-primary-green/50 bg-primary-green/15 text-primary-green"
                : "border-white/12 text-white/55 hover:border-white/25 hover:text-white"
            }`}
          >
            {pick.label}
            <span className="ml-1.5 text-white/30">{formatPlanDate(pick.date)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The coming Friday; today when today is already Friday. */
function nextFriday(today) {
  const [y, m, d] = today.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(today, (5 - day + 7) % 7);
}
