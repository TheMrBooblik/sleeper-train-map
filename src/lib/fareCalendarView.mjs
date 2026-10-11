/**
 * A train's fare for each night, laid out for a month calendar.
 *
 * The data is a row's `fare_calendar_{dir}` (stamped by stampOfficialFares
 * from the source's own calendar, see scripts/lib/fare-calendar.mjs):
 * { currency, nights: { "2026-10-19": { classes: { couchette: 53.6, … },
 * checkedAt, offers?: { couchette: "Sparschiene" }, seat? } |
 * { none: true, checkedAt, reason?: "noBerth" | "noJourney", seat? } } }.
 * A night's `seat` (Nightjet's cheapest seated-coach price) is kept by the
 * scrape for verification only and is never read here: this map prices
 * sleeping places, and a seat figure on a sleeper calendar is the wrong number.
 *
 * Dependency-free `.mjs`, and every date is handled as a "YYYY-MM-DD" string
 * with UTC arithmetic and fixed name tables — no Intl, no local clock. The
 * connection pages are server-rendered and hydrated, and a calendar whose
 * weekday or month name differs between Node's ICU and the browser's is a
 * whole-page hydration failure (the planner met exactly that, see
 * src/lib/plan/format.mjs).
 */
import { fareClassRows, formatMoney, isCouchetteClass } from "./fareClasses.mjs";
import { dealsSummary, isDealClass, nightDeal } from "./lastMinuteDeals.mjs";

const DAY_MS = 86_400_000;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const isoMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isIso = (iso) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? "")) && Number.isFinite(isoMs(iso));

export function isoPlusDays(iso, days) {
  return new Date(isoMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(iso) {
  return (new Date(isoMs(iso)).getUTCDay() + 6) % 7;
}

/** "Sun 19 Oct" */
export function formatNight(iso) {
  if (!isIso(iso)) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${WEEKDAYS[weekdayIndex(iso)]} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

/**
 * The calendar's nights as a flat list from the day after `today` through the
 * last night the calendar holds, each one
 * { date, state: "priced" | "none" | "unknown", amount, price, cellPrice,
 *   cellClass?, otherBerth?, reason?, tier, classes, deal, checkedAt,
 *   bookingDate, bookingDeparture, bookingArrival }.
 * `unknown` is a night not searched yet; `none` one whose search found no
 * berth on sale, with `reason` saying why where the source recorded it:
 * "noJourney" (no train that night) or "noBerth" (it ran, selling no
 * couchette or sleeper). The key is absent otherwise.
 *
 * A priced night's cell is its cheapest couchette place, deal couchettes
 * included; a night selling none prints its cheapest other berth instead and
 * carries `otherBerth: true`, so the grid can mark it — on a calendar where
 * some night sells a couchette. Where none does (EN 40458/40459 sell sleeping
 * cars only), every cell is a berth by the heading's own word and no night is
 * marked: a mark on every cell says nothing. `cellClass` names the
 * class the cell prints either way (its label is in `classes`). The grid used
 * to print the cheapest class whatever it was: on the calendars of 10 October
 * 2026 that put an unmarked sleeper price on 159 of 1 457 Nightjet nights (142
 * selling no couchette, 17 where the sleeper was the cheaper). `amount` is the
 * cell's figure, and everything that compares nights — `tier`,
 * `cheapestDate` — reads it, so the night the calendar opens on and the
 * colours it uses agree with the numbers it prints. `tier` bands priced
 * nights low / mid / high by where they sit in this train's own range, so a
 * cheap night stands out without pretending to know what "cheap" means
 * across trains.
 *
 * The optional keys are left out rather than written as null or false: every
 * night here is serialised into a connection page's static props, and the
 * largest of those (Berlin–Paris, 182 nights) was already past Next's 128 kB
 * page-data warning before they existed.
 *
 * @param {object} calendar  row.fare_calendar_{dir}
 * @param {object} opts
 * @param {string} opts.today            "YYYY-MM-DD" — nights on or before it are left out
 * @param {boolean} [opts.dynamic=true]  prefix class prices with "from"
 * @param {(iso: string) => string|null} [opts.bookingDate] the date as the
 *   operator's booking link wants it, or null when the link takes none
 * @param {(iso: string) => {departure: string, arrival: string}|null} [opts.bookingTimes]
 *   that night's own departure and arrival, for a link that names the whole
 *   journey (ÖBB's), or null
 * @returns {{ currency: string, days: object[], cheapestDate: string|null,
 *   deals: object|null, cellBasis: "couchette" | "berth",
 *   otherBerthNights: number, noTrainNights: number } | null}
 *   null when the calendar prices no night at all. `cellBasis` says what the
 *   cells are, for the grid's heading: "couchette" when any night sells one,
 *   else "berth" (a sleeper-only train). The two counts say which marks the
 *   legend has to explain.
 */
export function fareCalendarDays(
  calendar,
  {
    today,
    dynamic = true,
    bookingDate = () => null,
    bookingTimes = () => null,
    compartmentSize = 5,
  } = {},
) {
  const nights = calendar?.nights;
  const currency = calendar?.currency;
  if (!nights || typeof nights !== "object" || !currency || !isIso(today))
    return null;
  const dates = Object.keys(nights)
    .filter((d) => isIso(d) && d > today)
    .sort();
  if (!dates.length) return null;

  const days = [];
  for (
    let d = isoPlusDays(today, 1);
    d <= dates[dates.length - 1];
    d = isoPlusDays(d, 1)
  ) {
    const entry = nights[d];
    // `entry.classes` only: a night's `seat` sits beside it and is never a
    // class (fareClassRows also skips any class without a label, "seat" too).
    const classes =
      entry && !entry.none
        ? fareClassRows({ classes: entry.classes, currency }, { from: dynamic })
        : [];
    // Cheapest first, so the first couchette is the cheapest couchette.
    const cell = classes.find((c) => isCouchetteClass(c.key)) ?? classes[0] ?? null;
    const amount = cell ? cell.amount : null;
    const reason = entry?.none ? noneReason(entry) : null;
    days.push({
      date: d,
      state: amount != null ? "priced" : entry ? "none" : "unknown",
      amount,
      price: amount != null ? formatMoney(amount, currency) : "",
      // What fits in a month-grid cell on a 320 px phone (~35 px): whole
      // units, no symbol. "119.99" ran into the next cell; the exact price
      // is on the selected night's card below the grid.
      cellPrice: amount != null ? String(Math.round(amount)) : "",
      ...(cell ? { cellClass: cell.key } : {}),
      ...(cell && !isCouchetteClass(cell.key) ? { otherBerth: true } : {}),
      ...(reason ? { reason } : {}),
      tier: null,
      // A deal's figure is the promo price itself, never "from". `offer` is
      // the operator's own product for that figure (ÖBB's "Sparschiene"), so
      // a reader can find the same fare in the operator's shop.
      classes: classes.map(({ key, label, price, amount: a }) => {
        const offer = offerName(entry, key);
        return {
          key,
          label,
          price: isDealClass(key) ? formatMoney(a, currency) : price,
          ...(isDealClass(key) ? { deal: true } : {}),
          ...(offer ? { offer } : {}),
        };
      }),
      // The night's last-minute deal against its regular fares (src/lib/lastMinuteDeals.mjs).
      deal: entry && !entry.none ? nightDeal(entry, { currency, compartmentSize }) : null,
      checkedAt: entry?.checkedAt ?? null,
      bookingDate: bookingDate(d) ?? null,
      ...nightBookingTimes(bookingTimes(d)),
    });
  }

  const priced = days.filter((d) => d.state === "priced");
  if (!priced.length) return null;
  const sellsCouchette = priced.some((d) => !d.otherBerth);
  if (!sellsCouchette) for (const d of priced) delete d.otherBerth;
  const min = Math.min(...priced.map((d) => d.amount));
  const max = Math.max(...priced.map((d) => d.amount));
  const band = (max - min) / 3;
  for (const d of priced) {
    // No real spread (every night within a euro): nothing stands out.
    if (max - min < 1) d.tier = "mid";
    else
      d.tier =
        d.amount <= min + band
          ? "low"
          : d.amount >= max - band
            ? "high"
            : "mid";
  }
  // The earliest of the cheapest nights: the nearer date is the more useful to offer.
  const cheapestDate = priced.find((d) => d.amount === min).date;
  return {
    currency,
    days,
    cheapestDate,
    deals: dealsSummary(days),
    cellBasis: sellsCouchette ? "couchette" : "berth",
    otherBerthNights: priced.filter((d) => d.otherBerth).length,
    noTrainNights: days.filter((d) => d.reason === "noJourney").length,
  };
}

/**
 * Why a night has no fare, where the source recorded it (Nightjet does, see
 * scripts/lib/nj-fares.mjs): "noJourney" when the search proved no train ran
 * that night, "noBerth" when one ran selling no couchette or sleeper. null
 * for anything else, an entry written before the field existed included —
 * that night is read as it always was, "no berth on sale". (Nightjet's
 * `noBerth` also covers berths gone: the endpoint does not tell sold out from
 * never sold.)
 */
function noneReason(entry) {
  return entry?.reason === "noJourney" || entry?.reason === "noBerth" ? entry.reason : null;
}

/**
 * The operator's product name for one class's figure that night, or null.
 * Short display text only: anything that is not a plain, reasonably short
 * string is left out rather than printed.
 */
function offerName(entry, key) {
  const name = entry?.offers?.[key];
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed && trimmed.length <= 60 ? trimmed : null;
}

/**
 * The days grouped into month grids, Monday first:
 * [{ key: "2026-10", title: "October 2026", weeks: [[day|null ×7], …] }].
 * Cells outside the list are null (padding before the first night of the
 * month and after its last).
 */
function nightBookingTimes(times) {
  return {
    bookingDeparture: times?.departure ?? null,
    bookingArrival: times?.arrival ?? null,
  };
}

/**
 * The Book link for one night: the calendar's dated template with that night
 * filled in, or null when anything it names is missing (the page then links to
 * the direction's own booking search and says to pick the night there). A
 * template naming a connection ({departure}, {arrival}) needs that night's own
 * clocks — another night's would open a train that does not run then.
 */
export function datedBookingHref(template, night) {
  if (!template || !night?.bookingDate) return null;
  const connection = template.includes("{departure}") || template.includes("{arrival}");
  if (connection && !(night.bookingDeparture && night.bookingArrival)) return null;
  return template
    .replaceAll("{date}", night.bookingDate)
    .replaceAll("{departure}", night.bookingDeparture ?? "")
    .replaceAll("{arrival}", night.bookingArrival ?? "");
}

export function calendarMonths(days) {
  const months = [];
  let current = null;
  for (const day of days ?? []) {
    const key = day.date.slice(0, 7);
    if (!current || current.key !== key) {
      const [y, m] = key.split("-").map(Number);
      current = { key, title: `${MONTHS[m - 1]} ${y}`, weeks: [] };
      months.push(current);
    }
    let week = current.weeks[current.weeks.length - 1];
    const col = weekdayIndex(day.date);
    if (!week || col === 0) {
      week = Array(7).fill(null);
      current.weeks.push(week);
    }
    week[col] = day;
  }
  return months;
}

/**
 * How many month grids the calendar shows side by side from `sm` up (a phone
 * shows one). European Sleeper's runs 92 nights, so four months stacked made
 * the page mostly calendar; the rest are a scroll to the right away.
 */
export const VISIBLE_MONTHS = 2;

/**
 * The first month to show so that `date` is on screen, moving as little as
 * possible from `current`: a night already in view keeps the view, a later
 * one brings its month in on the right, an earlier one on the left. Clamped
 * so the view is always full where there are enough months.
 *
 * Starting from 0 this is also where the calendar opens: the months nearest
 * today, unless the night selected for it (the cheapest) lies further out.
 * `size` is how many months fit, which only the browser can measure.
 *
 * @param {{ key: string }[]} months  calendarMonths() output
 * @param {string|null} date          "YYYY-MM-DD"
 * @param {number} [current=0]
 * @param {number} [size=VISIBLE_MONTHS]
 */
export function monthWindowStart(months, date, current = 0, size = VISIBLE_MONTHS) {
  const last = Math.max(0, (months?.length ?? 0) - size);
  const clamp = (i) => Math.min(Math.max(i, 0), last);
  const at = (months ?? []).findIndex((m) => m.key === String(date ?? "").slice(0, 7));
  if (at < 0) return clamp(current);
  if (at < current) return clamp(at);
  if (at >= current + size) return clamp(at - size + 1);
  return clamp(current);
}
