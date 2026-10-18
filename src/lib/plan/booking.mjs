/**
 * The Book button on a planner ride.
 *
 * Someone who already knows where they are going came to buy a ticket, and
 * sending them through the connection page to find the button is one page too
 * many. This is the same resolution that page's CTA uses (resolveRouteBooking),
 * with two differences that only the planner can supply: the stations are the
 * ones the traveller BOARDS and LEAVES at, which on a mid-route ride are not the
 * train's endpoints, and the night is the plan's own, for an operator whose link
 * takes a date (European Sleeper, SJ, Trenitalia's optional one). An operator
 * whose link takes neither falls back to its booking page exactly as it does on
 * the connection page, and `preselects` says which of the two the traveller got.
 *
 * .mjs and dependency-light so tests/verify-plan.mjs can call it in raw node.
 */
import { resolveRouteBooking } from "../routeBooking.mjs";

/**
 * @param {object} ride - a ride from search.mjs (rideFor)
 * @returns {{href: string, preselects: boolean, sellerName: string|null}|null}
 */
export function rideBookingLink(ride) {
  if (!ride) return null;
  const agencyId = ride.agencyId || (ride.operatorIds || []).join("/");
  if (!agencyId) return null;
  const booking = resolveRouteBooking({
    agencyId,
    origin: ride.from?.station || "",
    dest: ride.to?.station || "",
    routeId: ride.routeId != null ? String(ride.routeId) : undefined,
    isoDate: ride.date || undefined,
  });
  if (!booking?.href) return null;
  return {
    href: booking.href,
    preselects: booking.preselects,
    sellerName: booking.sellerName,
  };
}
