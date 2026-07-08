/**
 * North American (Amtrak / VIA Rail) booking URL builder.
 *
 * Priority for the single primary CTA:
 *   1. Amtrak station search (GTFS stop codes when both endpoints resolve)
 *   2. Curated route landing page (routePages in operator-booking.json)
 *   3. Operator generic booking entry (bookingPageUrl)
 *   4. Operator homepage fallback
 */
import {
  getOperatorBooking,
  getBookingPageUrl,
} from "./operatorBooking.js";

const NA_HOMEPAGES = {
  AMTK: "https://www.amtrak.com",
  VIA: "https://www.viarail.ca",
};

export function isNorthAmericaAgency(agencyId) {
  const id = (agencyId || "").trim();
  return id === "AMTK" || id === "VIA";
}

function normStationName(name) {
  return (name || "").trim().toLowerCase();
}

/**
 * Match a display station name to a GTFS stop code from the loaded schedule.
 */
export function resolveStationCode(stops, stationName) {
  if (!stationName || !stops?.length) return null;
  const target = normStationName(stationName);
  for (const stop of stops) {
    if (normStationName(stop.name) === target && stop.code) {
      return stop.code;
    }
  }
  return null;
}

export function getRoutePageUrl(agencyId, routeId) {
  const booking = getOperatorBooking(agencyId);
  const id = (routeId || "").trim();
  if (!id || !booking?.routePages) return null;
  return booking.routePages[id] ?? null;
}

function buildAmtrakStationSearchUrl({ origin, dest, scheduleStops }) {
  const booking = getOperatorBooking("AMTK");
  if (!booking?.urlTemplate) return null;

  const originCode = resolveStationCode(scheduleStops, origin);
  const destCode = resolveStationCode(scheduleStops, dest);
  if (!originCode || !destCode) return null;

  return booking.urlTemplate
    .replaceAll("{origin}", encodeURIComponent(originCode))
    .replaceAll("{dest}", encodeURIComponent(destCode));
}

/**
 * @returns {{ url: string|null, isStationDeepLink: boolean }}
 */
export function buildNorthAmericaBookingUrl({
  agencyId,
  routeId,
  origin,
  dest,
  scheduleStops,
}) {
  const id = (agencyId || "").trim();
  if (!isNorthAmericaAgency(id)) {
    return { url: null, isStationDeepLink: false };
  }

  if (id === "AMTK") {
    const stationUrl = buildAmtrakStationSearchUrl({
      origin,
      dest,
      scheduleStops,
    });
    if (stationUrl) {
      return { url: stationUrl, isStationDeepLink: true };
    }
  }

  const routePage = getRoutePageUrl(id, routeId);
  if (routePage) {
    return { url: routePage, isStationDeepLink: false };
  }

  const bookingPage = getBookingPageUrl(id);
  if (bookingPage) {
    return { url: bookingPage, isStationDeepLink: false };
  }

  return { url: NA_HOMEPAGES[id] ?? null, isStationDeepLink: false };
}
