"use client";

import React from "react";
import { FiExternalLink } from "react-icons/fi";
import {
  buildBookingUrl,
  buildConnectionBookingUrl,
  getDealsLink,
  getBookingPageUrl,
} from "../../lib/operatorBooking";
import {
  buildNorthAmericaBookingUrl,
  isNorthAmericaAgency,
} from "../../lib/naBooking.mjs";
import { formatFromPrice } from "../../lib/operatorPricing";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";

/**
 * Booking section shown at the bottom of each trip card.
 *
 * - Primary CTA deep-links to the operator's booking site with the origin and
 *   destination preselected. If we have no deep-link template for the operator,
 *   it falls back to the generic operator homepage (agencyUrl) — same behavior
 *   as before this feature.
 * - When a deep link is used, a small caption shows which stations will be
 *   prefilled so the user knows what to expect.
 * - A fare line shows the live price (future) or the fixed "from" price.
 * - An optional secondary "deals" link surfaces flexible/last-minute fares.
 *
 * Kept in its own file so the already-large TrainDetailPanel stays lean.
 */
export default function BookingActions({
  agencyId,
  agencyUrl,
  origin,
  dest,
  pricing,
  livePrice, // reserved for future live-price fetching; unused for now
  routeId,
  scheduleStops,
  bookingStations,
}) {
  let deepLink = null;
  let href = null;

  if (isNorthAmericaAgency(agencyId)) {
    const na = buildNorthAmericaBookingUrl({
      agencyId,
      routeId,
      origin,
      dest,
      scheduleStops,
    });
    href = na.url;
    if (na.isStationDeepLink) deepLink = na.url;
  } else {
    // Prefer a precise connection deep link (e.g. ÖBB shop opening the exact
    // train) when we have EVA codes + times; otherwise fall back to the
    // name-prefilled search, then the operator's booking/homepage.
    const connLink = buildConnectionBookingUrl({
      agencyId,
      stations: bookingStations,
      origin,
      dest,
    });
    deepLink = connLink || buildBookingUrl({ agencyId, origin, dest });
    const bookingPageUrl = getBookingPageUrl(agencyId);
    href = deepLink || bookingPageUrl || agencyUrl || null;
  }

  const dealsLink = getDealsLink(agencyId);

  // Fare to show next to the button: prefer a live price once available,
  // otherwise fall back to the curated fixed "from" price.
  const fareLabel = livePrice || formatFromPrice(pricing);

  // Nothing to link to and nothing to show — render nothing.
  if (!href && !dealsLink) return null;

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

      {/* Caption: which stations are prefilled (deep link only) */}
      {deepLink && origin && dest && (
        <div className="text-center text-xs text-gray-500">
          Preselects {abbreviateStationName(origin)} {"->"}{" "}
          {abbreviateStationName(dest)}
        </div>
      )}

      {/* Secondary: flexible / last-minute deals */}
      {dealsLink && (
        <a
          href={dealsLink.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group block w-full text-center text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline py-1"
        >
          <span className="inline-flex items-center gap-1">
            {dealsLink.label}&nbsp;
            <FiExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </span>
        </a>
      )}
    </div>
  );
}
