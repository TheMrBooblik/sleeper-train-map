import Link from "next/link";
import {
  getOperatorPricing,
  formatPricingLabel,
  formatFromPrice,
  pricingAdvice,
  formatCheckedAt,
} from "../../lib/operatorPricing";
import { getFlagEmoji } from "../../lib/countries";
import PricingExplainer from "../PricingExplainer";
import { fareClassLabel, fareContext } from "../../lib/fareClasses.mjs";
import { eurHintFor, eurRateNote } from "../../lib/fx.mjs";

function Fact({ label, value, children }) {
  if (!value && !children) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      {children ?? <div className="mt-1 text-sm font-medium text-white">{value}</div>}
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
  // and a value nobody could act on. It now names the fare model, with the
  // advice a click away: this sits directly above the booking button, so the
  // reader gets the fact at a glance and the reasoning on demand.
  // Prefer the advice the page already resolved: it knows whether this
  // operator publishes a last-minute deals page, and the CTA a few lines below
  // renders that caveat. Re-resolving here without it made the tile and the
  // button disagree on the same page. Falling back keeps the component usable
  // on its own.
  const advice = detail.advice ?? pricingAdvice(pricing);
  // The railway companies that run the train where the data lists them; the
  // seller is named by the Book button below. Else the operators.
  const runBy = detail.railways?.length ? detail.railways : detail.operators.map((o) => o.name);
  const operatorNames = runBy.join(" · ");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Fact label={runBy.length > 1 && detail.railways?.length ? "Run by" : "Operator"} value={operatorNames} />
        <Fact label="Duration" value={detail.facts.durationText} />
        <Fact label="Distance" value={detail.facts.distanceText} />
        <Fact label="CO₂" value={detail.facts.co2Text} />
        <Fact label="Classes" value={detail.facts.classes} />
        <Fact label="Tickets" value={priceLabel}>
          {priceLabel && (
            <PricingExplainer
              advice={advice}
              label={priceLabel}
              className="mt-1"
              labelClassName="text-sm font-medium"
              checkedAt={formatCheckedAt(pricing?.checkedAt)}
            />
          )}
          {/* A fixed fare's figure is in the badge; its euro equivalent goes
              on its own small line rather than into the badge itself. */}
          {priceLabel && pricing?.type !== "dynamic" && eurHintFor(pricing) && (
            <div className="mt-0.5 text-xs text-white/50" title={eurRateNote()}>
              ({eurHintFor(pricing)})
            </div>
          )}
          {/* What a fixed fare's "from" figure buys — the Sunrise's cheapest
              is the Nobinobi carpet space, not a room. */}
          {priceLabel && pricing?.type !== "dynamic" && fareClassLabel(pricing?.seatClass) && (
            <div className="mt-0.5 text-xs text-white/50">{fareClassLabel(pricing.seatClass)}</div>
          )}
          {/* A dynamic fare's badge carries no figure (formatPricingLabel);
              the figure sits on its own line, always as "from …". */}
          {pricing?.type === "dynamic" && formatFromPrice(pricing) && (
            <div className="mt-1 text-sm font-medium text-white">
              {formatFromPrice(pricing).replace(/^from/, "From")}
              {eurHintFor(pricing) && (
                <span className="font-normal text-white/50" title={eurRateNote()}>
                  {" "}({eurHintFor(pricing)})
                </span>
              )}
              {fareContext(pricing) && (
                <div className="text-xs font-normal text-white/50">
                  {fareContext(pricing)}
                </div>
              )}
            </div>
          )}
        </Fact>
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
