import Link from "../Link";

import { formatPlanDate } from "../../lib/plan/format.mjs";
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
      {change.detail && <span className="text-xs text-white/35">{change.detail}</span>}
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
                <span className="text-sm text-white/45">
                  {journey.nights} {journey.nights === 1 ? "night" : "nights"} ·{" "}
                  {changes === 0 ? "direct" : `${changes} ${changes === 1 ? "change" : "changes"}`}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/55">
                Leaves {formatPlanDate(journey.date)}
                {first?.departure ? ` ${first.departure}` : ""} · arrives{" "}
                {formatPlanDate(rideArrivalDate(last))}
                {last?.arrival ? ` ${last.arrival}` : ""}
                {caveats.length > 0 && (
                  <span className="ml-2 text-xs text-amber-300"> · {caveats.join(" · ")}</span>
                )}
              </p>
              {!compact && (
                <ol className="mt-3 flex flex-col gap-1.5 border-l border-white/10 pl-3">
                  {journey.hops.map((hop, i) => (
                    <li key={hop.index} className="flex flex-col gap-1.5">
                      {i > 0 && <ChangeNote hop={hop} previousHop={journey.hops[i - 1]} />}
                      <p className="text-sm text-white/75">
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
