import { useState } from "react";

import RideCard from "./RideCard";
import AvailabilityBadge from "./AvailabilityBadge";
import { formatPlanDate } from "../../lib/plan/format.mjs";

function StayStepper({ nights, onChange, city }) {
  return (
    <div className="flex items-center gap-2 text-sm text-white/55">
      <span>
        {nights === 0
          ? `Straight on from ${city}`
          : `${nights} extra ${nights === 1 ? "night" : "nights"} in ${city}`}
      </span>
      <span className="inline-flex overflow-hidden rounded-lg border border-white/15">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, nights - 1))}
          disabled={nights === 0}
          aria-label={`One night fewer in ${city}`}
          className="px-2.5 py-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onChange(nights + 1)}
          aria-label={`One night more in ${city}`}
          className="border-l border-white/15 px-2.5 py-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          +
        </button>
      </span>
    </div>
  );
}

/**
 * The plan, as nights.
 *
 * A sleeper journey is measured in nights, not in changes, so each hop is one
 * night and the dates follow from the first: the next train can leave on the
 * morning of arrival at the earliest. A hop with no train is shown as a hop
 * with no train — the plan stays on screen and says where it breaks, because
 * "no results" for a four-city trip hides which of the three legs was the
 * problem.
 */
export default function PlanItinerary({ plan, stays, onStayChange, onRemoveCity }) {
  const [expanded, setExpanded] = useState({});

  return (
    <ol className="flex flex-col gap-4">
      {plan.hops.map((hop) => {
        const alternatives = hop.rides.slice(1);
        const isOpen = expanded[hop.index];
        return (
          <li key={`${hop.from.slug}-${hop.to.slug}-${hop.index}`} className="flex flex-col gap-3">
            {hop.index > 0 && (
              <StayStepper
                nights={hop.stayNights}
                city={hop.from.name}
                onChange={(n) => onStayChange(hop.index - 1, n)}
              />
            )}

            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-base font-semibold text-white">
                {/* "Night N" only when the best train actually crosses a night.
                    Labelling a four-hour evening connection "Night 2" promises a
                    bed that this leg does not have. */}
                <span className="mr-2 text-white/35">
                  {hop.best && !hop.best.isOvernight ? "Leg" : "Night"} {hop.index + 1}
                </span>
                {hop.from.name} → {hop.to.name}
              </h3>
              <div className="flex items-center gap-3">
                <time dateTime={hop.date} className="text-sm text-white/50">
                  {formatPlanDate(hop.date)}
                </time>
                {onRemoveCity && plan.hops.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRemoveCity(hop.index + 1)}
                    className="text-sm text-white/35 underline-offset-4 transition-colors hover:text-white/70 hover:underline"
                  >
                    Remove {hop.to.name}
                  </button>
                )}
              </div>
            </div>

            {hop.best ? (
              <>
                <RideCard ride={hop.best} />
                {alternatives.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((e) => ({ ...e, [hop.index]: !e[hop.index] }))
                      }
                      aria-expanded={Boolean(isOpen)}
                      className="text-sm text-white/50 underline-offset-4 transition-colors hover:text-white hover:underline"
                    >
                      {isOpen ? "Hide" : "Show"} {alternatives.length} other{" "}
                      {alternatives.length === 1 ? "train" : "trains"} on this night
                    </button>
                    {isOpen && (
                      <div className="mt-3 flex flex-col gap-3">
                        {alternatives.map((ride) => (
                          <RideCard key={ride.key} ride={ride} compact />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-white/70">
                    No night train we know of runs {hop.from.name} → {hop.to.name}.
                  </p>
                  <AvailabilityBadge availability={{ status: "no", reason: "" }} />
                </div>
                <p className="mt-2 text-sm text-white/45">
                  Try adding a stop in between, or check a day train for this leg.
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
