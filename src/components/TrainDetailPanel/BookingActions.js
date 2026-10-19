"use client";

import React from "react";
import { FiExternalLink, FiZap } from "react-icons/fi";
import { resolveRouteBooking } from "../../lib/routeBooking.mjs";
import { formatFromPrice } from "../../lib/operatorPricing";
import {
  fareClassLabel,
  formatTravelDateShort,
} from "../../lib/fareClasses.mjs";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";
import { eurHintFor, eurRateNote } from "../../lib/fx.mjs";

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
  // The train's cheapest promotional deal, sold from the operator's own
  // deals page rather than its booking search (European Sleeper's last-minute
  // pages): { label, price, date, href, best }. Shown here, beside that link,
  // and kept out of the fare chips above — see TrainDetailPanel.
  deal = null,
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
  // Which berth that "from" buys — a sleeper's cheapest fare is a specific
  // bed, and "from ¥335.5" alone reads as the price of any of them.
  const fareClass = livePrice ? "" : fareClassLabel(pricing?.seatClass);
  // …and for which night, when the figure is one date's (a dynamic fare).
  const fareDate =
    livePrice || pricing?.type !== "dynamic"
      ? ""
      : formatTravelDateShort(pricing?.travelDate);

  return (
    <div className="space-y-1.5">
      {/* Fare line (only when we have a concrete price) */}
      {/* One line of text, not a flex row: as flex items each piece shrank
          into its own column and wrapped inside itself ("from / €69.99"). As
          inline text a narrow panel wraps between whole pieces instead. */}
      {fareLabel && (
        <div data-testid="fare-line">
          <span className="mr-1.5 text-xs text-gray-500 dark:text-zinc-400 uppercase">Fare</span>
          <span className="whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-zinc-100">
            {fareLabel}
          </span>
          {fareClass && (
            <span className="whitespace-nowrap text-xs text-gray-500 dark:text-zinc-400">
              {" "}
              · {fareClass.toLowerCase()}
            </span>
          )}
          {fareDate && (
            <span className="whitespace-nowrap text-xs text-gray-500 dark:text-zinc-400">
              {" "}
              · {fareDate}
            </span>
          )}
          {!livePrice && eurHintFor(pricing) && (
            <span
              className="block text-xs text-gray-500 dark:text-zinc-400"
              title={eurRateNote()}
            >
              ({eurHintFor(pricing)})
            </span>
          )}
        </div>
      )}

      {/* Primary CTA */}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="group block w-full text-center bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-zinc-200 py-2.5 px-3 rounded-md border border-slate-200 dark:border-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-700 hover:border-slate-300 dark:hover:border-zinc-600 active:translate-y-px transition-all duration-150 text-sm font-semibold"
        >
          <span className="inline-flex items-center gap-1">
            Book / view details&nbsp;
            <FiExternalLink
              className="h-4 w-4 shrink-0 text-slate-500 dark:text-zinc-400 transition-all duration-300 ease-out group-hover:text-slate-800 dark:group-hover:text-zinc-200 translate-x-0.5 -translate-y-px group-hover:translate-x-1 group-hover:-translate-y-0.5"
              aria-hidden
            />
          </span>
        </a>
      )}

      {/* Caption: which stations are prefilled (deep link only), and for
          jointly-operated trains which operator's shop the button opens */}
      {preselects && origin && dest && (
        <div className="text-center text-xs text-gray-500 dark:text-zinc-400">
          Preselects {abbreviateStationName(origin)} {"->"}{" "}
          {abbreviateStationName(dest)}
        </div>
      )}
      {!preselects && sellerName && href && (
        <div className="text-center text-xs text-gray-500 dark:text-zinc-400">
          Opens {sellerName}
        </div>
      )}

      {/* The deal itself, where the source found one: what it is, when, and
          how it compares, linking to the page that sells it. */}
      {deal && (deal.href || dealsUrl) && (
        <a
          href={deal.href || dealsUrl}
          target="_blank"
          rel="sponsored nofollow noopener noreferrer"
          className="group block rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 hover:border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          data-testid="panel-deal"
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            <FiZap className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">
              {deal.programme === "flashSale" ? "Flash sale" : "Last-minute deal"}
            </span>
            {deal.best && (
              <span className="whitespace-nowrap rounded-full bg-amber-400 px-1.5 py-px text-[10px] text-black">
                Cheapest
              </span>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-sm text-gray-800 dark:text-zinc-200">
            <span>{deal.label}</span>
            <span className="font-semibold text-gray-900 dark:text-zinc-100">{deal.price}</span>
            {deal.date && <span className="text-xs text-gray-500 dark:text-zinc-400">· {deal.date}</span>}
          </span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200 group-hover:underline">
            Not in the regular booking search — get it here
            <FiExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </span>
        </a>
      )}

      {/* Secondary: flexible / last-minute deals */}
      {dealsUrl && !deal && (
        <a
          href={dealsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group block w-full text-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline py-1"
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
