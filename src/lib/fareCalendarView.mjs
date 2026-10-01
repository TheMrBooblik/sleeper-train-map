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
 *   checkedAt, bookingDate }.
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
 * @returns {{ currency: string, days: object[], cheapestDate: string|null,
 *   deals: object|null } | null}
 *   null when the calendar prices no night at all
 */
export function fareCalendarDays(
  calendar,
  { today, dynamic = true, bookingDate = () => null, compartmentSize = 5 } = {},
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
