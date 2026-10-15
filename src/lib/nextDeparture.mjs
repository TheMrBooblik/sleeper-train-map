/**
 * A train that is on sale but not running now: when it next leaves, and what
 * its last season was.
 *
 * nightjet.com answers "this train, today" with the train's NEXT journey, so a
 * seasonal EuroNight asked about in October comes back dated next June. That
 * date is the one fact a traveller needs first and the row used to drop it:
 * EN 1276/1277 Rijeka–Warszawa, whose 2026 season ended on 28/30 August, was
 * drawn as a running train with no dates at all, and its connection page and
 * Google snippet read like any other corridor. The build stamps it on the row
 * instead (`next_departure_{dir}`, only when it is more than
 * UPCOMING_AFTER_DAYS after the night the operator was asked, so a running
 * train's row never changes nightly), together with the Back-on-Track season
 * of the row the synthetic route replaced (`previous_service_{dir}`), and every
 * surface reads it through this module: the map draws the line as a future
 * one, the panel and the connection page say "next season from …", and the
 * snippet leads with it.
 *
 * Dependency-free `.mjs` for the same reason as `slugify.mjs`: the build, the
 * map and raw-node tests must reach the same answer. Dates are formatted from
 * fixed tables, never `Intl`, because the connection page is server-rendered
 * and hydrated (CLAUDE.md: one comma from ICU was a whole-page hydration
 * failure). `localDateIn` is the one exception, and it only runs in the build.
 */

/**
 * How far off a train's next run must be before it counts as not running.
 * Two weeks clears any weekly train's gap between runs; the same threshold
 * the snippet already applies to an upcoming timetable (snippet.mjs).
 */
export const UPCOMING_AFTER_DAYS = 14;

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(iso) {
  const m = ISO_DATE_RE.exec(String(iso || ""));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

const dayNumber = (iso) => {
  const p = parseIso(iso);
  return p ? Date.UTC(p.y, p.m - 1, p.d) / 86_400_000 : null;
};

/** Whole days from `from` to `to`, both "YYYY-MM-DD"; null when unreadable. */
export function daysBetween(from, to) {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a == null || b == null ? null : b - a;
}

/** The local calendar date of `now`, "YYYY-MM-DD" (the browser's own day). */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The calendar date an instant falls on in `timeZone`, "YYYY-MM-DD", or null.
 * Build-time only (Intl). An ISO date-time is required, as in nj-fares.mjs:
 * Date.parse would read "08.10.2026" as 10 August.
 */
export function localDateIn(value, timeZone = "Europe/Vienna") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * A train's next departure date when it lies more than UPCOMING_AFTER_DAYS
 * after the night the operator was asked (`lastSeenAt`), else null. Build-time.
 * @param {{stations?: object[], lastSeenAt?: string}} train
 * @param {{timeZone?: string, askedOn?: string}} [options]
 */
export function upcomingDepartureForTrain(train, { timeZone = "Europe/Vienna", askedOn = null } = {}) {
  const first = train?.stations?.[0];
  const departs = localDateIn(first?.departure ?? first?.arrival ?? null, timeZone);
  const asked = askedOn ?? localDateIn(train?.lastSeenAt ?? null, timeZone);
  if (!departs || !asked) return null;
  const gap = daysBetween(asked, departs);
  return gap != null && gap > UPCOMING_AFTER_DAYS ? departs : null;
}

/** "25 Jun 2027" */
export function formatShortDate(iso) {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTHS_SHORT[p.m - 1]} ${p.y}` : "";
}

/** "25 June 2027" */
export function formatLongDate(iso) {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTHS_LONG[p.m - 1]} ${p.y}` : "";
}

/** "Fri 25 Jun 2027" — the weekday from UTC arithmetic, so no time zone moves it. */
export function formatDayDate(iso) {
  const p = parseIso(iso);
  if (!p) return "";
  const weekday = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${weekday} ${formatShortDate(iso)}`;
}

/** Directions a row actually states a train for. */
function rowDirections(route) {
  return [0, 1].filter((dir) => String(route?.[`trip_short_name_${dir}`] ?? "").trim());
}

/**
 * The row's next departure ("YYYY-MM-DD") when EVERY direction it states runs
 * next after `today`, else null. One direction running now means the route is
 * running: a route whose return leg is still on sale this week is not a
 * future route.
 * @param {object} route viewMap row
 * @param {string} [today] "YYYY-MM-DD", defaults to the local day
 */
export function rowNextDeparture(route, today = localToday()) {
  const dirs = rowDirections(route);
  if (!dirs.length) return null;
  let earliest = null;
  for (const dir of dirs) {
    const date = route[`next_departure_${dir}`];
    if (!parseIso(date)) return null;
    if (daysBetween(today, date) <= 0) return null;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest;
}

// Back-on-Track's window, both spellings: "2026/06/26-08/28: Daily, except
// Sunday" and "2026/06/26-2026/08/28: …". The short one's end year is its
// start year (routeStyleUtils.js reads it the same way).
const SEASON_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s*(?::\s*(.*))?$/;

function parseSeason(text) {
  const m = SEASON_RE.exec(String(text || "").trim());
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return {
    start: `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
    end: `${m[4] ?? m[1]}-${pad(m[5])}-${pad(m[6])}`,
    days: (m[7] || "").trim(),
  };
}

/**
 * The season the row last ran, from the Back-on-Track row it replaced:
 * `{ start, end, days }` spanning both directions, or null.
 */
export function previousSeason(route) {
  const seasons = rowDirections(route)
    .map((dir) => parseSeason(route?.[`previous_service_${dir}`]))
    .filter(Boolean);
  if (!seasons.length) return null;
  const start = seasons.map((s) => s.start).sort()[0];
  const end = seasons.map((s) => s.end).sort().at(-1);
  const days = seasons[0].days && seasons.every((s) => s.days === seasons[0].days) ? seasons[0].days : "";
  return { start, end, days };
}

/**
 * "summer" when a season starts and ends between May and September, "winter"
 * between November and April, else "" — a word only when the dates say it.
 */
export function seasonWord(season) {
  if (!season) return "";
  const sm = parseIso(season.start)?.m;
  const em = parseIso(season.end)?.m;
  if (!sm || !em) return "";
  const summer = (m) => m >= 5 && m <= 9;
  const winter = (m) => m >= 11 || m <= 4;
  if (summer(sm) && summer(em) && sm <= em) return "summer";
  if (winter(sm) && winter(em)) return "winter";
  return "";
}

/** "26 Jun – 28 Aug 2026" (the year once when both ends share it). */
export function formatSeasonRange(season) {
  if (!season) return "";
  const a = parseIso(season.start);
  const b = parseIso(season.end);
  if (!a || !b) return "";
  const head = a.y === b.y ? `${a.d} ${MONTHS_SHORT[a.m - 1]}` : formatShortDate(season.start);
  return `${head} – ${formatShortDate(season.end)}`;
}

/**
 * Everything a surface needs to say "not running now, next season from …",
 * or null when the row is running.
 *
 * @param {object} route viewMap row
 * @param {string} [today] "YYYY-MM-DD"
 * @returns {null | {
 *   nextDeparture: string, nextDepartureText: string,
 *   departures: {dir: number, train: string, origin: string, destination: string, date: string, dateText: string}[],
 *   previous: {start: string, end: string, days: string} | null, previousText: string,
 *   season: string, seasonal: boolean, badge: string, headline: string, sentence: string,
 * }}
 */
export function upcomingRun(route, today = localToday()) {
  const nextDeparture = rowNextDeparture(route, today);
  if (!nextDeparture) return null;
  const departures = rowDirections(route)
    .map((dir) => ({
      dir,
      train: String(route[`trip_short_name_${dir}`] || "").trim(),
      origin: route[`origin_trip_${dir}`] || "",
      destination: route[`destination_trip_${dir}`] || "",
      date: route[`next_departure_${dir}`],
      dateText: formatDayDate(route[`next_departure_${dir}`]),
    }))
    .sort((x, y) => x.date.localeCompare(y.date) || x.dir - y.dir);
  const previous = previousSeason(route);
  // A season that ended before the next run starts is evidence the train is
  // seasonal; without one we only know it is not running now.
  const seasonal = Boolean(previous && previous.end < nextDeparture);
  const season = seasonal ? seasonWord(previous) : "";
  const nextDepartureText = formatShortDate(nextDeparture);
  const previousText = seasonal ? formatSeasonRange(previous) : "";
  const badge = season
    ? `${season[0].toUpperCase()}${season.slice(1)} only`
    : seasonal
      ? "Seasonal"
      : "Not running now";
  const headline = seasonal
    ? `${season ? `${season[0].toUpperCase()}${season.slice(1)} seasonal train` : "Seasonal train"} — next season from ${nextDepartureText}`
    : `Not running now — next departure ${nextDepartureText}`;
  const sentence = seasonal
    ? `This is a seasonal ${season ? `${season} ` : ""}train and is not running now. ` +
      `The next season starts on ${formatLongDate(nextDeparture)}` +
      (previousText ? `; the last one ran ${previousText}.` : ".")
    : `This train is not running now. Its next departure is on ${formatLongDate(nextDeparture)}.`;
  return {
    nextDeparture,
    nextDepartureText,
    departures,
    previous: seasonal ? previous : null,
    previousText,
    season,
    seasonal,
    badge,
    headline,
    sentence,
  };
}
