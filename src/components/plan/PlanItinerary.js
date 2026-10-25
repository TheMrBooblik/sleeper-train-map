import { useState } from "react";

import RideCard from "./RideCard";
import AvailabilityBadge from "./AvailabilityBadge";
import JourneyOptions, { ChangeNote } from "./JourneyOptions";
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
 * night and the dates follow from the first: the next train leaves on the day
 * the previous one gets in at the earliest, and between the two the plan says
 * how long the change is — or that the train on that night has already left. A hop with no train is shown as a hop
 * with no train — the plan stays on screen and says where it breaks, because
 * "no results" for a four-city trip hides which of the three legs was the
 * problem.
 */
/**
 * The way out of "not this night": the next night a train runs, as one tap.
 *
 * For the first hop that moves the whole trip; for a later one it adds nights
 * in the city before it, so the hops already settled keep their dates.
 */
function NextNight({ hop, next, onTryNight }) {
  if (!next || !onTryNight) return null;
  const label =
    hop.index === 0
      ? `Leave ${formatPlanDate(next.date)} instead`
      : `Stay ${next.nightsLater} more ${next.nightsLater === 1 ? "night" : "nights"} in ${hop.from.name}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/20 bg-sky-400/5 px-4 py-3">
      <p className="text-sm text-white/70">
        No train on {formatPlanDate(hop.date)}. The next one leaves{" "}
        <strong className="font-medium text-white">{formatPlanDate(next.date)}</strong>.
      </p>
      <button
        type="button"
        onClick={() => onTryNight(hop, next)}
        className="rounded-full bg-sky-300 px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-sky-200"
      >
        {label}
      </button>
    </div>
  );
}

export default function PlanItinerary({
  plan,
  stays,
  onStayChange,
  onRemoveCity,
  nextNights = [],
  onTryNight = null,
  hopJourneys = [],
  hrefForHopJourney = null,
  onChooseJourney = undefined,
  // A two-city plan shows its changes in a fuller section of its own; a longer
  // one shows them under the hop that needs them.
  inlineJourneys = true,
}) {
  const [expanded, setExpanded] = useState({});

  return (
    <ol className="flex flex-col gap-4">
      {plan.hops.map((hop) => {
        const alternatives = hop.rides.slice(1);
        const isOpen = expanded[hop.index];
        // No train runs this hop at all, but a change does: show the change in
        // its place rather than a "no night train" box above it.
        const changesInstead =
          !hop.best && inlineJourneys && hrefForHopJourney && hopJourneys[hop.index]?.length > 0;
        return (
          <li key={`${hop.from.slug}-${hop.to.slug}-${hop.index}`} className="flex flex-col gap-3">
            {hop.index > 0 && (
              <ChangeNote hop={hop} previousHop={plan.hops[hop.index - 1]} />
            )}
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
                {/* The corridor is real but every train on it is a day-train
                    distance. Saying so beats both hiding it (a corridor that
                    has trains is not "no train") and presenting it as a night
                    on a sleeper. */}
                {hop.onlyShortHops && (
                  <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
                    Under four hours — this is a day-train distance, not a night
                    on board. Shown because you asked for this pair.
                  </p>
                )}
                {!hop.served && (
                  <NextNight hop={hop} next={nextNights[hop.index]} onTryNight={onTryNight} />
                )}
                <RideCard ride={hop.best} bookable />
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
                          <RideCard key={ride.key} ride={ride} compact bookable />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : changesInstead ? null : (
              <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-white/70">
                    No night train we know of runs {hop.from.name} → {hop.to.name}.
                  </p>
                  <AvailabilityBadge availability={{ status: "no", reason: "" }} />
                </div>
                <p className="mt-2 text-sm text-white/45">
                  {hopJourneys[hop.index]?.length
                    ? `But you can get there with a change — see ${inlineJourneys ? "below" : "the options below"}.`
                    : "Try adding a stop in between, or check a day train for this leg."}
                </p>
              </div>
            )}
            {inlineJourneys && hrefForHopJourney && hopJourneys[hop.index]?.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.015] p-4">
                <p className="mb-3 text-sm text-white/60">
                  {changesInstead
                    ? `No sleeper runs straight through — change on the way:`
                    : `With a change on the way from ${hop.from.name} to ${hop.to.name}:`}
                </p>
                <JourneyOptions
                  journeys={hopJourneys[hop.index]}
                  hrefFor={(journey) => hrefForHopJourney(hop, journey)}
                  onChoose={onChooseJourney}
                  compact
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
