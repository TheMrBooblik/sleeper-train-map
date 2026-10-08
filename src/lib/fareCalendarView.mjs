/**
 * A train's fare for each night, laid out for a month calendar.
 *
 * The data is a row's `fare_calendar_{dir}` (stamped by stampOfficialFares
 * from the source's own calendar, see scripts/lib/fare-calendar.mjs):
 * { currency, nights: { "2026-10-19": { classes: { couchette: 53.6, … },
 * checkedAt } | { none: true, checkedAt } } }.
 *
 * Dependency-free `.mjs`, and every date is handled as a "YYYY-MM-DD" string
 * with UTC arithmetic and fixed name tables — no Intl, no local clock. The
 * connection pages are server-rendered and hydrated, and a calendar whose
 * weekday or month name differs between Node's ICU and the browser's is a
 * whole-page hydration failure (the planner met exactly that, see
 * src/lib/plan/format.mjs).
 */
import { fareClassRows, formatMoney } from "./fareClasses.mjs";
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
 * { date, state: "priced" | "none" | "unknown", amount, price, tier, classes,
 *   checkedAt, bookingDate, bookingArrivalDate }.
 * `unknown` is a night not searched yet; `none` one whose search found no
 * berth on sale. `tier` bands priced nights low / mid / high by where they
 * sit in this train's own price range, so a cheap night stands out without
 * pretending to know what "cheap" means across trains.
 *
 * @param {object} calendar  row.fare_calendar_{dir}
 * @param {object} opts
 * @param {string} opts.today            "YYYY-MM-DD" — nights on or before it are left out
 * @param {boolean} [opts.dynamic=true]  prefix class prices with "from"
 * @param {(iso: string) => string|null} [opts.bookingDate] the date as the
 *   operator's booking link wants it, or null when the link takes none
 * @param {(iso: string) => string|null} [opts.bookingArrivalDate] the morning
 *   that night's train arrives, for a link that names the whole journey
 *   (ÖBB's), or null
 * @returns {{ currency: string, days: object[], cheapestDate: string|null,
 *   deals: object|null } | null}
 *   null when the calendar prices no night at all
 */
export function fareCalendarDays(
  calendar,
  {
    today,
    dynamic = true,
    bookingDate = () => null,
    bookingArrivalDate = () => null,
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
    const classes =
      entry && !entry.none
        ? fareClassRows({ classes: entry.classes, currency }, { from: dynamic })
        : [];
    const amount = classes.length ? classes[0].amount : null;
    days.push({
      date: d,
      state: amount != null ? "priced" : entry ? "none" : "unknown",
      amount,
      price: amount != null ? formatMoney(amount, currency) : "",
      // What fits in a month-grid cell on a 320 px phone (~35 px): whole
      // units, no symbol. "119.99" ran into the next cell; the exact price
      // is on the selected night's card below the grid.
      cellPrice: amount != null ? String(Math.round(amount)) : "",
      tier: null,
      // A deal's figure is the promo price itself, never "from".
      classes: classes.map(({ key, label, price, amount: a }) => ({
        key,
        label,
        price: isDealClass(key) ? formatMoney(a, currency) : price,
        ...(isDealClass(key) ? { deal: true } : {}),
      })),
      // The night's last-minute deal against its regular fares (src/lib/lastMinuteDeals.mjs).
      deal: entry && !entry.none ? nightDeal(entry, { currency, compartmentSize }) : null,
      checkedAt: entry?.checkedAt ?? null,
      bookingDate: bookingDate(d) ?? null,
      bookingArrivalDate: bookingArrivalDate(d) ?? null,
    });
  }

  const priced = days.filter((d) => d.state === "priced");
  if (!priced.length) return null;
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
  return { currency, days, cheapestDate, deals: dealsSummary(days) };
}

/**
 * The days grouped into month grids, Monday first:
 * [{ key: "2026-10", title: "October 2026", weeks: [[day|null ×7], …] }].
 * Cells outside the list are null (padding before the first night of the
 * month and after its last).
 */
/**
 * The Book link for one night: the calendar's dated template with that night
 * filled in, or null when either is missing (the page then links to the
 * route's own booking page and says to pick the night there). A template
 * that names the arrival ({arrivalDate}) needs that night's arrival date too —
 * without it the link would book a journey ending before it starts.
 */
export function datedBookingHref(template, night) {
  if (!template || !night?.bookingDate) return null;
  if (template.includes("{arrivalDate}") && !night.bookingArrivalDate) return null;
  return template
    .replaceAll("{date}", night.bookingDate)
    .replaceAll("{arrivalDate}", night.bookingArrivalDate ?? "");
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
