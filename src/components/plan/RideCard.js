import Link from "next/link";

import AvailabilityBadge from "./AvailabilityBadge";
import { getOperatorMeta } from "../../lib/seo/operators";
import { formatDurationMinutes } from "../../lib/seo/format";

/**
 * "2026/09/14-12/11: Mon, Wed, Fri" → "Mon, Wed, Fri · until 11 Dec".
 *
 * The raw service string leads with a validity window written for a timetable
 * compiler. What a traveller needs first is the days, and the window only when
 * it is a real season rather than "all of this year".
 */
export function serviceSummary(serviceText) {
  const raw = String(serviceText || "").trim();
  if (!raw) return "";
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return raw;
  const prefix = raw.slice(0, colon).trim();
  const days = raw.slice(colon + 1).trim();
  // A bare year is the default validity and says nothing worth the space.
  if (/^\d{4}$/.test(prefix)) return days;
  const until = prefix.match(/(?:[-–]\s*)(?:(\d{4})[-/])?(\d{2})[-/](\d{2})$/);
  if (!until) return days;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const month = MONTHS[Number(until[2]) - 1];
  return month ? `${days} · until ${Number(until[3])} ${month}` : days;
}

/** "22:34" + "06:01" → "+1", so an arrival is never read as the same evening. */
function dayOffsetLabel(departure, arrival) {
  if (!departure || !arrival) return "";
  return arrival <= departure ? "+1" : "";
}

function operatorLabel(operatorIds = []) {
  const names = operatorIds.map((id) => getOperatorMeta(id)?.name).filter(Boolean);
  return names.length ? names.join(" / ") : operatorIds.join(" / ");
}

/**
 * One boardable ride.
 *
 * Shows the three things a traveller decides on — when it leaves, when it
 * lands, and whether we can stand behind that — and nothing it cannot back up:
 * a missing clock renders as "time not published", never as a guess, because
 * Back-on-Track times only the two endpoints and 292 of the 541 legs have no
 * operator feed to fill the stops between.
 */
export default function RideCard({ ride, action = null, compact = false }) {
  const { from, to, departure, arrival, durationMinutes, availability } = ride;
  const offset = dayOffsetLabel(departure, arrival);
  const operator = operatorLabel(ride.operatorIds);

  return (
    <article
      className={`rounded-2xl border border-white/10 bg-white/[0.03] transition-colors hover:border-white/20 ${
        compact ? "p-4" : "p-5"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold text-white">{to.city}</p>
          <p className="mt-0.5 truncate text-sm text-white/45">
            {from.station} → {to.station}
          </p>
        </div>
        <AvailabilityBadge availability={availability} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2">
          {departure ? (
            <span className="font-mono text-xl text-white">{departure}</span>
          ) : (
            <span className="text-sm text-white/40">departure not published</span>
          )}
          <span aria-hidden="true" className="text-white/25">
            →
          </span>
          {arrival ? (
            <span className="font-mono text-xl text-white">
              {arrival}
              {offset && (
                <span className="ml-0.5 align-super text-xs text-primary-green">{offset}</span>
              )}
            </span>
          ) : (
            <span className="text-sm text-white/40">arrival not published</span>
          )}
        </div>
        {durationMinutes ? (
          <span className="text-sm text-white/55">
            {formatDurationMinutes(durationMinutes)}
          </span>
        ) : null}
        {ride.isOvernight ? (
          <span className="text-sm text-white/45">overnight</span>
        ) : departure && arrival ? (
          <span className="text-sm text-white/45">same evening</span>
        ) : null}
        {/* A price slot exists so the probe pipeline has one place to land.
            Nothing feeds these routes yet, so nothing renders. */}
        {ride.fromPrice ? (
          <span className="text-sm font-medium text-primary-green">
            from {ride.fromPrice}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-white/45">
          {[operator, ride.train, serviceSummary(availability?.serviceText)]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="flex items-center gap-4">
          {ride.pairSlug && (
            <Link
              href={`/connections/${ride.pairSlug}`}
              className="text-white/50 underline-offset-4 transition-colors hover:text-white hover:underline"
            >
              Timetable &amp; booking
            </Link>
          )}
          {action}
        </div>
      </div>

      {availability?.reason && availability.status !== "runs" && (
        <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/50">
          {availability.reason}
        </p>
      )}
      {availability?.note && availability.status === "runs" && (
        <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/50">
          Operator note: {availability.note}
        </p>
      )}
    </article>
  );
}
