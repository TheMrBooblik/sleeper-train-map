"use client";

import React from "react";
import { FiExternalLink } from "react-icons/fi";
import { resolveRouteBooking } from "../../lib/routeBooking.mjs";
import { formatFromPrice } from "../../lib/operatorPricing";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";

/**
 * Booking section shown at the bottom of each trip card.
 *
 * - Primary CTA deep-links to the operator's booking site with the origin and
 *   destination preselected. Compound agency ids ("PKP/ČD") are resolved per
 *   component operator, tiered by link quality: deep link → curated booking
 *   page → BoT booking portal (agency_fare_url) → operator homepage — so every
 *   route gets a booking CTA. For compounds, a caption names the operator
 *   whose shop opens.
 * - When a deep link is used, a small caption shows which stations will be
 *   prefilled so the user knows what to expect.
 * - A fare line shows the live price (future) or the fixed "from" price.
 * - An optional secondary "deals" link surfaces flexible/last-minute fares.
 *
 * Kept in its own file so the already-large TrainDetailPanel stays lean.
 */
export default function BookingActions({
  agencyId,
  agencies,
  agencyUrl,
  origin,
  dest,
  pricing,
  livePrice, // reserved for future live-price fetching; unused for now
  routeId,
  scheduleStops,
}) {
  const booking = resolveRouteBooking({
    agencyId,
    agencies,
    agencyUrl,
    origin,
    dest,
    routeId,
    scheduleStops,
  });

  // Nothing to link to and nothing to show — render nothing.
  if (!booking) return null;
  const { href, preselects, sellerName, dealsUrl, dealsLabel } = booking;

  // Fare to show next to the button: prefer a live price once available,
  // otherwise fall back to the curated fixed "from" price.
  const fareLabel = livePrice || formatFromPrice(pricing);

  return (
    <div className="space-y-1.5">
      {/* Fare line (only when we have a concrete price) */}
      {fareLabel && (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-gray-500 uppercase">Fare</span>
          <span className="text-sm font-semibold text-gray-900">
            {fareLabel}
          </span>
        </div>
      )}

      {/* Primary CTA */}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="group block w-full text-center bg-slate-100 text-slate-800 py-2.5 px-3 rounded-md border border-slate-200 hover:bg-slate-200 hover:border-slate-300 active:translate-y-px transition-all duration-150 text-sm font-semibold"
        >
          <span className="inline-flex items-center gap-1">
            Book / view details&nbsp;
            <FiExternalLink
              className="h-4 w-4 shrink-0 text-slate-500 transition-all duration-300 ease-out group-hover:text-slate-800 translate-x-0.5 -translate-y-px group-hover:translate-x-1 group-hover:-translate-y-0.5"
              aria-hidden
            />
          </span>
        </a>
      )}

      {/* Caption: which stations are prefilled (deep link only), and for
          jointly-operated trains which operator's shop the button opens */}
      {preselects && origin && dest && (
        <div className="text-center text-xs text-gray-500">
          Preselects {abbreviateStationName(origin)} {"->"}{" "}
          {abbreviateStationName(dest)}
        </div>
      )}
      {!preselects && sellerName && href && (
        <div className="text-center text-xs text-gray-500">
          Opens {sellerName}
        </div>
      )}

      {/* Secondary: flexible / last-minute deals */}
      {dealsUrl && (
        <a
          href={dealsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group block w-full text-center text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline py-1"
        >
          <span className="inline-flex items-center gap-1">
            {dealsLabel || "View deals"}&nbsp;
            <FiExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </span>
        </a>
      )}
    </div>
  );
}
