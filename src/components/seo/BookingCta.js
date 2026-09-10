import { FiExternalLink } from "react-icons/fi";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";

/**
 * Booking CTA for the static route pages, fed by the build-time resolved
 * `detail.booking` (src/lib/seo/data.js → resolveRouteBooking). Dark-theme
 * counterpart of the map panel's BookingActions: a primary button opens the
 * operator's shop, a muted caption says what to expect (curated "from" price,
 * preselected stations, or which operator's shop opens for jointly-operated
 * trains), and an optional secondary link surfaces last-minute deals.
 *
 * Outbound booking links may carry referral tags, so they are marked
 * rel="sponsored nofollow". `compact` renders the button alone for CTA rows.
 *
 * `advice` is pricingAdvice() for the route's operator; when present the CTA
 * also says whether booking early is what makes this ticket cheap.
 */
export default function BookingCta({
  booking,
  origin,
  destination,
  advice = null,
  compact = false,
}) {
  if (!booking || (!booking.href && !booking.dealsUrl)) return null;

  const captionParts = [];
  if (booking.fromPrice) captionParts.push(booking.fromPrice);
  if (booking.preselects && origin && destination) {
    captionParts.push(
      `preselects ${abbreviateStationName(origin)} → ${abbreviateStationName(destination)}`,
    );
  } else if (booking.sellerName && booking.href) {
    captionParts.push(`opens ${booking.sellerName}`);
  }
  const joined = captionParts.join(" · ");
  const caption = joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : "";

  // Whether to buy now or later is the question a reader has WHILE looking at
  // this button, and the two pricing models answer it in opposite directions.
  // Its own line, not appended to the caption above: that line is about which
  // shop opens and what it costs, and burying "fares rise" in it would lose it.
  const timing = advice ? `${advice.headline} — ${advice.short}.` : "";

  const button = booking.href && (
    <a
      href={booking.href}
      target="_blank"
      rel="sponsored nofollow noopener noreferrer"
      className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-semibold text-sm transition-colors"
    >
      Book tickets
      <FiExternalLink className="w-4 h-4" aria-hidden />
    </a>
  );

  if (compact) return button;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {button}
        {booking.dealsUrl && (
          <a
            href={booking.dealsUrl}
            target="_blank"
            rel="sponsored nofollow noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-green hover:text-primary-green-light transition-colors"
          >
            {booking.dealsLabel || "View deals"}
            <FiExternalLink className="w-3.5 h-3.5" aria-hidden />
          </a>
        )}
      </div>
      {caption && <p className="mt-2 text-xs text-white/50">{caption}</p>}
      {timing && (
        <p className="mt-1 text-xs text-white/70 text-pretty">{timing}</p>
      )}
    </div>
  );
}
