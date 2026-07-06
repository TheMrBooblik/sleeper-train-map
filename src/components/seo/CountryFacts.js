import { formatFromPrice } from "../../lib/operatorPricing";

/** A single labelled stat tile. Renders nothing when it has no value. */
function Fact({ label, value }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  );
}

/**
 * Compact headline facts for a country hub: counts plus the fastest/longest
 * journeys and the cheapest known fare. Every tile self-hides when its data is
 * missing, so a sparse country still looks tidy.
 *
 * @param {{ facts: object, stationCount: number }} props
 */
export default function CountryFacts({ facts, stationCount }) {
  const fromLabel = formatFromPrice(facts.minFromPrice);

  return (
    <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Fact label="Routes" value={facts.routeCount || null} />
      <Fact label="Operators" value={facts.operatorCount || null} />
      <Fact label="Departure stations" value={stationCount || null} />
      <Fact label="Fastest" value={facts.fastest?.durationText} />
      <Fact label="Longest" value={facts.longest?.durationText} />
      {/* formatFromPrice returns "from €39"; capitalise for a tidy tile value. */}
      <Fact
        label="Tickets"
        value={fromLabel ? fromLabel.replace(/^from/, "From") : null}
      />
    </div>
  );
}
