import Link from "next/link";
import {
  getOperatorPricing,
  formatPricingLabel,
  pricingAdvice,
} from "../../lib/operatorPricing";
import { getFlagEmoji } from "../../lib/countries";

function Fact({ label, value, hint }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-white/50 text-pretty">{hint}</div>}
    </div>
  );
}

/**
 * Key facts about a route: operator(s), price, duration, distance, CO₂, classes,
 * plus the countries it crosses (each linking to its night-trains hub).
 */
export default function RouteFactsGrid({ detail }) {
  const pricing = getOperatorPricing({
    agency_id: detail.agencyId,
    pricing: detail.pricing,
  });
  const priceLabel = formatPricingLabel(pricing);
  // The tile said "From: Dynamic pricing" — a label that did not match its value
  // and a value nobody can act on. It now carries the advice, with the reason
  // underneath, because this sits directly above the booking button.
  const advice = pricingAdvice(pricing);
  const operatorNames = detail.operators.map((o) => o.name).join(" · ");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Fact label="Operator" value={operatorNames} />
        <Fact label="Duration" value={detail.facts.durationText} />
        <Fact label="Distance" value={detail.facts.distanceText} />
        <Fact label="CO₂" value={detail.facts.co2Text} />
        <Fact label="Classes" value={detail.facts.classes} />
        <Fact
          label="Tickets"
          value={priceLabel}
          hint={advice ? `${advice.short.charAt(0).toUpperCase()}${advice.short.slice(1)}.` : ""}
        />
      </div>

      {detail.countries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-white/40">
            Countries
          </span>
          {detail.countries.map((c) => (
            <Link
              key={c.code}
              href={`/night-trains/${c.slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors"
            >
              <span>{getFlagEmoji(c.code)}</span>
              {c.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
