/**
 * Operator booking links: per-operator deep-link templates that let us open the
 * operator's booking site with the origin/destination stations preselected
 * (e.g. ÖBB shop ?stationOrigName=Amsterdam&stationDestName=Basel).
 *
 * Data lives in data/overrides/operator-booking.json (editable through the
 * admin panel). Each entry is keyed by agency_id and may hold:
 *   - urlTemplate: deep link with {origin}/{dest} placeholders (or null)
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

/**
 * Build a deep-link booking URL with preselected origin/destination.
 *
 * Returns null when the operator has no urlTemplate, so the caller can fall
 * back to the generic operator homepage (agency_url).
 *
 * Some operators (e.g. European Sleeper) need their own numeric station codes,
 * not names. For those we set `requireStationMapping: true`: if either station
 * has no code mapping, we return null so the caller falls back to the homepage
 * instead of building a broken deep link.
 */
export function buildBookingUrl({ agencyId, origin, dest }) {
  const booking = getOperatorBooking(agencyId);
  if (!booking?.urlTemplate) return null;

  const o = lookupStationName(booking, origin);
  const d = lookupStationName(booking, dest);

  if (booking.requireStationMapping && (!o.mapped || !d.mapped)) return null;

  return booking.urlTemplate
    .replaceAll("{origin}", encodeURIComponent(o.value))
    .replaceAll("{dest}", encodeURIComponent(d.value));
}

/**
 * Format an ISO timestamp as the Central-European local `YYYY-MM-DDTHH:MM` the
 * ÖBB shop expects for connection deep links.
 *
 * NightJet/EuroNight stop times are stored as true UTC ISO strings; the ÖBB
 * shop wants the station's local wall-clock time. The whole NJ/EN network runs
 * in Central European Time, so Europe/Vienna (DST-aware) gives the correct
 * local time at every stop regardless of the viewer's own timezone.
 */
function toCentralEuropeanLocalDatetime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let hour = get("hour");
  const minute = get("minute");
  if (!year || !month || !day || hour == null || minute == null) return null;
  // en-GB renders midnight as "24" in some engines; normalize to "00".
  if (hour === "24") hour = "00";
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Resolve one of our station names to the matching stop in a train's ordered
 * stop list. Match is tolerant (trimmed, case-insensitive); returns the index
 * or -1 when there's no match so callers can fall back to an endpoint.
 */
function findStationIndex(stations, name) {
  if (!name) return -1;
  const target = String(name).trim().toLowerCase();
  if (!target) return -1;
  return stations.findIndex(
    (s) => String(s?.name || "").trim().toLowerCase() === target,
  );
}

const EVA_CODE = /^\d+$/;

/**
 * Build a deep link that opens a *specific connection* on the operator's
 * booking site (currently ÖBB), rather than a name-prefilled search.
 *
 * Needs the operator's `connectionUrlTemplate` plus a `stations` array carrying
 * numeric EVA station ids and ISO departure/arrival times (the NightJet/EuroNight
 * schedule shape: `[{ id, name, arrival, departure }]`). We pick the origin/dest
 * stops by name (falling back to the train's endpoints), then substitute the EVA
 * codes and the Central-European local departure/arrival datetimes.
 *
 * Returns null whenever we lack the template or the data (no numeric EVA at an
 * endpoint, missing times, unusable order) so the caller can fall back to the
 * name-based `buildBookingUrl`.
 */
export function buildConnectionBookingUrl({ agencyId, stations, origin, dest }) {
  const booking = getOperatorBooking(agencyId);
  if (!booking?.connectionUrlTemplate) return null;
  if (!Array.isArray(stations) || stations.length < 2) return null;

  const originIdx = (() => {
    const i = findStationIndex(stations, origin);
    return i >= 0 ? i : 0;
  })();
  const destIdx = (() => {
    const i = findStationIndex(stations, dest);
    return i > originIdx ? i : stations.length - 1;
  })();
  if (destIdx <= originIdx) return null;

  const originStop = stations[originIdx];
  const destStop = stations[destIdx];

  const origEva = String(originStop?.id ?? "");
  const destEva = String(destStop?.id ?? "");
  if (!EVA_CODE.test(origEva) || !EVA_CODE.test(destEva)) return null;

  const depLocal = toCentralEuropeanLocalDatetime(
    originStop?.departure || originStop?.arrival,
  );
  const arrLocal = toCentralEuropeanLocalDatetime(
    destStop?.arrival || destStop?.departure,
  );
  if (!depLocal || !arrLocal) return null;

  return booking.connectionUrlTemplate
    .replaceAll("{origEva}", origEva)
    .replaceAll("{destEva}", destEva)
    .replaceAll("{depLocal}", depLocal)
    .replaceAll("{arrLocal}", arrLocal);
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
