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

/**
 * The train number as the operator's own timetable site addresses it: the
 * first run of digits, with leading zeros dropped.
 *
 * Deliberately NOT extractTrainNumberDigits() from TrainDetailPanel — that one
 * matches /\d{3,5}/ and is a lookup key into the feed maps, so it must keep
 * returning "001" verbatim and must keep missing short numbers. Timetable sites
 * want the human number: Ukrainian Railways addresses train "001 D" as 1 and
 * "036 Š" as 36, and Back-on-Track writes compound labels ("IRN 1954/R 8824",
 * "IRN / IC 78", "1003 (G)") whose first number is the leg we link to.
 *
 * @param {string} value  raw trip_short_name
 * @returns {string} digits without leading zeros, or "" when there are none
 */
export function scheduleTrainNumber(value) {
  const match = String(value ?? "").match(/\d+/);
  return match ? String(Number(match[0])) : "";
}

/** dd.MM.yyyy for today — schedule links open on the current timetable. */
function todayDayMonthYear() {
  return formatDayMonthYear(new Date());
}

/**
 * Wrap an outbound URL in the operator's affiliate redirect when one is
 * configured. `affiliateWrapper` is a template carrying {target}, which is
 * substituted URL-encoded (the Effiliation shape SNCF already uses:
 * ...effi.redir?id_compteur=NNN&url={target}). Absent wrapper → URL unchanged,
 * so an operator without a programme links straight to its own site.
 */
function applyAffiliateWrapper(booking, url) {
  const wrapper = booking?.affiliateWrapper;
  if (!wrapper || !url) return url;
  return wrapper.replaceAll("{target}", encodeURIComponent(url));
}

/**
 * The operator's own timetable page for one train, at the finest granularity
 * that operator publishes. Tiered, most specific first:
 *
 *   1. schedulePages[routeId]      — a hand-mapped page for this exact route
 *                                    (European Sleeper's per-corridor pages,
 *                                    VIA Rail's per-route schedules)
 *   2. scheduleUrlTemplate {train} — the operator's per-train timetable
 *                                    (ČD /en/vlak/442, UZ's by-number search)
 *   3. scheduleCountryPages[cc]    — a per-country destinations page
 *                                    (nightjet.com/en/reiseziele/niederlande)
 *   4. scheduleUrl                 — the operator's timetable page
 *
 * Returns null when the operator has nothing configured, so callers render no
 * link rather than a link to a homepage that answers nothing.
 *
 * @param {object} args
 * @param {string} args.agencyId      single agency id (split compounds first)
 * @param {string} [args.train]       raw trip_short_name for this direction
 * @param {string} [args.routeId]     viewMap route_id
 * @param {string} [args.countryCode] ISO-2 the route is keyed to
 * @param {string} [args.date]        dd.MM.yyyy for templates carrying {date}
 * @returns {string|null}
 */
export function buildScheduleUrl(args) {
  return buildScheduleCandidate(args)?.url ?? null;
}

/** Schedule tiers, most specific first. Exported for the compound-id resolver. */
export const SCHEDULE_TIERS = ["route", "train", "country", "operator"];

/**
 * As buildScheduleUrl(), but also reports which tier matched so a compound
 * agency id can prefer one component's per-train link over another's operator
 * page. Returns { url, tier } or null.
 */
export function buildScheduleCandidate({
  agencyId,
  train,
  routeId,
  countryCode,
  originCountry,
  destCountry,
  date,
}) {
  const booking = getOperatorBooking(agencyId);
  if (!booking) return null;
  const wrap = (url, tier) => ({ url: applyAffiliateWrapper(booking, url), tier });

  const perRoute = routeId ? booking.schedulePages?.[String(routeId)] : null;
  if (perRoute) return wrap(perRoute, "route");

  const template = booking.scheduleUrlTemplate;
  if (template) {
    const number = scheduleTrainNumber(train);
    // A {train} template with no number would resolve to a search for nothing.
    if (number || !template.includes("{train}")) {
      return wrap(
        template
          .replaceAll("{train}", encodeURIComponent(number))
          .replaceAll("{date}", date || todayDayMonthYear()),
        "train",
      );
    }
  }

  const cc =
    countryCode ||
    pickScheduleCountry({ agencyId, originCountry, destCountry });
  const perCountry = cc
    ? booking.scheduleCountryPages?.[String(cc).toUpperCase()]
    : null;
  if (perCountry) return wrap(perCountry, "country");

  return booking.scheduleUrl ? wrap(booking.scheduleUrl, "operator") : null;
}

/** Link text for an operator's timetable link. */
export function getScheduleLabel(agencyId) {
  return getOperatorBooking(agencyId)?.scheduleLabel || "Official timetable";
}

/** True when the operator's schedule link carries affiliate tracking. */
export function isAffiliateSchedule(agencyId) {
  return Boolean(getOperatorBooking(agencyId)?.affiliateWrapper);
}

/**
 * Which country a per-country schedule page should be keyed to for one
 * direction of a route.
 *
 * These pages answer "where does this train go", so the destination wins —
 * except when the destination is the operator's own country, where the far end
 * is the interesting one. That is why Zürich→Amsterdam lands on Nightjet's
 * Netherlands page while Bruxelles→Wien lands on Belgium's rather than
 * Austria's. A route with both ends abroad (Stuttgart→Venezia) still follows
 * the destination.
 *
 * `homeCountry` is per operator in the curated table; without one the
 * destination is simply preferred.
 */
export function pickScheduleCountry({ agencyId, originCountry, destCountry }) {
  const home = getOperatorBooking(agencyId)?.homeCountry;
  const dest = (destCountry || "").toUpperCase();
  const origin = (originCountry || "").toUpperCase();
  if (dest && dest !== home) return dest;
  if (origin && origin !== home) return origin;
  return dest || origin || "";
}
