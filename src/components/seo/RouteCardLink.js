import Link from "next/link";
import { getOperatorBaseColor } from "@components/Map/utils/operatorColors";
import { joinTrainNumbers } from "../../lib/operatorAgencies.mjs";
import { eurRateNote } from "../../lib/fx.mjs";

/**
 * A link card for a single train route, used in the hub-page lists.
 *
 * Links to the route's /connections/ page — per-train /trains/[slug] pages were
 * retired into their city-pair parent, so the connection page is where a train's
 * timetable, stops and booking link now live.
 * @param {{ route: object }} props - a route summary from the SEO data layer
 */
export default function RouteCardLink({ route }) {
  const color = getOperatorBaseColor({ agency_id: route.operatorIds?.[0] });
  const operatorNames = route.operators.map((o) => o.name).join(", ");
  if (!route.pairSlug) return null;

  return (
    <Link
      href={`/connections/${route.pairSlug}`}
      className="group block rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-colors overflow-hidden"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white group-hover:text-primary-green transition-colors">
            {route.title}
          </h3>
          {route.trainNumbers?.length > 0 && (
            <span className="shrink-0 text-xs font-mono text-white/50">
              {joinTrainNumbers(route.trainNumbers)}
            </span>
          )}
        </div>
        {/* The operator's proper train name (e.g. "Bessarabia"), shown small
            below the city title. Only present for named trains. */}
        {route.routeName && (
          <p className="mt-0.5 text-xs italic text-white/45">{route.routeName}</p>
        )}
        {operatorNames && (
          <p className="mt-1 text-xs text-white/50">{operatorNames}</p>
        )}
        {/* Journey length, starting price, and a "from <date>" badge for trains
            that have not started running yet. Each part shows only when present
            so sparse routes still render cleanly. */}
        {(route.durationText || route.fromPrice || route.futureFrom) && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/40">
            {route.durationText && <span>{route.durationText}</span>}
            {route.durationText && route.fromPrice && (
              <span aria-hidden="true">·</span>
            )}
            {route.fromPrice && (
              <span className="text-primary-green/80">
                {route.fromPrice}
                {route.fromPriceEur && (
                  <span className="text-white/40" title={eurRateNote()}>
                    {" "}({route.fromPriceEur})
                  </span>
                )}
              </span>
            )}
            {route.futureFrom && (
              <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-amber-300/90">
                {route.futureFrom}
              </span>
            )}
          </p>
        )}
      </div>
    </Link>
  );
}
