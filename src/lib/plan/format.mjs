/**
 * Date display for the planner — deliberately without Intl.
 *
 * `toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month:
 * "short" })` returns "Fri 18 Sept" under Node's ICU and "Fri, 18 Sept" under
 * Chromium's. The server renders one and the browser hydrates the other, so
 * React throws the tree away and re-renders it — a whole-page hydration failure
 * caused by one comma, invisible in dev and only in production SSR.
 *
 * A date on this page is a calendar date, not an instant, so there is nothing
 * Intl was buying: the strings are fixed here and both runtimes agree.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-18" → "Fri 18 Sep". Empty string for anything unparseable. */
export function formatPlanDate(iso) {
  if (!DATE_RE.test(String(iso || ""))) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(probe.getTime())) return "";
  // getUTCDay() is Sunday-first; WEEKDAYS is Monday-first.
  return `${WEEKDAYS[(probe.getUTCDay() + 6) % 7]} ${d} ${MONTHS[m - 1]}`;
}

/** "2026-09-18" → "Friday 18 September 2026", for a title or a tooltip. */
export function formatPlanDateLong(iso) {
  if (!DATE_RE.test(String(iso || ""))) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(probe.getTime())) return "";
  const LONG_DAYS = {
    Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
    Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
  };
  const LONG_MONTHS = {
    Jan: "January", Feb: "February", Mar: "March", Apr: "April",
    May: "May", Jun: "June", Jul: "July", Aug: "August",
    Sep: "September", Oct: "October", Nov: "November", Dec: "December",
  };
  const short = WEEKDAYS[(probe.getUTCDay() + 6) % 7];
  return `${LONG_DAYS[short]} ${d} ${LONG_MONTHS[MONTHS[m - 1]]} ${y}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-11" → "November" (or "Nov" short), with the year where it is not the
 * year of `today` — a month chip in October reads "Jan 2027".
 */
export function formatPlanMonth(month, { short = false, today = "" } = {}) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) return "";
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return "";
  const name = short ? MONTHS[m - 1] : MONTH_NAMES[m - 1];
  const thisYear = Number(String(today).slice(0, 4));
  return thisYear && thisYear === y ? name : `${name} ${y}`;
}
