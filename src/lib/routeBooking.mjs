/**
 * Single decision point for a route's booking CTA, shared by the map's
 * TrainDetailPanel and the static /trains/[slug] SEO pages.
 *
 * North American operators (Amtrak / VIA) get their own URL builder (station
 * codes → route landing page → booking entry → homepage); everyone else goes
 * through the tiered compound-agency resolution in operatorAgencies.mjs
 * (origin/dest deep link → curated booking page → BoT booking portal →
 * operator homepage).
 *
 * Returns a plain serializable object so getStaticProps can pass it straight
 * into page props: { href, preselects, sellerName, dealsUrl, dealsLabel }.
 * Returns null when there is nothing to link to, so callers render nothing.
 *
 * .mjs so the raw-node verify suite (tests/verify-seo-booking.mjs) can import
 * it, same as operatorAgencies.mjs and naBooking.mjs.
 */
import { resolveBookingHref } from "./operatorAgencies.mjs";
import {
  buildNorthAmericaBookingUrl,
  isNorthAmericaAgency,
} from "./naBooking.mjs";
import { getDealsLink } from "./operatorBooking.js";

/**
 * @param {object} args
 * @param {string} args.agencyId - viewMap agency_id, possibly compound ("PKP/ČD")
 * @param {object} [args.agencies] - BoT agencies map (agency_id → record); may be empty
 * @param {string|null} [args.agencyUrl] - last-ditch homepage fallback for the whole id
 * @param {string} [args.origin] - departure station name (deep-link preselection)
 * @param {string} [args.dest] - arrival station name (deep-link preselection)
 * @param {string} [args.routeId] - route id, used for NA per-route landing pages
 * @param {{name:string, code?:string|null}[]} [args.scheduleStops] - stops with GTFS codes (NA deep links)
 * @param {string} [args.isoDate] - "YYYY-MM-DD", the night to open on, for an
 *   operator whose deep link takes a date (the planner knows the night; the
 *   connection page does not, and leaves it out)
 * @returns {{ href: string|null, preselects: boolean, sellerName: string|null,
 *             dealsUrl: string|null, dealsLabel: string|null } | null}
 */
export function resolveRouteBooking({
  agencyId,
  agencies,
  agencyUrl,
  origin,
  dest,
  routeId,
  scheduleStops,
  isoDate,
}) {
  let href = null;
  let deepLink = null;
  let deals = null;
  let sellerName = null;

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
    deals = getDealsLink(agencyId);
  } else {
    const resolved = resolveBookingHref({
      agencyId,
      agencies,
      agencyUrl,
      origin,
      dest,
      routeId,
      isoDate,
    });
    href = resolved.href;
    deepLink = resolved.deepLink;
    deals = resolved.dealsLink;
    // Name the seller when the id is compound so the user knows which
    // operator's shop the button opens.
    if (resolved.componentName && (agencyId || "").includes("/")) {
      sellerName = resolved.componentName;
    }
  }

  if (!href && !deals) return null;

  return {
    href: href ?? null,
    preselects: Boolean(deepLink),
    sellerName: sellerName ?? null,
    dealsUrl: deals?.url ?? null,
    dealsLabel: deals?.label ?? null,
  };
}
