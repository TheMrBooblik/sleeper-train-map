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
 *   - dateFormat: "yyyy-MM-dd" for a site that wants ISO dates in {date}
 *     (sj.se's journey search: /search-journey/.../Luleå Central/Stockholm
 *     Central/2026-09-27/...), "dd-MM-yyyy" for lefrecce.it's minisite;
 *     absent means dd.MM.yyyy.
 *   - urlDateSuffix: appended to urlTemplate ONLY when the caller names a
 *     night (e.g. "&departureDate={date}"), for a link that takes an optional
 *     date: the plain CTA keeps opening the operator's own default, and a
 *     night picked on the fare calendar opens on that night.
 *   - dateOffsetDays: the default {date} when the caller names none (default 7).
 *   - dealsUrl / dealsLabel: optional secondary "last-minute deals" link
 *   - stationNames: map of our station name -> the booking site's expected name
 *
 * This mirrors operatorPricing.js: the JSON is bundled at build time (no API),
 * so admin edits go live on the next deploy.
 */
import { splitAgencyIds } from "./seo/operatorNames.mjs";
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

function formatDashedDayMonthYear(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function formatIsoDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** A date in the shape the operator's template wants. */
function formatBookingDate(booking, d) {
  if (booking?.dateFormat === "yyyy-MM-dd") return formatIsoDate(d);
  if (booking?.dateFormat === "dd-MM-yyyy") return formatDashedDayMonthYear(d);
  return formatDayMonthYear(d);
}

function defaultBookingDate(booking) {
  const d = new Date();
  const offset = Number.isFinite(booking?.dateOffsetDays) ? booking.dateOffsetDays : 7;
  d.setDate(d.getDate() + offset);
  return formatBookingDate(booking, d);
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
 * @param {string} [args.isoDate] - optional "YYYY-MM-DD", formatted the way the
 *   operator's template wants — a specific night, such as one on which the
 *   train runs a different timetable
 */
export function buildBookingUrl({ agencyId, origin, dest, date, isoDate }) {
  const booking = getOperatorBooking(agencyId);
  if (!booking?.urlTemplate) return null;

  const o = lookupStationName(booking, origin);
  const d = lookupStationName(booking, dest);

  if (booking.requireStationMapping && (!o.mapped || !d.mapped)) return null;

  const named = date || isoBookingDate(booking, isoDate);
  let template = booking.urlTemplate;
  if (named && booking.urlDateSuffix && !template.includes("{date}")) {
    template += booking.urlDateSuffix;
  }
  // Longer placeholders first: "{origin}" must not consume "{originName}".
  return template
    .replaceAll("{originName}", encodeURIComponent(origin || ""))
    .replaceAll("{destName}", encodeURIComponent(dest || ""))
    .replaceAll("{origin}", encodeURIComponent(o.value))
    .replaceAll("{dest}", encodeURIComponent(d.value))
    .replaceAll("{date}", named || defaultBookingDate(booking));
}

/**
 * A booking link that opens on a night of the caller's choosing, for the fare
 * calendar: { template, dateFor } where `template` is the deep link with a
 * literal "{date}" left in it and `dateFor(iso)` the night as that link wants
 * it — so a page carries one URL and a short date per night instead of a full
 * URL for each of six weeks. Tries each component of a compound agency id in
 * turn. null when no operator's link takes a date (the caller then links to
 * the route's ordinary booking page and says the night must be chosen there).
 */
export function buildDatedBookingLink({ agencyId, origin, dest }) {
  for (const id of splitAgencyIds(agencyId)) {
    const booking = getOperatorBooking(id);
    const template = booking?.urlTemplate;
    if (!template || !(template.includes("{date}") || booking.urlDateSuffix)) continue;
    const url = buildBookingUrl({ agencyId: id, origin, dest, date: "{date}" });
    if (!url) continue;
    return { template: url, dateFor: (iso) => isoBookingDate(booking, iso) };
  }
  return null;
}

function isoBookingDate(booking, isoDate) {
  const m = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return formatBookingDate(booking, new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
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
 * Whether ANY component of a (possibly compound) agency id publishes a
 * last-minute deals page — the first-party evidence behind pricingAdvice()'s
 * caveat, so the advice next to a "Last-minute deals" link never contradicts it.
 *
 * Splits the id for the same reason everything else here does: a joint service
 * is recorded as "PKP/ČD", and getOperatorBooking() only knows single ids.
 */
export function hasLastMinuteDeals(agencyId) {
  return splitAgencyIds(agencyId).some((id) => !!getOperatorBooking(id)?.dealsUrl);
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
 * Epoch milliseconds of today's midnight in `timeZone`.
 *
 * Viaggiatreno addresses a train by its departure day as a timestamp
 * (datapartenza=1788818400000 is 00:00 on 8 Sep 2026 in Rome), and the railway
 * day is the operator's local one — taking UTC midnight would point at the
 * previous day's train for the two hours either side of it.
 *
 * Derived from Intl rather than a fixed offset so DST is handled: format the
 * instant in the zone, read back how far that is from UTC, and subtract.
 */
function localMidnightMs(timeZone, now = new Date()) {
  if (!timeZone) return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const at = (instant) => {
    const p = Object.fromEntries(
      fmt.formatToParts(instant).map(({ type, value }) => [type, value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  // formatToParts resolves to whole seconds, so compare against a whole-second
  // instant — otherwise the current time's milliseconds leak into the offset
  // and out into the timestamp, which must land exactly on midnight.
  const nowMs = Math.floor(now.getTime() / 1000) * 1000;
  // How far the zone runs ahead of UTC at this instant.
  const offset = at(new Date(nowMs)) - nowMs;
  const local = new Date(nowMs + offset);
  const utcMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  // Re-read the offset at the target midnight: a DST change between now and
  // then would otherwise shift it by an hour.
  const midnightOffset = at(new Date(utcMidnight - offset)) - (utcMidnight - offset);
  return utcMidnight - midnightOffset;
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
  // Some operators' links are stored already wrapped, because the redirect
  // takes a site-relative path that no longer exists once the value is a full
  // URL (European Sleeper's u=%2Ftimetable). Wrapping those again would send
  // the visitor through the redirect twice, so declaring the wrapper stays
  // safe: it marks the operator's links as affiliate and still wraps any plain
  // URL, while a value that already starts with the redirect is left alone.
  const prefix = wrapper.split("{target}")[0];
  if (prefix && url.startsWith(prefix)) return url;
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
export const SCHEDULE_TIERS = ["train-page", "route", "train", "country", "operator"];

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
  originCode,
  date,
}) {
  const booking = getOperatorBooking(agencyId);
  if (!booking) return null;
  const wrap = (url, tier) => ({ url: applyAffiliateWrapper(booking, url), tier });

  // Most specific of all: the operator's own page for THIS train, by whatever
  // id that operator addresses it with. Ukrainian Railways numbers a train 099
  // but reaches its timetable at ?ntrain=105997&by_id=1 — an internal id that
  // is not derivable from the number, so it has to be recorded rather than
  // built. It beats schedulePages[routeId], which is one page for a whole line
  // (Norway's PDFs) and therefore cannot name a direction: 099 and 100 are
  // opposite directions of one route and have separate pages.
  //
  // Keyed by the normalised number, like scheduleUrlTemplate's {train}, and the
  // map lives inside one operator's record — which is what makes a bare number
  // safe here, the collision this repo keeps meeting being across operators.
  const perTrain = booking.scheduleTrainPages;
  if (perTrain) {
    const number = scheduleTrainNumber(train);
    const hit = number ? perTrain[number] : null;
    if (hit) return wrap(hit, "train-page");
  }

  const perRoute = routeId ? booking.schedulePages?.[String(routeId)] : null;
  if (perRoute) return wrap(perRoute, "route");

  const template = booking.scheduleUrlTemplate;
  if (template) {
    const number = scheduleTrainNumber(train);
    // Every placeholder the template names has to be fillable, or the link goes
    // somewhere emptier than the page we would otherwise fall back to: a
    // {train} search for nothing, or Viaggiatreno's cercaTreno with no origin.
    const needs = (ph) => template.includes(ph);
    const satisfied =
      (number || !needs("{train}")) && (originCode || !needs("{originCode}"));
    if (satisfied) {
      return wrap(
        template
          .replaceAll("{train}", encodeURIComponent(number))
          .replaceAll("{originCode}", encodeURIComponent(originCode || ""))
          .replaceAll("{dateMs}", String(localMidnightMs(booking.scheduleTimeZone)))
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

/**
 * Link text for an operator's timetable link.
 *
 * The `url` argument is what keeps a PDF honest. Several operators publish the
 * timetable itself as a PDF rather than a page — Vy's Bergensbanen, SJ Nord's
 * Dovre and Nordland lines, Go-Ahead's Sørtoget — and an unlabelled link to one
 * starts a download instead of opening a page, which is a worse surprise on a
 * phone than anywhere else. The fact belongs to the URL and not to the operator,
 * which is why this reads the RESOLVED url rather than a per-operator flag: Vy's
 * route-tier link for 605 is a PDF while its operator-tier fallback
 * (vy.no/en/traffic/times) is an ordinary page, and one label on the operator
 * would have to be wrong about one of them.
 *
 * @param {string} agencyId
 * @param {string} [url] the resolved link, when the caller has it
 */
export function getScheduleLabel(agencyId, url) {
  const label = getOperatorBooking(agencyId)?.scheduleLabel || "Official timetable";
  if (!isPdfLink(url) || /\bpdf\b/i.test(label)) return label;
  return `${label} (PDF)`;
}

/** A link that downloads rather than opens: ".pdf", with or without a query. */
export function isPdfLink(url) {
  return /\.pdf(?:[?#]|$)/i.test(String(url ?? ""));
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
