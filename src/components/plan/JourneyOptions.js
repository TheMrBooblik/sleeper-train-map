import Link from "../Link";

import { formatPlanDate } from "../../lib/plan/format.mjs";
import { journeyFare } from "../../lib/plan/journeyFare.mjs";
import { rideArrivalDate } from "../../lib/plan/search.mjs";
import { formatDurationMinutes } from "../../lib/seo/format";

/**
 * How the change into a hop works, in words — or null for the first hop.
 *
 * Shared by the itinerary and the journey cards so a change reads the same in
 * both: what the card promised is what the plan shows once it is opened.
 *
 * @returns {{tone: "ok"|"unconfirmed"|"missed", text: string, detail: string}|null}
 */
export function describeChange(hop, previousHop) {
  const connection = hop?.connection;
  if (!connection || !previousHop?.best) return null;
  const city = hop.from.name;
  const arrive = previousHop.best.arrival;
  const leave = hop.best?.departure;
  // A city is not a station: ES 475 gets in at Berlin Gesundbrunnen and the
  // Nightjet to Vienna leaves from Berlin Hbf, which is a change across town.
  const inStation = previousHop.best.to?.station;
  const outStation = hop.best?.from?.station;
  const crossTown = inStation && outStation && inStation !== outStation;
  const detail = [
    (arrive || crossTown) && `arrive ${arrive || ""}${crossTown ? ` at ${inStation}` : ""}`.replace("  ", " "),
    (leave || crossTown) && `next train ${leave || ""}${crossTown ? ` from ${outStation}` : ""}`.replace("  ", " "),
  ]
    .filter(Boolean)
    .join(", ");

  if (connection.status === "missed") {
    return {
      tone: "missed",
      text: `The trains on ${formatPlanDate(hop.date)} leave ${city} before you get in`,
      detail,
    };
  }
  if (connection.status === "unconfirmed") {
    return {
      tone: "unconfirmed",
      text: `Change in ${city} — a time is not published, so check the trains meet`,
      detail,
    };
  }
  const nights = hop.stayNights || 0;
  if (nights > 0) {
    return {
      tone: "ok",
      text: `${nights} ${nights === 1 ? "night" : "nights"} in ${city}`,
      detail,
    };
  }
  const wait = formatDurationMinutes(connection.waitMinutes);
  return {
    tone: "ok",
    text: wait ? `Change in ${city} · ${wait} between trains` : `Change in ${city}`,
    detail,
  };
}

const TONES = {
  ok: "text-white/55",
  unconfirmed: "text-amber-200/80",
  missed: "text-rose-200/90",
};

/** One line between two trains. */
export function ChangeNote({ hop, previousHop, className = "" }) {
  const change = describeChange(hop, previousHop);
  if (!change) return null;
  return (
    <p className={`flex flex-wrap items-baseline gap-x-2 text-sm ${TONES[change.tone]} ${className}`}>
      <span>
        <span aria-hidden="true" className="mr-2">⇄</span>
        {change.text}
      </span>
      {/* The stations and clocks behind the change: worth the room on a
          wide screen, noise on a phone where the summary already says it. */}
      {change.detail && (
        <span className="hidden text-xs text-white/35 sm:inline">{change.detail}</span>
      )}
    </p>
  );
}

/**
 * The fare of a journey as one sum: "€40 + €69.90 = €109.90".
 *
 * Large, because with a change of train it is the number a traveller compares
 * first. One train shows its fare alone; a train without a published fare is a
 * "?" and leaves no total, since adding nothing for it would understate the trip.
 */
export function FareSum({ rides, className = "" }) {
  const fare = journeyFare(rides);
  if (!fare) return null;
  const single = fare.parts.length === 1;
  return (
    <p
      className={`flex flex-wrap items-baseline gap-x-1.5 text-lg font-semibold tabular-nums text-white sm:text-xl ${className}`}
    >
      {fare.from && <span className="text-xs font-normal text-white/45">from</span>}
      {single ? (
        <span className="text-primary-green">{fare.parts[0]}</span>
      ) : (
        <>
          {fare.parts.map((part, i) => (
            <span key={i} className="flex items-baseline gap-x-1.5">
              {i > 0 && <span className="font-normal text-white/35">+</span>}
              <span className={part === "?" ? "text-white/35" : "text-white/80"}>{part}</span>
            </span>
          ))}
          {fare.total && (
            <>
              <span className="font-normal text-white/35">=</span>
              <span className="text-primary-green">{fare.total}</span>
            </>
          )}
        </>
      )}
      {!fare.total && !single && (
        <span className="basis-full text-xs font-normal text-white/40">
          {fare.parts.includes("?")
            ? fare.parts.filter((part) => part === "?").length === 1
              ? "One train's fare isn't published, so there is no total"
              : "Some fares aren't published, so there is no total"
            : "Fares in different currencies"}
        </span>
      )}
    </p>
  );
}

function trainLine(hop) {
  const ride = hop.best;
  if (!ride) return `${hop.from.name} → ${hop.to.name}`;
  const dep = ride.departure ? ` ${ride.departure}` : "";
  const arr = ride.arrival ? ` ${ride.arrival}` : "";
  return `${hop.from.name}${dep} → ${hop.to.name}${arr}`;
}

/**
 * Ways to get somewhere with a change of train.
 *
 * Each card is the whole journey — when it leaves, when it gets in, every train
 * and every change between them — because "via Munich" alone does not let
 * anyone choose: the change is a 13-hour day in Munich or a night there, and
 * the trains run on different nights. Opening one puts it in the plan.
 */
export default function JourneyOptions({ journeys, hrefFor, onChoose, compact = false }) {
  if (!journeys?.length) return null;
  return (
    <ul className="grid grid-cols-1 gap-3">
      {journeys.map((journey) => {
        const first = journey.hops[0]?.best;
        const last = journey.hops[journey.hops.length - 1]?.best;
        const changes = journey.hops.length - 1;
        // Two different things a traveller has to check, so two words for them.
        const caveats = [
          journey.hops.some((h) => h.best?.availability?.status !== "runs") && "days unconfirmed",
          journey.hops.some((h) => h.connection && h.connection.status !== "ok") &&
            "change time unconfirmed",
        ].filter(Boolean);
        return (
          <li key={`${journey.cities.join(">")}@${journey.date}:${(journey.stays || []).join(",")}`}>
            <Link
              href={hrefFor(journey)}
              onClick={onChoose}
              className={`block rounded-xl border border-white/10 bg-white/[0.02] transition-colors hover:border-primary-green/40 ${
                compact ? "p-3" : "p-4"
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-white">
                  {journey.hops.map((h) => h.from.name).concat(journey.hops.at(-1).to.name).join(" → ")}
                </span>
                <span className="hidden text-sm text-white/45 sm:inline">
                  {journey.nights} {journey.nights === 1 ? "night" : "nights"} ·{" "}
                  {changes === 0 ? "direct" : `${changes} ${changes === 1 ? "change" : "changes"}`}
                </span>
              </div>
              <FareSum rides={journey.hops.map((h) => h.best)} className="mt-1.5" />
              <p className="mt-1 text-sm text-white/55">
                {formatPlanDate(journey.date)}
                {first?.departure ? ` ${first.departure}` : ""} →{" "}
                {formatPlanDate(rideArrivalDate(last))}
                {last?.arrival ? ` ${last.arrival}` : ""}
                <span className="sm:hidden">
                  {" "}· {journey.nights} {journey.nights === 1 ? "night" : "nights"}
                </span>
              </p>
              {caveats.length > 0 && (
                <p className="mt-0.5 text-xs text-amber-300">{caveats.join(" · ")}</p>
              )}
              {!compact && (
                <ol className="mt-3 flex flex-col gap-1.5 border-l border-white/10 pl-3">
                  {journey.hops.map((hop, i) => (
                    <li key={hop.index} className="flex flex-col gap-1.5">
                      {i > 0 && <ChangeNote hop={hop} previousHop={journey.hops[i - 1]} />}
                      {/* Each train's own line is the detail a phone can do
                          without: the sum above names the fares, the change
                          line names the city, and the plan opens with both. */}
                      <p className="hidden text-sm text-white/75 sm:block">
                        <span className="mr-2 font-mono text-xs text-white/40">
                          {hop.best?.train || "train"}
                        </span>
                        {trainLine(hop)}
                        <span className="ml-2 text-xs text-white/35">{formatPlanDate(hop.date)}</span>
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <span className="mt-3 inline-block text-sm text-primary-green">
                {changes === 0 ? "Take this train →" : "Plan this route →"}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
