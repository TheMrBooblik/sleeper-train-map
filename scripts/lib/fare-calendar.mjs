// scripts/lib/fare-calendar.mjs
// A night train's fare for every night of the next few weeks, built up a
// slice at a time.
//
// A yield-managed fare (lefrecce) is one date's price, so one sample per train
// answers "how much from" and nothing else. A traveller picking a night wants
// the price OF that night, which means one search per train per date — 25
// Intercity Notte trains over six weeks is ~1 050 searches, too many to fire at
// an operator's booking backend in one go. So each run spends a fixed budget on
// the nights that most need it (never checked, nearest first; then the
// stalest), and the calendar fills over a few nights and stays fresh after.
//
// Pure and dependency-free: the adapter does the searching, this decides what
// to search and what the result means. Exported for tests.

/** Nights ahead the calendar covers: six weeks, i.e. six rows of a month grid. */
export const FARE_CALENDAR_DAYS = 42;

/** Searches per run. ~1 s each with the adapter's spacing, so ~7 min a night. */
export const FARE_CALENDAR_BUDGET = 400;

/** A night's price older than this is dropped rather than shown. */
export const FARE_CALENDAR_MAX_AGE_DAYS = 14;

const DAY_MS = 86_400_000;

function isoMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function isoPlusDays(iso, days) {
  return new Date(isoMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The nights the calendar covers: tomorrow through `days` nights out. */
export function calendarWindow(today, days = FARE_CALENDAR_DAYS) {
  const out = [];
  for (let i = 1; i <= days; i++) out.push(isoPlusDays(today, i));
  return out;
}

/**
 * A calendar with the nights that no longer mean anything taken out: nights
 * already past (or beyond the window) and checks too old to stand behind.
 *
 * Shape: { currency, nights: { "2026-10-18": { classes: { couchette: 53.6 },
 * checkedAt: "2026-09-27" } | { none: true, checkedAt } } }. `none` is a night
 * the search answered without our train or without a berth on sale — the train
 * does not run, or its berths are gone; either way there is nothing to book.
 */
export function pruneCalendar(
  calendar,
  {
    today,
    days = FARE_CALENDAR_DAYS,
    maxAgeDays = FARE_CALENDAR_MAX_AGE_DAYS,
  } = {},
) {
  const window = new Set(calendarWindow(today, days));
  const todayMs = isoMs(today);
  const nights = {};
  for (const [date, entry] of Object.entries(calendar?.nights ?? {})) {
    if (!window.has(date) || !entry || typeof entry !== "object") continue;
    const checkedMs = isoMs(entry.checkedAt);
    if (
      !Number.isFinite(checkedMs) ||
      (todayMs - checkedMs) / DAY_MS > maxAgeDays
    )
      continue;
    nights[date] = entry;
  }
  return { currency: calendar?.currency ?? null, nights };
}

/**
 * What to search tonight, most useful first, at most `budget` searches:
 * nights never checked (nearest first, trains interleaved so every train gets
 * its next weeks before any train gets its far ones), then the stalest checks.
 * A night checked today is never searched again the same day.
 *
 * @param {Record<string, object>} calendars trainKey → pruned calendar
 * @returns {{ key: string, date: string }[]}
 */
export function planFareSearches(
  calendars,
  { today, days = FARE_CALENDAR_DAYS, budget = FARE_CALENDAR_BUDGET } = {},
) {
  const dates = calendarWindow(today, days);
  const candidates = [];
  for (const key of Object.keys(calendars ?? {}).sort()) {
    const nights = calendars[key]?.nights ?? {};
    dates.forEach((date, i) => {
      const checkedAt = nights[date]?.checkedAt ?? null;
      if (checkedAt === today) return;
      candidates.push({ key, date, i, checkedAt });
    });
  }
  candidates.sort((a, b) => {
    if (!a.checkedAt !== !b.checkedAt) return a.checkedAt ? 1 : -1;
    if (a.checkedAt && a.checkedAt !== b.checkedAt)
      return a.checkedAt < b.checkedAt ? -1 : 1;
    if (a.i !== b.i) return a.i - b.i;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return candidates
    .slice(0, Math.max(0, budget))
    .map(({ key, date }) => ({ key, date }));
}

/** The cheapest berth a night sells, as [seatClass, amount], or null. */
export function cheapestClass(classes) {
  let best = null;
  for (const [cls, amount] of Object.entries(classes ?? {})) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!best || amount < best[1]) best = [cls, amount];
  }
  return best;
}

/**
 * The train's headline fare: its cheapest night in the calendar, in the shape
 * every other surface already reads ({ fromPrice, currency, seatClass,
 * classes, sampledAt, travelDate }). A tie keeps the earlier night — the
 * nearer date is the more useful one to name. null when no night is priced.
 */
export function cheapestNight(calendar) {
  let best = null;
  for (const date of Object.keys(calendar?.nights ?? {}).sort()) {
    const entry = calendar.nights[date];
    const c = cheapestClass(entry?.classes);
    if (!c) continue;
    if (!best || c[1] < best.fromPrice) {
      best = {
        fromPrice: c[1],
        currency: calendar.currency,
        seatClass: c[0],
        classes: { ...entry.classes },
        sampledAt: entry.checkedAt,
        travelDate: date,
      };
    }
  }
  return best && best.currency ? best : null;
}
