/**
 * A train's clock, night by night.
 *
 * A timetable scrape reads one run of a train — today's — and every surface
 * used to print that run's times as the train's. Nightjet's do not hold still:
 * over the six weeks of fare calendar on 15 October 2026, NJ 403 Amsterdam →
 * Zürich left at six different times between 20:01 and 21:01 and arrived
 * between 07:41 and 08:05, and NJ 402's run on the scrape day (19:05) was the
 * exception — 31 of its 40 priced nights leave at 21:59. Engineering works do
 * that, night by night.
 *
 * The fare calendar already knows each night's own clock: Nightjet's price
 * search answers a night with that night's departure and arrival at the ends
 * it priced (`dep`/`arr`, Vienna wall-clock "YYYY-MM-DDTHH:MM", see
 * scripts/lib/nj-fares.mjs). This module is the one reading of them:
 *
 * - `nightTimesSummary` folds a calendar into the range the map panel prints
 *   ("20:01–21:01"), served beside the trains file instead of the calendar
 *   itself (operator-trains-handler.mjs).
 * - `nightClock` reads one night, for the connection page, where picking a
 *   night in the fare calendar retimes the stop list below it.
 * - `stopsForNight` is that retiming: the night's own clock at both ends, and
 *   the run's intermediate times only where the night runs to the same clock
 *   at both ends — a night leaving an hour later does not pass Basel at the
 *   time today's run did, and nothing here knows when it does.
 *
 * Only nights the calendar priced carry a clock (a `none` night's answer
 * named no journey to time), so a night without one keeps the run's times.
 *
 * Dependency-free `.mjs`, no Intl and no local clock: the connection page is
 * server-rendered and hydrated (see src/lib/fareCalendarView.mjs).
 */

const CLOCK_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

/** Less than this between the earliest and latest clock is not a range worth printing. */
export const VARIES_MINUTES = 5;

const pad = (n) => String(n).padStart(2, "0");

function dayOffset(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * Minutes after midnight of `nightIso` for a Vienna wall-clock date-time, so
 * clocks either side of midnight still sort the way they run. null for
 * anything that is not a well-formed clock within two days of the night.
 */
function minutesFromNight(nightIso, clock) {
  const m = CLOCK_RE.exec(String(clock ?? ""));
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return null;
  const days = dayOffset(nightIso, m[1]);
  if (days == null || days < 0 || days > 2) return null;
  return days * 1440 + h * 60 + min;
}

const hhmm = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/**
 * One night's own clock, or null: { departure: "21:54", arrival: "08:59",
 * arrivalDays: 1 } — `arrivalDays` is how many days after the night's date it
 * arrives. A night whose departure is not on its own date is refused: the
 * calendar keys a night by its departure date, so anything else is another
 * journey's clock.
 */
export function nightClock(nightIso, entry) {
  if (!entry || entry.none) return null;
  const dep = minutesFromNight(nightIso, entry.dep);
  const arr = minutesFromNight(nightIso, entry.arr);
  if (dep == null || arr == null || dep >= 1440 || arr <= dep) return null;
  return { departure: hhmm(dep), arrival: hhmm(arr), arrivalDays: Math.floor(arr / 1440) };
}

/**
 * Whether the calendar's clocks are clocks at the train's own two ends. The
 * price search names a car-train terminal by its neighbouring station (`Wien
 * Hbf (Autoreisezuganlage)` is priced as `Wien Hbf`, scripts/lib/nj-fares.mjs
 * pricingEnds), and a car train loads at one at a different time than it
 * calls at the other — so an end the train names with a qualifier the
 * priced journey dropped is not the end the clock is for.
 *
 * @param {{ from?: string, to?: string } | null | undefined} journey  calendar.journey
 * @param {string} origin       the train's first station as the page names it
 * @param {string} destination  its last
 */
export function journeyTimesTheEnds(journey, origin, destination) {
  if (!journey) return true;
  const qualified = (name) => /\([^)]*\)\s*$/.test(String(name ?? ""));
  const dropped = (own, priced) => qualified(own) && priced && !qualified(priced);
  return !dropped(origin, journey.from) && !dropped(destination, journey.to);
}

function spread(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  let usual = null;
  let top = 0;
  for (const [v, n] of counts) {
    if (n > top || (n === top && v < usual)) {
      usual = v;
      top = n;
    }
  }
  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];
  return {
    earliest: hhmm(earliest),
    latest: hhmm(latest),
    varies: latest - earliest >= VARIES_MINUTES,
    // "Usually" only where it is: most nights, not merely the most common
    // of six clocks (NJ 403's commonest departure covers 13 of 38 nights).
    usual: top * 2 > values.length ? hhmm(usual) : null,
  };
}

/**
 * The range of a train's clock over the nights its calendar priced:
 * { nights, firstNight, lastNight, varies, departure: { earliest, latest,
 * varies, usual }, arrival: { … } }, or null with fewer than two timed
 * nights. `varies` is either end's. Nights on or before `today` are left out
 * when it is given.
 *
 * @param {object} calendar  a train's fareCalendar (or a row's fare_calendar_{dir})
 * @param {{ today?: string }} [opts]
 */
export function nightTimesSummary(calendar, { today = null } = {}) {
  const nights = calendar?.nights;
  if (!nights || typeof nights !== "object") return null;
  const dates = Object.keys(nights)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!today || d > today))
    .sort();
  const deps = [];
  const arrs = [];
  const timed = [];
  for (const d of dates) {
    const entry = nights[d];
    if (!nightClock(d, entry)) continue;
    deps.push(minutesFromNight(d, entry.dep));
    // Arrival measured from its own night, so one arriving at 08:59 the next
    // morning and one at 08:59 two mornings later do not read as one clock.
    arrs.push(minutesFromNight(d, entry.arr));
    timed.push(d);
  }
  if (timed.length < 2) return null;
  const departure = spread(deps);
  const arrival = spread(arrs);
  return {
    nights: timed.length,
    firstNight: timed[0],
    lastNight: timed[timed.length - 1],
    varies: departure.varies || arrival.varies,
    departure,
    arrival,
  };
}

/** "20:01–21:01", or the one clock when it does not vary. */
export function formatClockRange(range) {
  if (!range) return "";
  return range.varies ? `${range.earliest}–${range.latest}` : range.earliest;
}

/**
 * A direction's stop list retimed for one night: the night's own clock at
 * both ends, and the run's intermediate times kept only where the night
 * leaves and arrives exactly when the run did. Returns
 * { stops, departure, arrival, sameAsRun } — `sameAsRun` false means the
 * intermediate times were cleared — or null when the night has no clock
 * (the page then keeps the run's times as they are).
 *
 * @param {{ name: string, departure: string, arrival: string }[]} stops
 * @param {{ departure: string, arrival: string } | null} clock  nightClock()
 */
export function stopsForNight(stops, clock) {
  if (!clock || !Array.isArray(stops) || stops.length < 2) return null;
  if (stops.some((s) => !s || typeof s !== "object")) return null;
  const last = stops.length - 1;
  const runDeparture = stops[0].departure || stops[0].arrival || "";
  const runArrival = stops[last].arrival || stops[last].departure || "";
  const sameAsRun = runDeparture === clock.departure && runArrival === clock.arrival;
  return {
    sameAsRun,
    departure: clock.departure,
    arrival: clock.arrival,
    stops: stops.map((s, i) => {
      if (i === 0) return { ...s, arrival: "", departure: clock.departure };
      if (i === last) return { ...s, arrival: clock.arrival, departure: "" };
      return sameAsRun ? s : { ...s, arrival: "", departure: "" };
    }),
  };
}
