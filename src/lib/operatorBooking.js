/**
 * Operator booking links: per-operator deep-link templates that let us open the
 * operator's booking site with the origin/destination stations preselected
 * (e.g. ÖBB shop ?stationOrigName=Amsterdam&stationDestName=Basel).
 *
 * Data lives in data/overrides/operator-booking.json (editable through the
 * admin panel). Each entry is keyed by agency_id and may hold:
 *   - urlTemplate: deep link with {origin}/{dest} placeholders (or null).
 *     Optional extras: {originName}/{destName} (our display names, not the
 *     mapped codes) and {date} (dd.MM.yyyy, default +7 days). Replace the
 *     longer name placeholders first so "{origin}" cannot eat "{originName}".
 *   - dealsUrl / dealsLabel: optional secondary "last-minute deals" link
 *   - stationNames: map of our station name -> the booking site's expected name
 *
 * This mirrors operatorPricing.js: the JSON is bundled at build time (no API),
 * so admin edits go live on the next deploy.
 */
import OPERATOR_BOOKING from "../../data/overrides/operator-booking.json" with { type: "json" };

export { OPERATOR_BOOKING };

/**
 * Resolve the booking config for an operator by agency_id.
 * Returns null when we have nothing configured so callers render a fallback.
 */
export function getOperatorBooking(agencyId) {
  const id = (agencyId || "").trim();
  return OPERATOR_BOOKING[id] || null;
}

/**
 * Look up the name the booking site expects for one of our station names.
 * Returns { value, mapped } so callers know whether a curated mapping existed.
 * Falls back to the original name when there's no mapping.
 */
function lookupStationName(booking, name) {
  if (!name) return { value: "", mapped: false };
  const mapped = booking?.stationNames?.[name];
  if (mapped != null) return { value: mapped, mapped: true };
  return { value: name, mapped: false };
}

/** dd.MM.yyyy — Leo Express search-results date format. */
function formatDayMonthYear(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function defaultBookingDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return formatDayMonthYear(d);
}

/**
 * Build a deep-link booking URL with preselected origin/destination.
 *
 * Returns null when the operator has no urlTemplate, so the caller can fall
 * back to the generic operator homepage (agency_url).
 *
 * Some operators (e.g. European Sleeper, Leo Express) need their own station
 * codes, not names. For those we set `requireStationMapping: true`: if either
 * station has no code mapping, we return null so the caller falls back to the
 * homepage instead of building a broken deep link.
 *
 * @param {object} args
 * @param {string} [args.date] - optional dd.MM.yyyy for templates with {date}
 */
export function buildBookingUrl({ agencyId, origin, dest, date }) {
  const booking = getOperatorBooking(agencyId);
  if (!booking?.urlTemplate) return null;

  const o = lookupStationName(booking, origin);
  const d = lookupStationName(booking, dest);

  if (booking.requireStationMapping && (!o.mapped || !d.mapped)) return null;

  // Longer placeholders first: "{origin}" must not consume "{originName}".
  return booking.urlTemplate
    .replaceAll("{originName}", encodeURIComponent(origin || ""))
    .replaceAll("{destName}", encodeURIComponent(dest || ""))
    .replaceAll("{origin}", encodeURIComponent(o.value))
    .replaceAll("{dest}", encodeURIComponent(d.value))
    .replaceAll("{date}", date || defaultBookingDate());
}

/**
 * Optional "last-minute deals" link for operators that promote flexible fares
 * (e.g. European Sleeper). Returns { url, label } or null.
 */
export function getDealsLink(agencyId) {
  const booking = getOperatorBooking(agencyId);
  if (!booking?.dealsUrl) return null;
  return {
    url: booking.dealsUrl,
    label: booking.dealsLabel || "View deals",
  };
}

/**
 * Returns a curated booking-page URL for operators that lack a deep-link
 * template but have a better entry point than their generic agency homepage
 * (e.g. SNCF booking is sncf-connect.com, not sncf.com; MÁV is jegy.mav.hu).
 * Returns null when nothing is configured so callers fall back to agencyUrl.
 */
export function getBookingPageUrl(agencyId) {
  const booking = getOperatorBooking(agencyId);
  return booking?.bookingPageUrl ?? null;
}
